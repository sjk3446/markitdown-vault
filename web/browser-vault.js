"use strict";

(function () {
  const DB_NAME = "markitdown-vault-browser";
  const DB_VERSION = 1;
  const MAX_FILE_BYTES = 180 * 1024 * 1024;
  const textDecoder = new TextDecoder("utf-8");
  const jobs = new Map();
  let downloadObjectUrl = null;

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("브라우저 저장소 요청에 실패했습니다."));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("브라우저 저장소에 저장하지 못했습니다."));
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("이 브라우저는 로컬 문서함을 지원하지 않습니다."));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("documents")) {
          const documents = db.createObjectStore("documents", { keyPath: "id" });
          documents.createIndex("category", "category", { unique: false });
          documents.createIndex("created_at", "created_at", { unique: false });
        }
        if (!db.objectStoreNames.contains("categories")) {
          db.createObjectStore("categories", { keyPath: "category" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("브라우저 로컬 문서함을 열 수 없습니다."));
    });
  }

  const databasePromise = openDatabase();

  async function put(storeName, value) {
    const db = await databasePromise;
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
    return value;
  }

  async function get(storeName, key) {
    const db = await databasePromise;
    return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
  }

  async function getAll(storeName) {
    const db = await databasePromise;
    return requestResult(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
  }

  function normalizeCategory(value) {
    const category = String(value || "inbox")
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => part.trim().replace(/[<>:"|?*\u0000-\u001f]/g, "-").replace(/^\.+$/, "-"))
      .filter(Boolean)
      .join("/");
    if (!category) throw new Error("카테고리 이름을 입력하세요.");
    return category.slice(0, 160);
  }

  function extension(name) {
    const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : "";
  }

  function titleFromName(name) {
    return String(name || "문서").replace(/\.[^.]+$/, "").trim() || "문서";
  }

  function xmlDocument(bytes) {
    const source = typeof bytes === "string" ? bytes : textDecoder.decode(bytes);
    const parsed = new DOMParser().parseFromString(source, "application/xml");
    if (parsed.querySelector("parsererror")) throw new Error("문서 내부 XML을 읽을 수 없습니다.");
    return parsed;
  }

  function elements(node, localName) {
    return [...node.getElementsByTagNameNS("*", localName)];
  }

  function xmlText(node) {
    return elements(node, "t").map((item) => item.textContent || "").join("");
  }

  function escapeCell(value) {
    return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
  }

  function markdownTable(rows) {
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (!width) return "";
    const normalized = rows.map((row) => Array.from({ length: width }, (_, index) => escapeCell(row[index])));
    const header = normalized[0];
    const body = normalized.slice(1);
    return [
      "| " + header.join(" | ") + " |",
      "| " + header.map(() => "---").join(" | ") + " |",
      ...body.map((row) => "| " + row.join(" | ") + " |"),
    ].join("\n");
  }

  function decodeText(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) return new TextDecoder("utf-16le").decode(data);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
    catch {
      try { return new TextDecoder("euc-kr").decode(data); }
      catch { return textDecoder.decode(data); }
    }
  }

  function htmlToMarkdown(source) {
    const documentNode = new DOMParser().parseFromString(source, "text/html");
    documentNode.querySelectorAll("script,style,noscript,template,svg").forEach((node) => node.remove());

    function render(node, depth) {
      if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || "").replace(/\s+/g, " ");
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const tag = node.tagName.toLowerCase();
      const childText = () => [...node.childNodes].map((child) => render(child, depth)).join("");
      if (/^h[1-6]$/.test(tag)) return "\n\n" + "#".repeat(Number(tag[1])) + " " + childText().trim() + "\n\n";
      if (tag === "p" || tag === "div" || tag === "section" || tag === "article") return "\n\n" + childText().trim() + "\n\n";
      if (tag === "br") return "  \n";
      if (tag === "strong" || tag === "b") return "**" + childText().trim() + "**";
      if (tag === "em" || tag === "i") return "*" + childText().trim() + "*";
      if (tag === "code" && node.parentElement?.tagName.toLowerCase() !== "pre") return "`" + childText().trim() + "`";
      if (tag === "pre") return "\n\n```\n" + (node.textContent || "").trim() + "\n```\n\n";
      if (tag === "a") {
        const label = childText().trim();
        const href = node.getAttribute("href") || "";
        return href && label ? "[" + label + "](" + href + ")" : label;
      }
      if (tag === "img") return "![" + (node.getAttribute("alt") || "이미지") + "](" + (node.getAttribute("src") || "") + ")";
      if (tag === "li") return "\n" + "  ".repeat(depth) + "- " + childText().trim();
      if (tag === "ul" || tag === "ol") return "\n" + [...node.children].map((child) => render(child, depth + 1)).join("") + "\n";
      if (tag === "blockquote") return "\n\n" + childText().trim().split("\n").map((line) => "> " + line).join("\n") + "\n\n";
      if (tag === "table") {
        const rows = [...node.querySelectorAll("tr")].map((row) => [...row.querySelectorAll(":scope > th, :scope > td")].map((cell) => cell.textContent.trim()));
        return "\n\n" + markdownTable(rows) + "\n\n";
      }
      return childText();
    }

    return render(documentNode.body, 0).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function unzip(bytes) {
    if (!window.fflate?.unzipSync) throw new Error("ZIP 변환 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.");
    try { return window.fflate.unzipSync(bytes); }
    catch { throw new Error("압축 문서를 열 수 없습니다. 암호화 또는 손상 여부를 확인하세요."); }
  }

  function convertDocx(bytes, name) {
    const archive = unzip(bytes);
    if (!archive["word/document.xml"]) throw new Error("올바른 DOCX 문서가 아닙니다.");
    const documentNode = xmlDocument(archive["word/document.xml"]);
    const body = elements(documentNode, "body")[0];
    const output = ["# " + titleFromName(name)];
    for (const node of [...body.children]) {
      if (node.localName === "p") {
        const text = xmlText(node).trim();
        if (!text) continue;
        const style = elements(node, "pStyle")[0]?.getAttributeNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "val") || elements(node, "pStyle")[0]?.getAttribute("w:val") || "";
        const heading = String(style).match(/heading\s*([1-6])/i);
        output.push(heading ? "#".repeat(Number(heading[1])) + " " + text : text);
      } else if (node.localName === "tbl") {
        const rows = elements(node, "tr").map((row) => elements(row, "tc").map((cell) => xmlText(cell).trim()));
        const table = markdownTable(rows);
        if (table) output.push(table);
      }
    }
    return output.join("\n\n").trim();
  }

  function convertPptx(bytes, name) {
    const archive = unzip(bytes);
    const slides = Object.keys(archive).filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
    if (!slides.length) throw new Error("올바른 PPTX 문서가 아닙니다.");
    const output = ["# " + titleFromName(name)];
    slides.forEach((path, index) => {
      const documentNode = xmlDocument(archive[path]);
      const paragraphs = elements(documentNode, "p").map((paragraph) => xmlText(paragraph).trim()).filter(Boolean);
      output.push("## 슬라이드 " + (index + 1));
      paragraphs.forEach((paragraph, paragraphIndex) => output.push(paragraphIndex === 0 ? "### " + paragraph : "- " + paragraph));
    });
    return output.join("\n\n").trim();
  }

  function worksheetMarkdown(sheet, name) {
    const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
    if (!rows.length) return "_빈 시트_";
    const limited = rows.slice(0, 10000).map((row) => row.slice(0, 200));
    const note = rows.length > limited.length ? "\n\n> 브라우저 보호를 위해 처음 10,000행만 표시했습니다." : "";
    return "## " + name + "\n\n" + markdownTable(limited) + note;
  }

  function convertSpreadsheet(bytes, name) {
    if (!window.XLSX?.read) throw new Error("Excel 변환 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.");
    const workbook = window.XLSX.read(bytes, { type: "array", cellDates: true });
    return ["# " + titleFromName(name), ...workbook.SheetNames.map((sheetName) => worksheetMarkdown(workbook.Sheets[sheetName], sheetName))].join("\n\n");
  }

  async function convertPdf(bytes, name) {
    if (!window.pdfjsLib?.getDocument) throw new Error("PDF 변환 모듈을 불러오지 못했습니다. 새로고침 후 다시 시도하세요.");
    const pdf = await window.pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    const output = ["# " + titleFromName(name)];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const lines = [];
      let current = [];
      let previousY = null;
      for (const item of textContent.items) {
        const y = Math.round(item.transform?.[5] || 0);
        if (previousY !== null && Math.abs(y - previousY) > 2 && current.length) {
          lines.push(current.join(" ").replace(/\s+/g, " ").trim());
          current = [];
        }
        if (item.str) current.push(item.str);
        previousY = y;
      }
      if (current.length) lines.push(current.join(" ").replace(/\s+/g, " ").trim());
      output.push("## 페이지 " + pageNumber + "\n\n" + lines.filter(Boolean).join("\n\n"));
      page.cleanup();
    }
    return output.join("\n\n").trim();
  }

  function convertEpub(bytes, name) {
    const archive = unzip(bytes);
    const container = archive["META-INF/container.xml"];
    if (!container) throw new Error("올바른 EPUB 파일이 아닙니다.");
    const containerXml = xmlDocument(container);
    const rootfile = elements(containerXml, "rootfile")[0]?.getAttribute("full-path");
    if (!rootfile || !archive[rootfile]) throw new Error("EPUB 목차를 찾을 수 없습니다.");
    const packageXml = xmlDocument(archive[rootfile]);
    const manifest = new Map(elements(packageXml, "item").map((item) => [item.getAttribute("id"), item.getAttribute("href")]));
    const base = rootfile.includes("/") ? rootfile.slice(0, rootfile.lastIndexOf("/") + 1) : "";
    const output = ["# " + titleFromName(name)];
    for (const itemref of elements(packageXml, "itemref")) {
      const href = manifest.get(itemref.getAttribute("idref"));
      if (!href) continue;
      const path = decodeURIComponent(base + href.split("#")[0]).replace(/\/\.\//g, "/");
      if (archive[path]) {
        const chapter = htmlToMarkdown(decodeText(archive[path]));
        if (chapter) output.push(chapter);
      }
    }
    return output.join("\n\n").trim();
  }

  function convertZip(bytes, name) {
    const archive = unzip(bytes);
    const paths = Object.keys(archive).filter((path) => !path.endsWith("/")).slice(0, 500);
    const output = ["# " + titleFromName(name), "## 압축 파일 목록", ...paths.map((path) => "- `" + path + "` (" + archive[path].length.toLocaleString("ko-KR") + " bytes)")];
    const readable = new Set(["txt", "md", "markdown", "csv", "json", "xml", "html", "htm", "yaml", "yml", "log", "ini"]);
    paths.filter((path) => readable.has(extension(path)) && archive[path].length <= 2 * 1024 * 1024).forEach((path) => {
      const raw = decodeText(archive[path]);
      const body = ["html", "htm"].includes(extension(path)) ? htmlToMarkdown(raw) : raw.trim();
      output.push("## " + path + "\n\n" + body);
    });
    if (Object.keys(archive).length > paths.length) output.push("> 브라우저 보호를 위해 처음 500개 항목만 처리했습니다.");
    return output.join("\n\n").trim();
  }

  async function convertFile(file) {
    if (file.size > MAX_FILE_BYTES) throw new Error("모바일 브라우저에서는 180MB 이하 파일을 사용하세요. 더 큰 파일은 Windows 전체 모드를 이용하세요.");
    const ext = extension(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (ext === "pdf") return convertPdf(bytes, file.name);
    if (ext === "docx") return convertDocx(bytes, file.name);
    if (ext === "pptx") return convertPptx(bytes, file.name);
    if (["xlsx", "xls", "xlsb", "ods", "csv", "tsv"].includes(ext)) return convertSpreadsheet(bytes, file.name);
    if (ext === "epub") return convertEpub(bytes, file.name);
    if (ext === "zip") return convertZip(bytes, file.name);
    if (["html", "htm"].includes(ext)) return "# " + titleFromName(file.name) + "\n\n" + htmlToMarkdown(decodeText(bytes));
    if (ext === "json" || ext === "ipynb") {
      const parsed = JSON.parse(decodeText(bytes));
      return "# " + titleFromName(file.name) + "\n\n```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
    }
    if (["xml", "rss", "atom"].includes(ext)) return "# " + titleFromName(file.name) + "\n\n```xml\n" + decodeText(bytes).trim() + "\n```";
    if (["txt", "md", "markdown", "yaml", "yml", "log", "ini", "rtf"].includes(ext) || file.type.startsWith("text/")) {
      return "# " + titleFromName(file.name) + "\n\n" + decodeText(bytes).trim();
    }
    if (file.type.startsWith("image/")) {
      return "# " + titleFromName(file.name) + "\n\n- 형식: " + (file.type || ext.toUpperCase()) + "\n- 크기: " + file.size.toLocaleString("ko-KR") + " bytes\n\n> 이미지 OCR과 설명은 Windows 전체 모드에서 Gemini, OpenAI 또는 Claude를 선택해 사용할 수 있습니다.";
    }
    if (file.type.startsWith("audio/")) {
      return "# " + titleFromName(file.name) + "\n\n- 형식: " + (file.type || ext.toUpperCase()) + "\n- 크기: " + file.size.toLocaleString("ko-KR") + " bytes\n\n> 음성 인식은 Windows 전체 모드에서 사용할 수 있습니다.";
    }
    throw new Error("모바일 브라우저에서 지원하지 않는 형식입니다. Windows 전체 모드를 이용하세요: ." + (ext || "unknown"));
  }

  function publicDocument(documentRecord, includeContent) {
    const result = { ...documentRecord };
    delete result.source_blob;
    if (!includeContent) delete result.content;
    return result;
  }

  async function listDocuments(category) {
    const records = await getAll("documents");
    return records.filter((item) => !category || item.category === category).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async function categoryList() {
    const [categoryRows, documents] = await Promise.all([getAll("categories"), getAll("documents")]);
    const counts = new Map([["inbox", 0]]);
    categoryRows.forEach((item) => counts.set(item.category, counts.get(item.category) || 0));
    documents.forEach((item) => counts.set(item.category, (counts.get(item.category) || 0) + 1));
    return [...counts].sort((a, b) => a[0].localeCompare(b[0], "ko")).map(([category, documentCount]) => ({ category, documents: documentCount }));
  }

  function publicJob(job) {
    return JSON.parse(JSON.stringify(job));
  }

  async function runJob(job, files, options) {
    job.status = "running";
    for (const file of files) {
      job.current = file.name;
      try {
        const content = await convertFile(file);
        const createdAt = new Date().toISOString();
        const id = createdAt.replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 8);
        const record = {
          id,
          title: titleFromName(file.name),
          category: options.category,
          source_name: file.name,
          created_at: createdAt,
          word_count: (content.match(/[\p{L}\p{N}_]+/gu) || []).length,
          size_bytes: new Blob([content]).size,
          provider: "none",
          model: null,
          engine: "browser",
          content,
          truncated: false,
          source_blob: options.copySource ? file : null,
        };
        await put("documents", record);
        job.results.push({ status: "completed", id, title: record.title, source_name: file.name });
      } catch (error) {
        job.results.push({ status: "failed", source_name: file.name, error: error.message || String(error) });
      }
      job.completed += 1;
    }
    job.current = null;
    const failures = job.results.filter((item) => item.status === "failed");
    job.status = failures.length === job.total ? "failed" : failures.length ? "completed_with_errors" : "completed";
    if (job.status === "failed") job.error = failures[0]?.error || "변환하지 못했습니다.";
  }

  async function browserApi(path, options) {
    const method = String(options?.method || "GET").toUpperCase();
    const url = new URL(path, location.origin);

    if (url.pathname === "/api/status" && method === "GET") {
      const documents = await listDocuments();
      return {
        ready: true,
        runtime: "browser",
        vault: "이 브라우저의 로컬 문서함",
        documents: documents.length,
        versions: { markitdown: "브라우저 로컬", markitdown_ocr: null },
        providers: {
          local: { configured: true, model: null },
          gemini: { configured: false, saved: false, environment: false, credential_store_available: false, model: "gemini-2.5-flash" },
          openai: { configured: false, saved: false, environment: false, credential_store_available: false, model: "gpt-4o-mini" },
          claude: { configured: false, saved: false, environment: false, credential_store_available: false, model: "claude-sonnet-5" },
        },
      };
    }

    if (url.pathname === "/api/categories" && method === "GET") return categoryList();
    if (url.pathname === "/api/categories" && method === "POST") {
      const category = normalizeCategory(JSON.parse(options.body || "{}").name);
      await put("categories", { category });
      return { category, documents: 0 };
    }

    if (url.pathname === "/api/documents" && method === "GET") {
      const records = await listDocuments(url.searchParams.get("category"));
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
      return records.slice(0, limit).map((item) => publicDocument(item, false));
    }

    if (url.pathname === "/api/search" && method === "GET") {
      const query = (url.searchParams.get("q") || "").trim().toLocaleLowerCase("ko");
      const category = url.searchParams.get("category") || "";
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 100)));
      const records = await listDocuments(category);
      return records.filter((item) => (item.title + "\n" + item.content).toLocaleLowerCase("ko").includes(query)).slice(0, limit).map((item) => publicDocument(item, false));
    }

    const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/);
    if (documentMatch && method === "GET") {
      const record = await get("documents", decodeURIComponent(documentMatch[1]));
      if (!record) throw new Error("저장된 문서를 찾을 수 없습니다.");
      return publicDocument(record, true);
    }

    const moveMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/move$/);
    if (moveMatch && method === "POST") {
      const record = await get("documents", decodeURIComponent(moveMatch[1]));
      if (!record) throw new Error("저장된 문서를 찾을 수 없습니다.");
      record.category = normalizeCategory(JSON.parse(options.body || "{}").category);
      await Promise.all([put("documents", record), put("categories", { category: record.category })]);
      return publicDocument(record, false);
    }

    if (url.pathname === "/api/jobs" && method === "GET") {
      return [...jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 25).map(publicJob);
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch && method === "GET") {
      const job = jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) throw new Error("변환 작업을 찾을 수 없습니다.");
      return publicJob(job);
    }

    if (url.pathname === "/api/convert" && method === "POST") {
      const form = options.body;
      if (!(form instanceof FormData)) throw new Error("올바른 변환 요청이 아닙니다.");
      if (String(form.get("remote_url") || "").trim()) throw new Error("모바일 로컬 모드에서는 URL 변환을 지원하지 않습니다. 파일을 직접 선택하세요.");
      if (String(form.get("provider") || "none") !== "none") throw new Error("모바일 로컬 모드는 API 키나 크레딧을 사용하지 않습니다. LOCAL을 선택하세요.");
      const files = form.getAll("files").filter((item) => item instanceof File);
      if (!files.length) throw new Error("변환할 파일을 선택하세요.");
      const category = normalizeCategory(form.get("category"));
      await put("categories", { category });
      const createdAt = new Date().toISOString();
      const id = "browser-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
      const job = { id, status: "queued", category, provider: "none", total: files.length, completed: 0, current: null, created_at: createdAt, results: [], error: null };
      jobs.set(id, job);
      setTimeout(() => runJob(job, files, { category, copySource: form.get("copy_source") === "true" }), 0);
      return publicJob(job);
    }

    if (url.pathname.startsWith("/api/credentials/")) throw new Error("API 키 저장은 Windows 전체 모드에서만 지원합니다.");
    throw new Error("브라우저 로컬 모드에서 지원하지 않는 요청입니다.");
  }

  function frontmatter(documentRecord) {
    const quote = (value) => '"' + String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    return [
      "---",
      "title: " + quote(documentRecord.title),
      "category: " + quote(documentRecord.category),
      "source: " + quote(documentRecord.source_name),
      "created_at: " + quote(documentRecord.created_at),
      "engine: browser",
      "provider: none",
      "---",
      "",
      documentRecord.content,
      "",
    ].join("\n");
  }

  window.browserVault = {
    async ready() {
      await databasePromise;
      await put("categories", { category: "inbox" });
      if (window.pdfjsLib?.GlobalWorkerOptions) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./static/vendor/pdf.worker.min.js", location.href).href;
      }
    },
    api: browserApi,
    downloadUrl(documentRecord) {
      if (downloadObjectUrl) URL.revokeObjectURL(downloadObjectUrl);
      downloadObjectUrl = URL.createObjectURL(new Blob([frontmatter(documentRecord)], { type: "text/markdown;charset=utf-8" }));
      return downloadObjectUrl;
    },
  };
})();
