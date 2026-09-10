#!/usr/bin/env python3
"""Loopback-only browser interface for the MarkItDown Vault."""

from __future__ import annotations

import argparse
import os
import re
import shutil
import tempfile
import threading
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, SecretStr

from mdvault import (
    DEFAULT_GEMINI_MODEL,
    DEFAULT_OPENAI_MODEL,
    UserError,
    Vault,
    build_converter,
    convert_one,
    default_vault_path,
    distribution_version,
    is_url,
    normalize_category,
    parse_document,
    row_summary,
    utc_now,
)


APP_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = APP_ROOT / "web"
MAX_UPLOAD_BYTES = int(os.getenv("MARKITDOWN_WEB_MAX_UPLOAD_MB", "2048")) * 1024 * 1024
PREVIEW_LIMIT = 200_000
SAFE_FILENAME = re.compile(r"[^\w.()\[\] -]+", re.UNICODE)
CREDENTIAL_SERVICE = os.getenv("MARKITDOWN_CREDENTIAL_SERVICE", "MarkItDownVault")
CREDENTIAL_USERS = {
    "gemini": "gemini-api-key",
    "openai": "openai-api-key",
}
PUBLIC_UI_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.getenv(
        "MARKITDOWN_PUBLIC_UI_ORIGINS", "https://sjk3446.github.io"
    ).split(",")
    if origin.strip()
}

app = FastAPI(title="MarkItDown Vault", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(PUBLIC_UI_ORIGINS),
    allow_origin_regex=r"^http://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    allow_private_network=True,
)
app.mount("/static", StaticFiles(directory=WEB_ROOT), name="static")

vault = Vault(default_vault_path())
vault.initialize()
jobs: dict[str, dict[str, Any]] = {}
job_lock = threading.RLock()
provider_lock = threading.Lock()
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mdvault")


class CategoryRequest(BaseModel):
    name: str


class MoveRequest(BaseModel):
    category: str


class CredentialRequest(BaseModel):
    api_key: SecretStr


def api_error(status: int, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail=message)


def credential_backend() -> Any:
    try:
        import keyring
    except ImportError as exc:
        raise UserError("보안 키 저장 기능이 설치되지 않았습니다. setup.ps1을 다시 실행하세요.") from exc
    backend = keyring.get_keyring()
    if not backend.__class__.__module__.startswith("keyring.backends.Windows"):
        raise UserError("Windows 자격 증명 관리자를 사용할 수 없습니다.")
    return keyring


def environment_api_key(provider: str) -> str | None:
    if provider == "openai":
        return os.getenv("OPENAI_API_KEY")
    if provider == "gemini":
        return os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    return None


def stored_api_key(provider: str) -> str | None:
    username = CREDENTIAL_USERS.get(provider)
    if not username:
        return None
    keyring = credential_backend()
    try:
        return keyring.get_password(CREDENTIAL_SERVICE, username)
    except Exception as exc:
        raise UserError("Windows 자격 증명 관리자에서 API 키를 읽지 못했습니다.") from exc


def save_api_key(provider: str, api_key: str) -> None:
    username = CREDENTIAL_USERS.get(provider)
    if not username:
        raise UserError("저장할 수 없는 AI 제공자입니다.")
    keyring = credential_backend()
    try:
        keyring.set_password(CREDENTIAL_SERVICE, username, api_key)
    except Exception as exc:
        raise UserError("Windows 자격 증명 관리자에 API 키를 저장하지 못했습니다.") from exc


def delete_api_key(provider: str) -> bool:
    username = CREDENTIAL_USERS.get(provider)
    if not username:
        raise UserError("삭제할 수 없는 AI 제공자입니다.")
    keyring = credential_backend()
    try:
        if keyring.get_password(CREDENTIAL_SERVICE, username) is None:
            return False
        keyring.delete_password(CREDENTIAL_SERVICE, username)
        return True
    except Exception as exc:
        raise UserError("Windows 자격 증명 관리자에서 API 키를 삭제하지 못했습니다.") from exc


def provider_key_status(provider: str) -> dict[str, Any]:
    environment = bool(environment_api_key(provider))
    saved = False
    store_available = True
    try:
        saved = bool(stored_api_key(provider))
    except UserError:
        store_available = False
    source = "environment" if environment else ("credential_manager" if saved else None)
    return {
        "configured": environment or saved,
        "saved": saved,
        "environment": environment,
        "credential_store_available": store_available,
        "key_source": source,
    }


def safe_filename(name: str | None, index: int) -> str:
    raw = Path(name or f"upload-{index}").name.strip()
    cleaned = SAFE_FILENAME.sub("_", raw).strip(". ")
    return cleaned or f"upload-{index}"


def source_label(source: str) -> str:
    return source if is_url(source) else Path(source).name


def visible_categories() -> list[dict[str, Any]]:
    counts = {item["category"]: item["documents"] for item in vault.categories()}
    if vault.category_root.exists():
        for path in vault.category_root.rglob("*"):
            if path.is_dir():
                name = path.relative_to(vault.category_root).as_posix()
                if name:
                    counts.setdefault(name, 0)
    counts.setdefault("inbox", counts.get("inbox", 0))
    return [
        {"category": category, "documents": count}
        for category, count in sorted(counts.items(), key=lambda item: item[0].casefold())
    ]


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        key: job.get(key)
        for key in (
            "id", "status", "created_at", "finished_at", "total", "completed",
            "current", "category", "provider", "engine", "results", "error",
        )
    }


def update_job(job_id: str, **values: Any) -> None:
    with job_lock:
        if job_id in jobs:
            jobs[job_id].update(values)


@contextmanager
def temporary_api_key(provider: str, api_key: str | None) -> Iterator[None]:
    if provider == "none" or not api_key:
        yield
        return
    env_name = "OPENAI_API_KEY" if provider == "openai" else "GEMINI_API_KEY"
    previous = os.environ.get(env_name)
    os.environ[env_name] = api_key
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(env_name, None)
        else:
            os.environ[env_name] = previous


def conversion_args(config: dict[str, Any]) -> argparse.Namespace:
    return argparse.Namespace(
        category=config["category"],
        provider=config["provider"],
        model=config.get("model") or None,
        llm_prompt=config.get("llm_prompt") or None,
        ocr=config["ocr"],
        plugins=config["plugins"],
        engine=config["engine"],
        docintel_endpoint=None,
        cu_endpoint=None,
        cu_analyzer_id=None,
        allow_remote=True,
        allow_network_transcription=config["allow_network_transcription"],
        copy_source=config["copy_source"],
        force=config["force"],
        title=None,
    )


def run_conversion(
    job_id: str,
    sources: list[str],
    config: dict[str, Any],
    api_key: str | None,
    upload_root: Path,
) -> None:
    update_job(job_id, status="running")
    args = conversion_args(config)
    results: list[dict[str, Any]] = []
    try:
        effective_key = api_key
        if config["provider"] != "none" and not effective_key and not environment_api_key(config["provider"]):
            effective_key = stored_api_key(config["provider"])
        with provider_lock, temporary_api_key(config["provider"], effective_key):
            converter, resolved_model = build_converter(args)
            for index, source in enumerate(sources, start=1):
                update_job(job_id, current=source_label(source))
                try:
                    result = convert_one(
                        vault, converter, source, args, resolved_model, len(sources) == 1
                    )
                    result["source_name"] = source_label(source)
                    results.append(result)
                except Exception as exc:  # keep a multi-file batch moving
                    results.append(
                        {
                            "status": "failed",
                            "source_name": source_label(source),
                            "error": str(exc),
                        }
                    )
                update_job(job_id, completed=index, results=results.copy())
        failures = sum(item.get("status") == "failed" for item in results)
        final_status = "completed" if failures == 0 else "completed_with_errors"
        update_job(
            job_id,
            status=final_status,
            current=None,
            finished_at=utc_now(),
            results=results,
        )
    except Exception as exc:
        update_job(
            job_id,
            status="failed",
            current=None,
            finished_at=utc_now(),
            error=str(exc),
            results=results,
        )
    finally:
        api_key = None
        effective_key = None
        shutil.rmtree(upload_root, ignore_errors=True)


@app.middleware("http")
async def local_only(request: Request, call_next: Any) -> Any:
    client_host = request.client.host if request.client else ""
    if client_host not in {"127.0.0.1", "::1", "localhost", "testclient"}:
        return JSONResponse(status_code=403, content={"detail": "This app is local-only."})
    host = request.headers.get("host", "").lower()
    allowed_host = (
        host == "localhost" or host.startswith("localhost:")
        or host == "127.0.0.1" or host.startswith("127.0.0.1:")
        or host == "[::1]" or host.startswith("[::1]:")
        or host == "testserver"
    )
    if not allowed_host:
        return JSONResponse(status_code=403, content={"detail": "Invalid local host."})
    origin = request.headers.get("origin")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and origin:
        normalized_origin = origin.lower().rstrip("/")
        allowed_origin = (
            normalized_origin.startswith(("http://127.0.0.1:", "http://localhost:"))
            or normalized_origin in {item.lower() for item in PUBLIC_UI_ORIGINS}
        )
        if not allowed_origin:
            return JSONResponse(status_code=403, content={"detail": "Cross-origin writes are blocked."})
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
    )
    if request.headers.get("access-control-request-private-network", "").lower() == "true":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


@app.exception_handler(UserError)
async def handle_user_error(_: Request, exc: UserError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.get("/", response_class=FileResponse)
def home() -> FileResponse:
    return FileResponse(WEB_ROOT / "index.html")


@app.get("/api/status")
def status() -> dict[str, Any]:
    with vault.connect() as db:
        document_count = db.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    gemini_key = provider_key_status("gemini")
    openai_key = provider_key_status("openai")
    return {
        "ready": True,
        "vault": str(vault.root),
        "documents": document_count,
        "versions": {
            "markitdown": distribution_version("markitdown"),
            "markitdown_ocr": distribution_version("markitdown-ocr"),
        },
        "providers": {
            "local": {"configured": True, "model": None},
            "gemini": {
                **gemini_key,
                "model": os.getenv("MARKITDOWN_GEMINI_MODEL", DEFAULT_GEMINI_MODEL),
            },
            "openai": {
                **openai_key,
                "model": os.getenv("MARKITDOWN_OPENAI_MODEL", DEFAULT_OPENAI_MODEL),
            },
        },
    }


@app.put("/api/credentials/{provider}")
def store_credential(provider: str, payload: CredentialRequest) -> dict[str, Any]:
    api_key = payload.api_key.get_secret_value().strip()
    if provider not in CREDENTIAL_USERS:
        raise api_error(400, "지원하지 않는 AI 제공자입니다.")
    if len(api_key) < 8:
        raise api_error(400, "올바른 API 키를 입력하세요.")
    save_api_key(provider, api_key)
    api_key = ""
    return {"provider": provider, "saved": True}


@app.delete("/api/credentials/{provider}")
def remove_credential(provider: str) -> dict[str, Any]:
    if provider not in CREDENTIAL_USERS:
        raise api_error(400, "지원하지 않는 AI 제공자입니다.")
    deleted = delete_api_key(provider)
    return {"provider": provider, "saved": False, "deleted": deleted}


@app.get("/api/categories")
def categories() -> list[dict[str, Any]]:
    return visible_categories()


@app.post("/api/categories")
def create_category(payload: CategoryRequest) -> dict[str, Any]:
    category = normalize_category(payload.name)
    vault.category_path(category)
    return {"category": category, "documents": 0}


@app.get("/api/documents")
def documents(category: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    return [row_summary(row) for row in vault.rows(category, min(max(limit, 1), 500))]


@app.get("/api/search")
def search(q: str, category: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    if not q.strip():
        return []
    return vault.search(q.strip(), category, min(max(limit, 1), 200))


@app.get("/api/documents/{document_id}")
def document(document_id: str) -> dict[str, Any]:
    try:
        row = vault.resolve(document_id)
    except UserError as exc:
        raise api_error(404, str(exc)) from exc
    path = Path(row["md_path"])
    if not path.exists():
        raise api_error(404, "저장된 Markdown 파일을 찾을 수 없습니다.")
    metadata, body = parse_document(path.read_text(encoding="utf-8", errors="replace"))
    return {
        **row_summary(row),
        "metadata": metadata,
        "content": body[:PREVIEW_LIMIT],
        "truncated": len(body) > PREVIEW_LIMIT,
    }


@app.get("/api/documents/{document_id}/download")
def download_document(document_id: str) -> FileResponse:
    try:
        row = vault.resolve(document_id)
    except UserError as exc:
        raise api_error(404, str(exc)) from exc
    path = Path(row["md_path"])
    if not path.exists():
        raise api_error(404, "저장된 Markdown 파일을 찾을 수 없습니다.")
    return FileResponse(path, media_type="text/markdown; charset=utf-8", filename=path.name)


@app.post("/api/documents/{document_id}/move")
def move_document(document_id: str, payload: MoveRequest) -> dict[str, Any]:
    try:
        destination = vault.move(document_id, payload.category)
        row = vault.resolve(document_id)
    except UserError as exc:
        raise api_error(400, str(exc)) from exc
    return {**row_summary(row), "path": str(destination)}


@app.get("/api/jobs")
def list_jobs() -> list[dict[str, Any]]:
    with job_lock:
        ordered = sorted(jobs.values(), key=lambda item: item["created_at"], reverse=True)
        return [public_job(item) for item in ordered[:25]]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    with job_lock:
        if job_id not in jobs:
            raise api_error(404, "변환 작업을 찾을 수 없습니다.")
        return public_job(jobs[job_id])


@app.post("/api/convert", status_code=202)
async def convert(
    files: list[UploadFile] | None = File(default=None),
    remote_url: str | None = Form(default=None),
    category: str = Form(default="inbox"),
    provider: str = Form(default="none"),
    model: str | None = Form(default=None),
    api_key: str | None = Form(default=None),
    llm_prompt: str | None = Form(default=None),
    engine: str = Form(default="builtin"),
    ocr: bool = Form(default=False),
    plugins: bool = Form(default=False),
    copy_source: bool = Form(default=True),
    force: bool = Form(default=False),
    allow_network_transcription: bool = Form(default=False),
) -> dict[str, Any]:
    if provider not in {"none", "gemini", "openai"}:
        raise api_error(400, "지원하지 않는 AI 제공자입니다.")
    if engine not in {"builtin", "docintel", "cu"}:
        raise api_error(400, "지원하지 않는 변환 엔진입니다.")
    normalized_category = normalize_category(category)
    vault.category_path(normalized_category)

    job_id = uuid.uuid4().hex[:16]
    upload_root = Path(tempfile.gettempdir()) / "markitdown-vault-web" / job_id
    upload_root.mkdir(parents=True, exist_ok=False)
    sources: list[str] = []
    total_bytes = 0
    try:
        for index, upload in enumerate(files or [], start=1):
            target = upload_root / safe_filename(upload.filename, index)
            if target.exists():
                target = target.with_name(f"{target.stem}-{index}{target.suffix}")
            with target.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    total_bytes += len(chunk)
                    if total_bytes > MAX_UPLOAD_BYTES:
                        raise api_error(413, "업로드 용량 제한을 초과했습니다.")
                    output.write(chunk)
            await upload.close()
            sources.append(str(target.resolve()))
        if remote_url and remote_url.strip():
            candidate = remote_url.strip()
            if not candidate.lower().startswith(("http://", "https://")):
                raise api_error(400, "URL은 http:// 또는 https://로 시작해야 합니다.")
            sources.append(candidate)
        if not sources:
            raise api_error(400, "변환할 파일이나 URL을 하나 이상 선택하세요.")
    except Exception:
        shutil.rmtree(upload_root, ignore_errors=True)
        raise

    config = {
        "category": normalized_category,
        "provider": provider,
        "model": (model or "").strip() or None,
        "llm_prompt": (llm_prompt or "").strip() or None,
        "engine": engine,
        "ocr": ocr,
        "plugins": plugins,
        "copy_source": copy_source,
        "force": force,
        "allow_network_transcription": allow_network_transcription,
    }
    job = {
        "id": job_id,
        "status": "queued",
        "created_at": utc_now(),
        "finished_at": None,
        "total": len(sources),
        "completed": 0,
        "current": None,
        "category": normalized_category,
        "provider": provider,
        "engine": engine,
        "results": [],
        "error": None,
    }
    with job_lock:
        jobs[job_id] = job
        if len(jobs) > 100:
            finished = [key for key, value in jobs.items() if value["status"] not in {"queued", "running"}]
            for key in finished[: len(jobs) - 100]:
                jobs.pop(key, None)
    executor.submit(run_conversion, job_id, sources, config, api_key, upload_root)
    return public_job(job)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the local MarkItDown Vault browser app.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--vault", type=Path, default=default_vault_path())
    parser.add_argument("--open", action="store_true", dest="open_browser")
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("For safety, the browser app only binds to this computer.")
    global vault
    vault = Vault(args.vault)
    vault.initialize()
    if args.open_browser:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{args.port}")).start()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
