#!/usr/bin/env python3
"""Local categorized Markdown vault powered by Microsoft MarkItDown."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import os
import re
import shutil
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterable
from urllib.parse import urlparse


APP_VERSION = "1.2.0"
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
CLAUDE_BASE_URL = "https://api.anthropic.com/v1/"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
DEFAULT_CLAUDE_MODEL = "claude-sonnet-5"
INVALID_PATH_CHARS = re.compile(r'[<>:"\\|?*\x00-\x1f]')
WORD_RE = re.compile(r"\w+", re.UNICODE)
AUDIO_EXTENSIONS = {".wav", ".mp3", ".m4a", ".mp4", ".aiff", ".aif", ".flac"}

FORMAT_GROUPS = {
    "Office": "PPTX, DOCX, XLSX, XLS, Outlook MSG",
    "Documents": "PDF, HTML/HTM, EPUB, RTF, plain text, Markdown, Jupyter notebooks",
    "Structured/web": "CSV, JSON, XML, RSS/Atom, Wikipedia and Bing result pages",
    "Images": "common image formats; EXIF/OCR; optional LLM descriptions",
    "Audio": "WAV and MP3 metadata/transcription",
    "Archives": "ZIP (iterates through contents)",
    "Remote": "YouTube URLs/transcripts (explicit remote access required)",
    "Azure Content Understanding": "documents, images, audio, and video supported by Azure CU",
}


class UserError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def default_vault_path() -> Path:
    configured = os.getenv("MARKITDOWN_VAULT")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / "MarkItDownVault"


def clean_segment(value: str) -> str:
    value = INVALID_PATH_CHARS.sub("_", value.strip()).rstrip(". ")
    if not value or value in {".", ".."}:
        raise UserError("Category contains an empty or unsafe path segment.")
    if value.upper() in {
        "CON", "PRN", "AUX", "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }:
        value = "_" + value
    return value


def normalize_category(value: str | None) -> str:
    raw = (value or "inbox").replace("\\", "/").strip("/")
    parts = [clean_segment(part) for part in raw.split("/") if part.strip()]
    if not parts:
        return "inbox"
    return "/".join(parts)


def slugify(value: str, fallback: str = "document") -> str:
    value = INVALID_PATH_CHARS.sub(" ", value)
    value = re.sub(r"[^\w\- ]+", "", value, flags=re.UNICODE)
    value = re.sub(r"[\s_]+", "-", value).strip("- .").lower()
    return (value or fallback)[:90]


def is_url(value: str) -> bool:
    return urlparse(value).scheme.lower() in {"http", "https"}


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def yaml_scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(str(value), ensure_ascii=False)


def build_document(metadata: dict[str, Any], body: str) -> str:
    fields = [
        "id", "title", "category", "source", "source_type", "source_sha256",
        "converted_at", "converter", "engine", "llm_provider", "llm_model",
        "source_copy",
    ]
    header = ["---"]
    header.extend(f"{key}: {yaml_scalar(metadata.get(key))}" for key in fields)
    header.extend(["---", "", body.rstrip(), ""])
    return "\n".join(header)


def parse_document(text: str) -> tuple[dict[str, Any], str]:
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    try:
        end = lines.index("---", 1)
    except ValueError:
        return {}, text
    metadata: dict[str, Any] = {}
    for line in lines[1:end]:
        if ":" not in line:
            continue
        key, raw = line.split(":", 1)
        raw = raw.strip()
        try:
            metadata[key.strip()] = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            metadata[key.strip()] = raw
    return metadata, "\n".join(lines[end + 1 :]).lstrip()


class Vault:
    def __init__(self, root: Path):
        self.root = root.expanduser().resolve()
        self.category_root = self.root / "categories"
        self.source_root = self.root / "sources"
        self.state_root = self.root / ".mdvault"
        self.db_path = self.state_root / "index.sqlite3"

    def initialize(self) -> None:
        self.category_root.mkdir(parents=True, exist_ok=True)
        self.source_root.mkdir(parents=True, exist_ok=True)
        self.state_root.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    category TEXT NOT NULL,
                    md_path TEXT NOT NULL UNIQUE,
                    source TEXT NOT NULL,
                    source_type TEXT,
                    source_hash TEXT,
                    provider TEXT NOT NULL,
                    model TEXT,
                    engine TEXT NOT NULL,
                    source_copy TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    word_count INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_documents_category
                    ON documents(category);
                CREATE INDEX IF NOT EXISTS idx_documents_dedupe
                    ON documents(source_hash, category, provider, model, engine);
                """
            )
            try:
                db.execute(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS document_search "
                    "USING fts5(doc_id UNINDEXED, title, category, body)"
                )
            except sqlite3.OperationalError:
                db.execute(
                    "CREATE TABLE IF NOT EXISTS document_search "
                    "(doc_id TEXT PRIMARY KEY, title TEXT, category TEXT, body TEXT)"
                )

    def connect(self) -> sqlite3.Connection:
        self.state_root.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.db_path)
        db.row_factory = sqlite3.Row
        return db

    def category_path(self, category: str) -> Path:
        category = normalize_category(category)
        candidate = (self.category_root / Path(*category.split("/"))).resolve()
        if not candidate.is_relative_to(self.category_root.resolve()):
            raise UserError("Category escapes the vault.")
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate

    def find_duplicate(
        self, source_hash: str, category: str, provider: str, model: str | None, engine: str
    ) -> sqlite3.Row | None:
        with self.connect() as db:
            return db.execute(
                """
                SELECT * FROM documents
                WHERE source_hash = ? AND category = ? AND provider = ?
                  AND model IS ? AND engine = ?
                ORDER BY created_at DESC LIMIT 1
                """,
                (source_hash, category, provider, model, engine),
            ).fetchone()

    def upsert(self, metadata: dict[str, Any], body: str, md_path: Path) -> None:
        stat = md_path.stat()
        words = len(WORD_RE.findall(body))
        now = utc_now()
        values = (
            metadata["id"], metadata["title"], metadata["category"], str(md_path),
            metadata["source"], metadata.get("source_type"), metadata.get("source_sha256"),
            metadata.get("llm_provider", "none"), metadata.get("llm_model"),
            metadata.get("engine", "builtin"), metadata.get("source_copy"),
            metadata.get("converted_at", now), now, stat.st_size, words,
        )
        with self.connect() as db:
            db.execute(
                """
                INSERT INTO documents (
                    id, title, category, md_path, source, source_type, source_hash,
                    provider, model, engine, source_copy, created_at, updated_at,
                    size_bytes, word_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title, category=excluded.category,
                    md_path=excluded.md_path, source=excluded.source,
                    source_type=excluded.source_type, source_hash=excluded.source_hash,
                    provider=excluded.provider, model=excluded.model,
                    engine=excluded.engine, source_copy=excluded.source_copy,
                    updated_at=excluded.updated_at, size_bytes=excluded.size_bytes,
                    word_count=excluded.word_count
                """,
                values,
            )
            db.execute("DELETE FROM document_search WHERE doc_id = ?", (metadata["id"],))
            db.execute(
                "INSERT INTO document_search(doc_id, title, category, body) VALUES (?, ?, ?, ?)",
                (metadata["id"], metadata["title"], metadata["category"], body),
            )

    def rows(self, category: str | None, limit: int) -> list[sqlite3.Row]:
        with self.connect() as db:
            if category:
                return db.execute(
                    "SELECT * FROM documents WHERE category = ? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (normalize_category(category), limit),
                ).fetchall()
            return db.execute(
                "SELECT * FROM documents ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()

    def search(self, query: str, category: str | None, limit: int) -> list[dict[str, Any]]:
        with self.connect() as db:
            schema = db.execute(
                "SELECT sql FROM sqlite_master WHERE name='document_search'"
            ).fetchone()
            is_fts = bool(schema and "VIRTUAL TABLE" in (schema[0] or "").upper())
            if is_fts:
                tokens = WORD_RE.findall(query)
                if not tokens:
                    return []
                expression = " AND ".join('"' + t.replace('"', '""') + '"' for t in tokens)
                sql = (
                    "SELECT d.*, snippet(document_search, 3, '[', ']', ' … ', 24) AS snippet "
                    "FROM document_search JOIN documents d ON d.id = document_search.doc_id "
                    "WHERE document_search MATCH ?"
                )
                params: list[Any] = [expression]
            else:
                sql = (
                    "SELECT d.*, substr(s.body, 1, 280) AS snippet "
                    "FROM document_search s JOIN documents d ON d.id = s.doc_id "
                    "WHERE (s.title LIKE ? OR s.category LIKE ? OR s.body LIKE ?)"
                )
                pattern = f"%{query}%"
                params = [pattern, pattern, pattern]
            if category:
                sql += " AND d.category = ?"
                params.append(normalize_category(category))
            sql += " ORDER BY d.created_at DESC LIMIT ?"
            params.append(limit)
            return [dict(row) for row in db.execute(sql, params).fetchall()]

    def categories(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT category, COUNT(*) AS documents "
                    "FROM documents GROUP BY category ORDER BY category"
                ).fetchall()
            ]

    def resolve(self, query: str) -> sqlite3.Row:
        with self.connect() as db:
            exact = db.execute(
                "SELECT * FROM documents WHERE id = ? OR md_path = ? LIMIT 1",
                (query, str(Path(query).expanduser())),
            ).fetchone()
            if exact:
                return exact
            matches = db.execute(
                "SELECT * FROM documents WHERE id LIKE ? OR title LIKE ? "
                "ORDER BY created_at DESC LIMIT 3",
                (query + "%", f"%{query}%"),
            ).fetchall()
        if not matches:
            raise UserError(f"No stored document matches: {query}")
        if len(matches) > 1:
            options = ", ".join(f"{row['id']} ({row['title']})" for row in matches)
            raise UserError(f"Ambiguous document. Use a longer id: {options}")
        return matches[0]

    def move(self, query: str, new_category: str) -> Path:
        row = self.resolve(query)
        old_path = Path(row["md_path"])
        if not old_path.exists():
            raise UserError(f"Indexed Markdown file is missing: {old_path}")
        category = normalize_category(new_category)
        destination = self.category_path(category) / old_path.name
        if destination.exists() and destination != old_path:
            destination = destination.with_name(
                f"{destination.stem}-{uuid.uuid4().hex[:6]}{destination.suffix}"
            )
        metadata, body = parse_document(old_path.read_text(encoding="utf-8"))
        metadata["category"] = category
        temp = destination.with_suffix(destination.suffix + ".tmp")
        temp.write_text(build_document(metadata, body), encoding="utf-8")
        temp.replace(destination)
        if old_path != destination:
            old_path.unlink()
        self.upsert(metadata, body, destination)
        return destination

    def reindex(self) -> int:
        self.initialize()
        with self.connect() as db:
            db.execute("DELETE FROM documents")
            db.execute("DELETE FROM document_search")
        count = 0
        for path in self.category_root.rglob("*.md"):
            text = path.read_text(encoding="utf-8", errors="replace")
            metadata, body = parse_document(text)
            relative_category = path.parent.relative_to(self.category_root).as_posix()
            metadata.setdefault("id", hashlib.sha256(str(path).encode()).hexdigest()[:24])
            metadata.setdefault("title", path.stem)
            metadata["category"] = normalize_category(
                metadata.get("category") or relative_category
            )
            metadata.setdefault("source", "")
            metadata.setdefault("source_type", path.suffix.lower())
            metadata.setdefault("source_sha256", "")
            metadata.setdefault("converted_at", utc_now())
            metadata.setdefault("converter", "microsoft-markitdown")
            metadata.setdefault("engine", "builtin")
            metadata.setdefault("llm_provider", "none")
            metadata.setdefault("llm_model", None)
            metadata.setdefault("source_copy", None)
            self.upsert(metadata, body, path.resolve())
            count += 1
        return count


def distribution_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def build_llm(provider: str, model: str | None) -> tuple[Any | None, str | None]:
    if provider == "none":
        return None, None
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise UserError("The openai compatibility package is not installed. Run setup.ps1.") from exc
    if provider == "openai":
        key = os.getenv("OPENAI_API_KEY")
        if not key:
            raise UserError("OPENAI_API_KEY is not configured.")
        return OpenAI(api_key=key), model or os.getenv(
            "MARKITDOWN_OPENAI_MODEL", DEFAULT_OPENAI_MODEL
        )
    if provider == "gemini":
        key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not key:
            raise UserError("GEMINI_API_KEY or GOOGLE_API_KEY is not configured.")
        return OpenAI(api_key=key, base_url=GEMINI_BASE_URL), model or os.getenv(
            "MARKITDOWN_GEMINI_MODEL", DEFAULT_GEMINI_MODEL
        )
    if provider == "claude":
        key = os.getenv("ANTHROPIC_API_KEY")
        if not key:
            raise UserError("ANTHROPIC_API_KEY is not configured.")
        return OpenAI(api_key=key, base_url=CLAUDE_BASE_URL), model or os.getenv(
            "MARKITDOWN_CLAUDE_MODEL", DEFAULT_CLAUDE_MODEL
        )
    raise UserError(f"Unsupported LLM provider: {provider}")


def build_converter(args: argparse.Namespace) -> tuple[Any, str | None]:
    import warnings
    try:
        with warnings.catch_warnings():
            warnings.filterwarnings(
                "ignore", message="Couldn't find ffmpeg or avconv.*", category=RuntimeWarning
            )
            from markitdown import MarkItDown
    except ImportError as exc:
        raise UserError("Microsoft MarkItDown is not installed. Run setup.ps1.") from exc
    try:
        from pydub import AudioSegment
        import imageio_ffmpeg
        AudioSegment.converter = imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        pass
    if args.engine == "docling":
        if args.provider != "none":
            raise UserError(
                "Docling 고정밀 로컬 엔진은 외부 AI 보강과 동시에 사용할 수 없습니다. "
                "AI 보강 안 함을 선택해 주세요."
            )
        try:
            from docling.document_converter import DocumentConverter
        except ImportError as exc:
            raise UserError(
                "Docling 고정밀 로컬 엔진이 설치되지 않았습니다. "
                "Windows 설치 파일을 다시 실행해 주세요."
            ) from exc

        class DoclingAdapter:
            converter_name = f"docling/{distribution_version('docling') or 'unknown'}"

            def __init__(self) -> None:
                self._converter = DocumentConverter()

            def _convert(self, source: str) -> Any:
                converted = self._converter.convert(source)
                return SimpleNamespace(
                    markdown=converted.document.export_to_markdown(),
                    title=None,
                )

            def convert_local(self, source: str) -> Any:
                return self._convert(source)

            def convert(self, source: str) -> Any:
                return self._convert(source)

        return DoclingAdapter(), None

    client, model = build_llm(args.provider, args.model)
    if args.ocr and args.provider == "none":
        raise UserError("--ocr requires --provider openai, gemini, or claude.")
    if args.ocr and distribution_version("markitdown-ocr") is None:
        raise UserError("markitdown-ocr is not installed. Run setup.ps1.")
    options: dict[str, Any] = {"enable_plugins": bool(args.plugins or args.ocr)}
    if client is not None:
        options.update(
            llm_client=client,
            llm_model=model,
            llm_prompt=args.llm_prompt,
        )
    if args.engine == "docintel":
        endpoint = args.docintel_endpoint or os.getenv("MARKITDOWN_DOCINTEL_ENDPOINT")
        if not endpoint:
            raise UserError("Document Intelligence endpoint is not configured.")
        options["docintel_endpoint"] = endpoint
    elif args.engine == "cu":
        endpoint = args.cu_endpoint or os.getenv("MARKITDOWN_CU_ENDPOINT")
        if not endpoint:
            raise UserError("Content Understanding endpoint is not configured.")
        options["cu_endpoint"] = endpoint
        if args.cu_analyzer_id:
            options["cu_analyzer_id"] = args.cu_analyzer_id
    return MarkItDown(**options), model


def expand_sources(values: list[str], recursive: bool, vault: Vault) -> list[str]:
    expanded: list[str] = []
    for value in values:
        if is_url(value):
            expanded.append(value)
            continue
        path = Path(value).expanduser().resolve()
        if not path.exists():
            raise UserError(f"Source does not exist: {path}")
        if path.is_file():
            expanded.append(str(path))
            continue
        iterator: Iterable[Path] = path.rglob("*") if recursive else path.glob("*")
        for candidate in iterator:
            if not candidate.is_file():
                continue
            resolved = candidate.resolve()
            if resolved.is_relative_to(vault.root):
                continue
            expanded.append(str(resolved))
    return list(dict.fromkeys(expanded))


def convert_one(
    vault: Vault,
    converter: Any,
    source: str,
    args: argparse.Namespace,
    model: str | None,
    only_source: bool,
    progress_callback: Callable[[str, int], None] | None = None,
) -> dict[str, Any]:
    def report(message: str, percent: int) -> None:
        if progress_callback is not None:
            progress_callback(message, percent)

    report("원본 파일과 변환 설정을 확인하고 있습니다.", 8)
    category = normalize_category(args.category)
    remote = is_url(source)
    if remote and not args.allow_remote:
        raise UserError(f"Remote input requires --allow-remote: {source}")
    if remote:
        source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
        source_type = urlparse(source).netloc
        base_title = Path(urlparse(source).path).stem or urlparse(source).netloc
    else:
        source_path = Path(source).resolve()
        if source_path.is_relative_to(vault.root):
            raise UserError("Refusing to convert a file already inside the vault.")
        if (
            source_path.suffix.lower() in AUDIO_EXTENSIONS
            and args.engine == "builtin"
            and not args.allow_network_transcription
        ):
            raise UserError(
                "Built-in audio transcription sends audio to Google's speech service. "
                "Pass --allow-network-transcription to approve that network transfer."
            )
        source_hash = hash_file(source_path)
        source_type = source_path.suffix.lower()
        base_title = source_path.stem
    if not args.force:
        duplicate = vault.find_duplicate(
            source_hash, category, args.provider, model, args.engine
        )
        if duplicate and Path(duplicate["md_path"]).exists():
            report("기존 변환 결과를 확인했습니다.", 100)
            return {
                "status": "existing", "id": duplicate["id"],
                "title": duplicate["title"], "path": duplicate["md_path"],
            }
    if args.engine == "docling":
        report("Docling이 문서 레이아웃·표·읽기 순서·OCR을 고정밀로 분석하고 있습니다.", 32)
    elif args.provider == "none":
        report("MarkItDown이 문서 구조·텍스트·표를 분석하고 있습니다.", 32)
    elif args.ocr:
        report(f"MarkItDown 분석과 {args.provider.upper()} 이미지·OCR 보강을 진행하고 있습니다.", 32)
    else:
        report(f"MarkItDown 분석과 {args.provider.upper()} 이미지 설명 보강을 진행하고 있습니다.", 32)
    result = converter.convert(source) if remote else converter.convert_local(source)
    report("변환된 Markdown의 제목과 구조를 정리하고 있습니다.", 74)
    body = result.markdown
    result_title = getattr(result, "title", None)
    title = args.title if args.title and only_source else (result_title or base_title)
    title = str(title).strip() or base_title or "document"
    identity = (
        f"{source_hash}|{category}|{args.provider}|{model}|{args.engine}"
        if not args.force else uuid.uuid4().hex
    )
    doc_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
    destination = vault.category_path(category) / f"{slugify(title)}--{doc_id[:8]}.md"
    source_copy: str | None = None
    if args.copy_source and not remote:
        report("원본 파일을 이 기기의 로컬 문서함에 보관하고 있습니다.", 84)
        original = Path(source)
        copied = vault.source_root / f"{doc_id}--{clean_segment(original.name)}"
        shutil.copy2(original, copied)
        source_copy = str(copied.resolve())
    metadata = {
        "id": doc_id,
        "title": title,
        "category": category,
        "source": source,
        "source_type": source_type,
        "source_sha256": source_hash,
        "converted_at": utc_now(),
        "converter": getattr(
            converter,
            "converter_name",
            f"microsoft-markitdown/{distribution_version('markitdown') or 'unknown'}",
        ),
        "engine": args.engine,
        "llm_provider": args.provider,
        "llm_model": model,
        "source_copy": source_copy,
    }
    report("Markdown 파일을 이 기기의 로컬 문서함에 저장하고 있습니다.", 92)
    temp = destination.with_suffix(".md.tmp")
    temp.write_text(build_document(metadata, body), encoding="utf-8")
    temp.replace(destination)
    report("문서함 검색 색인을 업데이트하고 있습니다.", 97)
    vault.upsert(metadata, body, destination.resolve())
    report("변환과 로컬 저장을 완료했습니다.", 100)
    return {
        "status": "converted", "id": doc_id, "title": title,
        "category": category, "path": str(destination.resolve()),
        "provider": args.provider, "model": model, "engine": args.engine,
    }


def row_summary(row: dict[str, Any] | sqlite3.Row) -> dict[str, Any]:
    return {
        key: row[key]
        for key in (
            "id", "title", "category", "md_path", "source", "provider",
            "model", "engine", "created_at", "size_bytes", "word_count",
        )
        if key in row.keys()
    }


def print_items(items: list[dict[str, Any]], as_json: bool) -> None:
    if as_json:
        print(json.dumps(items, ensure_ascii=False, indent=2))
        return
    if not items:
        print("No documents found.")
        return
    for item in items:
        snippet = str(item.get("snippet", "")).replace("\n", " ").strip()
        print(f"{item.get('id', '')}  [{item.get('category', '')}]  {item.get('title', '')}")
        print(f"  {item.get('md_path') or item.get('path', '')}")
        if snippet:
            print(f"  {snippet}")


def add_convert_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("sources", nargs="+")
    parser.add_argument("--category", default="inbox")
    parser.add_argument("--recursive", action="store_true")
    parser.add_argument("--provider", choices=("none", "openai", "gemini", "claude"), default="none")
    parser.add_argument("--model")
    parser.add_argument("--llm-prompt")
    parser.add_argument("--ocr", action="store_true")
    parser.add_argument("--plugins", action="store_true")
    parser.add_argument("--engine", choices=("builtin", "docling", "docintel", "cu"), default="builtin")
    parser.add_argument("--docintel-endpoint")
    parser.add_argument("--cu-endpoint")
    parser.add_argument("--cu-analyzer-id")
    parser.add_argument("--title")
    parser.add_argument("--copy-source", action="store_true")
    parser.add_argument("--allow-remote", action="store_true")
    parser.add_argument("--allow-network-transcription", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--json", action="store_true")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mdvault", description="Convert and archive files with Microsoft MarkItDown."
    )
    parser.add_argument("--vault", type=Path, default=default_vault_path())
    parser.add_argument("--version", action="version", version=APP_VERSION)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init")
    sub.add_parser("status")
    sub.add_parser("formats")
    categories = sub.add_parser("categories")
    categories.add_argument("--json", action="store_true")
    convert = sub.add_parser("convert")
    add_convert_arguments(convert)
    listing = sub.add_parser("list")
    listing.add_argument("--category")
    listing.add_argument("--limit", type=int, default=50)
    listing.add_argument("--json", action="store_true")
    search = sub.add_parser("search")
    search.add_argument("query")
    search.add_argument("--category")
    search.add_argument("--limit", type=int, default=20)
    search.add_argument("--json", action="store_true")
    get = sub.add_parser("get")
    get.add_argument("query")
    get.add_argument("--path-only", action="store_true")
    move = sub.add_parser("move")
    move.add_argument("query")
    move.add_argument("category")
    sub.add_parser("reindex")
    return parser


def command_status(vault: Vault) -> None:
    try:
        importlib.import_module("pdfplumber")
        importlib.import_module("pypdfium2")
        ocr_primary = "ok"
    except Exception as exc:
        ocr_primary = f"unavailable: {type(exc).__name__}"
    try:
        importlib.import_module("fitz")
        ocr_fallback = "ok"
    except Exception as exc:
        ocr_fallback = f"unavailable: {type(exc).__name__}"
    payload = {
        "agent_version": APP_VERSION,
        "vault": str(vault.root),
        "vault_exists": vault.root.exists(),
        "markitdown": distribution_version("markitdown"),
        "markitdown_ocr": distribution_version("markitdown-ocr"),
        "openai_compatibility_client": distribution_version("openai"),
        "ffmpeg_bundle": distribution_version("imageio-ffmpeg"),
        "pdf_ocr_primary_backend": ocr_primary,
        "pdf_ocr_malformed_pdf_fallback": ocr_fallback,
        "openai_key_configured": bool(os.getenv("OPENAI_API_KEY")),
        "gemini_key_configured": bool(
            os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        ),
        "claude_key_configured": bool(os.getenv("ANTHROPIC_API_KEY")),
        "docintel_endpoint_configured": bool(os.getenv("MARKITDOWN_DOCINTEL_ENDPOINT")),
        "cu_endpoint_configured": bool(os.getenv("MARKITDOWN_CU_ENDPOINT")),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def command_formats() -> None:
    print("Official format groups (actual detection follows the installed MarkItDown version):")
    for name, detail in FORMAT_GROUPS.items():
        print(f"- {name}: {detail}")
    plugins = sorted(
        ep.name for ep in importlib.metadata.entry_points(group="markitdown.plugin")
    )
    print("Installed plugins: " + (", ".join(plugins) if plugins else "none"))


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    vault = Vault(args.vault)
    try:
        if args.command == "init":
            vault.initialize()
            print(f"Vault ready: {vault.root}")
            return 0
        if args.command == "status":
            command_status(vault)
            return 0
        if args.command == "formats":
            command_formats()
            return 0
        vault.initialize()
        if args.command == "categories":
            items = vault.categories()
            if args.json:
                print(json.dumps(items, ensure_ascii=False, indent=2))
            elif items:
                for item in items:
                    print(f"{item['category']}: {item['documents']}")
            else:
                print("No categories yet.")
            return 0
        if args.command == "list":
            print_items([row_summary(row) for row in vault.rows(args.category, args.limit)], args.json)
            return 0
        if args.command == "search":
            print_items(vault.search(args.query, args.category, args.limit), args.json)
            return 0
        if args.command == "get":
            row = vault.resolve(args.query)
            path = Path(row["md_path"])
            print(path if args.path_only else path.read_text(encoding="utf-8"))
            return 0
        if args.command == "move":
            print(vault.move(args.query, args.category))
            return 0
        if args.command == "reindex":
            print(f"Indexed {vault.reindex()} Markdown document(s).")
            return 0
        if args.command == "convert":
            sources = expand_sources(args.sources, args.recursive, vault)
            if not sources:
                raise UserError("No files were found to convert.")
            converter, model = build_converter(args)
            results: list[dict[str, Any]] = []
            for source in sources:
                try:
                    results.append(
                        convert_one(vault, converter, source, args, model, len(sources) == 1)
                    )
                except Exception as exc:
                    results.append({"status": "failed", "source": source, "error": str(exc)})
            if args.json:
                print(json.dumps(results, ensure_ascii=False, indent=2))
            else:
                for item in results:
                    if item["status"] == "failed":
                        print(f"FAILED  {item['source']}: {item['error']}", file=sys.stderr)
                    else:
                        print(f"{item['status'].upper():9} {item['id']}  {item['path']}")
                converted = sum(item["status"] == "converted" for item in results)
                existing = sum(item["status"] == "existing" for item in results)
                failed = sum(item["status"] == "failed" for item in results)
                print(f"Summary: {converted} converted, {existing} existing, {failed} failed")
            return 1 if any(item["status"] == "failed" for item in results) else 0
        raise UserError(f"Unknown command: {args.command}")
    except UserError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
