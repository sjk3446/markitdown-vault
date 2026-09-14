"use strict";

const state = {
  files: [],
  status: null,
  categories: [],
  documents: [],
  jobs: [],
  currentDocument: null,
  polling: new Set(),
};

const COMPANION_ORIGIN = "http://127.0.0.1:8787";
const COMPANION_PROTOCOL = "markitdown-vault://start";
const runningFromCompanion = ["127.0.0.1", "localhost", "::1"].includes(window.location.hostname)
  && window.location.port === "8787";
let runtimeMode = runningFromCompanion ? "companion" : "detecting";
let categoryDialogSource = "convert";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const terminalStates = new Set(["completed", "completed_with_errors", "failed"]);
const viewNames = { convert: "새 변환", library: "문서함", jobs: "작업 기록" };
const providerNames = { none: "LOCAL", gemini: "Gemini", openai: "OpenAI", claude: "Claude" };
const providerModelOptions = {
  gemini: [
    ["gemini-2.5-flash", "Gemini 2.5 Flash — 권장 · 빠른 균형"],
    ["gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite — 가장 경제적"],
    ["gemini-2.5-pro", "Gemini 2.5 Pro — 고품질"],
  ],
  openai: [
    ["gpt-4o-mini", "GPT-4o mini — 권장 · 경제적"],
    ["gpt-4.1-mini", "GPT-4.1 mini — 빠른 고품질"],
    ["gpt-4o", "GPT-4o — 고품질 이미지"],
    ["gpt-4.1", "GPT-4.1 — 고품질"],
  ],
  claude: [
    ["claude-sonnet-5", "Claude Sonnet 5 — 권장 · 균형"],
    ["claude-sonnet-4-6", "Claude Sonnet 4.6 — 빠른 균형"],
    ["claude-opus-5", "Claude Opus 5 — 최고 품질"],
  ],
};

function friendlyErrorMessage(error) {
  const raw = String(error?.message || error || "").trim();
  if (!raw) return "요청을 처리하는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.";
  if (/[가-힣]/.test(raw)) return raw;
  const messages = [
    [/Document Intelligence endpoint is not configured/i, "Azure Document Intelligence 연결 정보가 없습니다. 고급 옵션에서 ‘MarkItDown 기본’을 선택하거나 PC 고급 로컬 모드에 Azure 엔드포인트를 설정해 주세요."],
    [/Content Understanding endpoint is not configured/i, "Azure Content Understanding 연결 정보가 없습니다. 고급 옵션에서 ‘MarkItDown 기본’을 선택하거나 PC 고급 로컬 모드에 Azure 엔드포인트를 설정해 주세요."],
    [/OPENAI_API_KEY is not configured/i, "OpenAI API 키가 없습니다. OpenAI 보강을 선택한 경우 API 키를 입력하거나 저장해 주세요."],
    [/GEMINI_API_KEY or GOOGLE_API_KEY is not configured/i, "Gemini API 키가 없습니다. Gemini 보강을 선택한 경우 API 키를 입력하거나 저장해 주세요."],
    [/ANTHROPIC_API_KEY is not configured/i, "Claude API 키가 없습니다. Claude 보강을 선택한 경우 API 키를 입력하거나 저장해 주세요."],
    [/--ocr requires --provider/i, "AI OCR 보강을 사용하려면 Gemini, OpenAI 또는 Claude 중 하나를 먼저 선택해 주세요."],
    [/markitdown-ocr is not installed/i, "AI OCR 구성 요소가 설치되지 않았습니다. PC 로컬 엔진 설치 파일을 다시 실행해 주세요."],
    [/Microsoft MarkItDown is not installed/i, "Microsoft MarkItDown이 설치되지 않았습니다. PC 로컬 엔진 설치 파일을 다시 실행해 주세요."],
    [/Docling.*not installed|No module named ['"]docling/i, "Docling 고정밀 로컬 엔진이 설치되지 않았습니다. Windows 설치 파일을 다시 실행해 주세요."],
    [/openai compatibility package is not installed/i, "외부 AI 연결 구성 요소가 설치되지 않았습니다. PC 로컬 엔진 설치 파일을 다시 실행해 주세요."],
    [/Remote input requires --allow-remote/i, "웹 주소 변환 권한이 꺼져 있습니다. 파일을 직접 올리거나 PC 고급 로컬 모드의 URL 변환 설정을 확인해 주세요."],
    [/Built-in audio transcription sends audio/i, "오디오 음성 인식에는 외부 전송 동의가 필요합니다. 고급 옵션에서 ‘오디오 전송 허용’을 선택해 주세요."],
    [/Source does not exist/i, "선택한 원본 파일을 찾을 수 없습니다. 파일이 이동되거나 삭제되지 않았는지 확인해 주세요."],
    [/No stored document matches/i, "조건에 맞는 저장 문서를 찾지 못했습니다."],
    [/Ambiguous document/i, "이름이 비슷한 문서가 여러 개입니다. 문서함에서 원하는 문서를 직접 선택해 주세요."],
    [/Failed to fetch|NetworkError|Load failed/i, "PC 로컬 엔진에 연결하지 못했습니다. 바탕화면의 MarkItDown Vault를 실행한 뒤 ‘PC 엔진 시작·연결’을 눌러 주세요."],
  ];
  const match = messages.find(([pattern]) => pattern.test(raw));
  return match
    ? match[1]
    : "변환 중 예상하지 못한 문제가 발생했습니다. MarkItDown 기본 설정으로 다시 시도해 주세요.";
}

function apiUrl(path) {
  return `${runningFromCompanion ? "" : COMPANION_ORIGIN}${path}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;",
  })[char]);
}

async function api(path, options = {}) {
  if (runtimeMode === "browser") return window.browserVault.api(path, options);
  const response = await fetch(apiUrl(path), options);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(friendlyErrorMessage(payload?.detail || payload || `요청 실패 (${response.status})`));
  }
  return payload;
}

async function probeCompanion(timeoutMs = 1400) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${COMPANION_ORIGIN}/api/status`, {
      signal: controller.signal,
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function detectRuntime() {
  if (runningFromCompanion) {
    runtimeMode = "companion";
    return;
  }
  if (await probeCompanion()) {
    runtimeMode = "companion";
  } else {
    runtimeMode = "browser";
    if (!window.browserVault) throw new Error("모바일 변환 모듈을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침하세요.");
    await window.browserVault.ready();
  }
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function startAndConnectCompanion() {
  const button = $("#retry-connection");
  const feedback = $("#connection-feedback");
  button.disabled = true;
  button.textContent = "연결 확인 중…";
  feedback.hidden = false;
  feedback.classList.remove("error");
  feedback.textContent = "이 PC에서 로컬 엔진이 실행 중인지 확인하고 있습니다.";
  try {
    let connected = await probeCompanion(1800);
    if (!connected) {
      feedback.textContent = "설치된 PC 로컬 엔진의 실행을 요청했습니다. 브라우저 확인창이 뜨면 열기를 선택하세요.";
      const launcher = document.createElement("a");
      launcher.href = COMPANION_PROTOCOL;
      launcher.hidden = true;
      document.body.appendChild(launcher);
      launcher.click();
      launcher.remove();
      for (let attempt = 0; attempt < 12 && !connected; attempt += 1) {
        await wait(850);
        connected = await probeCompanion(900);
      }
    }
    if (!connected) {
      runtimeMode = "browser";
      configureRuntimeUi();
      feedback.classList.add("error");
      feedback.textContent = "PC 엔진을 찾지 못했습니다. 먼저 설치 ZIP의 압축을 풀고 Install-Windows.cmd를 실행하거나, 바탕화면 바로가기를 실행해 주세요.";
      $("#companion-dialog").showModal();
      toast("PC 엔진이 실행되지 않았습니다. 화면의 설치·실행 안내를 확인해 주세요.", true);
      return;
    }
    runtimeMode = "companion";
    await Promise.all([loadStatus(), loadCategories(), loadDocuments(), loadJobs()]);
    feedback.hidden = true;
    toast("PC 로컬 엔진에 연결했습니다. Docling과 고급 기능을 사용할 수 있습니다.");
  } catch (error) {
    runtimeMode = "browser";
    feedback.classList.add("error");
    feedback.textContent = "연결 확인 중 문제가 발생했습니다. PC 엔진을 실행한 뒤 다시 시도해 주세요.";
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = runtimeMode === "browser" ? "PC 엔진 시작·연결" : "연결 다시 확인";
  }
}

let toastTimer;
function toast(message, error = false) {
  const node = $("#toast");
  if (error) message = friendlyErrorMessage(message);
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("visible"), 3300);
}

function setView(name) {
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === name));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  $("#view-title").textContent = viewNames[name];
  if (name === "library") loadDocuments();
  if (name === "jobs") loadJobs();
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function formatElapsed(value) {
  const started = new Date(value).getTime();
  if (!Number.isFinite(started)) return "방금 시작";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes}분 ${remainder}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function statusLabel(status) {
  return {
    queued: "대기 중", running: "변환 중", completed: "완료",
    completed_with_errors: "일부 오류", failed: "실패",
  }[status] || status;
}

async function loadStatus() {
  state.status = await api("/api/status");
  const browserMode = runtimeMode === "browser";
  $("#companion-banner").hidden = !browserMode;
  $("#vault-path").textContent = state.status.vault;
  $("#nav-doc-count").textContent = state.status.documents;
  const markitdownVersion = state.status.versions.markitdown;
  const indicator = $("#local-status");
  indicator.classList.toggle("ready", Boolean(markitdownVersion));
  indicator.lastChild.textContent = browserMode ? " 브라우저 로컬 모드" : (markitdownVersion ? ` PC 로컬 · MarkItDown ${markitdownVersion}` : " 엔진 확인 필요");
  const keyLabel = (provider) => {
    if (provider.saved) return "안전 저장됨";
    if (provider.environment) return "환경 변수";
    return browserMode ? "PC 전용" : "키 입력";
  };
  $("#gemini-key-state").textContent = keyLabel(state.status.providers.gemini);
  $("#openai-key-state").textContent = keyLabel(state.status.providers.openai);
  $("#claude-key-state").textContent = keyLabel(state.status.providers.claude);
  configureRuntimeUi();
  updateProviderPanel();
}

function configureRuntimeUi() {
  const browserMode = runtimeMode === "browser";
  document.documentElement.dataset.runtime = runtimeMode;
  const localRadio = $("input[name='provider'][value='none']");
  const aiRadios = $$('input[name="provider"]:not([value="none"])');
  if (browserMode) localRadio.checked = true;
  aiRadios.forEach((radio) => { radio.disabled = browserMode; });
  $$(".provider-card").forEach((card) => card.classList.toggle("unavailable", browserMode && card.querySelector("input").value !== "none"));
  $("#remote-url").disabled = browserMode;
  $("#remote-url").placeholder = browserMode ? "URL 변환은 PC 고급 로컬 모드에서 지원" : "https://… (YouTube, 웹 문서)";
  ["#engine-select", "#ocr-check", "#plugins-check", "#audio-network-check"].forEach((selector) => {
    $(selector).disabled = browserMode;
  });
  $("#retry-connection").textContent = browserMode ? "PC 엔진 시작·연결" : "연결 다시 확인";
  updateEngineUi();
}

function updateEngineUi() {
  const engine = $("#engine-select").value;
  const docling = engine === "docling";
  const aiRadios = $$('.provider-card input[name="provider"]:not([value="none"])');
  if (docling) {
    const local = $('input[name="provider"][value="none"]');
    if (local) local.checked = true;
    updateProviderPanel();
  }
  aiRadios.forEach((radio) => {
    radio.disabled = runtimeMode === "browser" || docling;
  });
  $$(".provider-card").forEach((card) => {
    const external = card.querySelector("input").value !== "none";
    card.classList.toggle("unavailable", external && (runtimeMode === "browser" || docling));
  });
  const copy = docling ? {
    label: "Docling 고정밀 로컬",
    kicker: "고정밀 로컬 변환 엔진 · 선택됨",
    name: "Docling",
    description: "레이아웃·표·수식·읽기 순서·OCR을 PC에서 정밀 분석합니다.",
    help: "API 크레딧과 외부 전송 없이 실행됩니다. MarkItDown보다 오래 걸리고 메모리를 더 사용할 수 있습니다.",
  } : {
    label: engine === "builtin" ? "MarkItDown 기본" : "클라우드 변환 엔진",
    kicker: engine === "builtin" ? "기본 로컬 변환 엔진" : "선택한 외부 변환 엔진",
    name: engine === "builtin" ? "Microsoft MarkItDown" : $("#engine-select").selectedOptions[0].textContent,
    description: engine === "builtin"
      ? "문서 구조·텍스트·표를 빠르게 로컬에서 추출합니다."
      : "선택한 Azure 서비스로 문서를 전송해 변환합니다.",
    help: engine === "builtin"
      ? "일반 문서는 빠른 MarkItDown 기본을 권장합니다."
      : "Azure 사용량에 따라 비용이 발생하며 별도 연결 설정이 필요합니다.",
  };
  $("#active-engine-label").textContent = copy.label;
  $("#base-engine-kicker").textContent = copy.kicker;
  $("#base-engine-name").textContent = copy.name;
  $("#base-engine-description").textContent = copy.description;
  $("#engine-help").textContent = runtimeMode === "browser" && docling
    ? "Docling은 PC 고급 로컬 모드에서 사용할 수 있습니다."
    : copy.help;
}

async function loadCategories(selected) {
  state.categories = await api("/api/categories");
  const targets = [$("#category-select"), $("#move-category")];
  targets.forEach((select) => {
    const previous = selected || select.value || "inbox";
    select.innerHTML = state.categories.map((item) =>
      `<option value="${escapeHtml(item.category)}">${escapeHtml(item.category)} (${item.documents})</option>`
    ).join("");
    if (state.categories.some((item) => item.category === previous)) select.value = previous;
  });
  const filter = $("#library-category");
  const previousFilter = filter.value;
  filter.innerHTML = `<option value="">모든 카테고리</option>` + state.categories.map((item) =>
    `<option value="${escapeHtml(item.category)}">${escapeHtml(item.category)} (${item.documents})</option>`
  ).join("");
  filter.value = previousFilter;
}

function renderFiles() {
  const list = $("#file-list");
  list.innerHTML = "";
  state.files.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "file-chip";
    const ext = file.name.includes(".") ? file.name.split(".").pop() : "FILE";
    item.innerHTML = `<b>${escapeHtml(ext)}</b><span>${escapeHtml(file.name)}</span><small>${formatBytes(file.size)}</small><button type="button" aria-label="${escapeHtml(file.name)} 제거">×</button>`;
    item.querySelector("button").addEventListener("click", () => {
      state.files.splice(index, 1);
      renderFiles();
    });
    list.appendChild(item);
  });
}

function addFiles(fileList) {
  const incoming = [...fileList];
  incoming.forEach((file) => {
    const duplicate = state.files.some((current) =>
      current.name === file.name && current.size === file.size && current.lastModified === file.lastModified
    );
    if (!duplicate) state.files.push(file);
  });
  renderFiles();
}

function updateProviderPanel() {
  const provider = $("input[name='provider']:checked").value;
  $$(".provider-card").forEach((card) => {
    card.classList.toggle("selected", card.querySelector("input").checked);
  });
  $("#ai-settings").hidden = provider === "none";
  const providerStatus = state.status?.providers?.[provider];
  const modelSelect = $("#model-input");
  const configuredModel = providerStatus?.model || "";
  const models = [...(providerModelOptions[provider] || [])];
  if (configuredModel && !models.some(([value]) => value === configuredModel)) {
    models.unshift([configuredModel, `현재 기본 모델 — ${configuredModel}`]);
  }
  modelSelect.innerHTML = models.map(([value, label]) =>
    `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`
  ).join("");
  if (configuredModel && models.some(([value]) => value === configuredModel)) modelSelect.value = configuredModel;
  $("#model-help").textContent = provider === "none"
    ? "AI 보강을 선택하면 모델을 고를 수 있습니다."
    : `${providerNames[provider]} API에서 사용할 이미지·OCR 보강 모델입니다.`;
  const ocrAvailable = runtimeMode !== "browser" && provider !== "none";
  $("#ocr-check").disabled = !ocrAvailable;
  if (!ocrAvailable) $("#ocr-check").checked = false;
  $("#ocr-option").classList.toggle("unavailable", !ocrAvailable);
  $("#api-key-input").placeholder = providerStatus?.configured
    ? "저장된 키 사용 중 (새 키 입력 가능)"
    : "이번 변환에 사용할 API 키";
  const saveButton = $("#save-api-key");
  const deleteButton = $("#delete-api-key");
  const note = $("#credential-note");
  saveButton.disabled = runtimeMode === "browser" || provider === "none" || providerStatus?.credential_store_available === false;
  deleteButton.hidden = !providerStatus?.saved;
  note.classList.toggle("saved", Boolean(providerStatus?.saved || providerStatus?.environment));
  if (providerStatus?.saved) {
    note.textContent = "Windows 자격 증명 관리자에 암호화 저장되어 자동으로 사용됩니다.";
  } else if (providerStatus?.environment) {
    note.textContent = "Windows 환경 변수에 설정된 키를 자동으로 사용합니다.";
  } else if (runtimeMode === "browser") {
    note.textContent = "API 키와 AI 보강은 PC 고급 로컬 모드에서 사용할 수 있습니다.";
  } else if (providerStatus?.credential_store_available === false) {
    note.textContent = "Windows 자격 증명 관리자를 사용할 수 없어 이번 변환에만 사용할 수 있습니다.";
  } else {
    note.textContent = "입력한 키는 저장하지 않으면 이번 변환에만 사용됩니다.";
  }
}

async function saveCurrentApiKey() {
  const provider = $("input[name='provider']:checked").value;
  const apiKey = $("#api-key-input").value.trim();
  if (provider === "none") return;
  if (!apiKey) {
    toast("저장할 API 키를 먼저 입력하세요.", true);
    return;
  }
  const button = $("#save-api-key");
  button.disabled = true;
  try {
    await api(`/api/credentials/${provider}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    });
    $("#api-key-input").value = "";
    await loadStatus();
    toast(`${providerNames[provider]} 키를 Windows 자격 증명 관리자에 저장했습니다.`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function deleteCurrentApiKey() {
  const provider = $("input[name='provider']:checked").value;
  if (provider === "none") return;
  const label = providerNames[provider] || provider;
  if (!window.confirm(`Windows 자격 증명 관리자에서 ${label} 키를 삭제할까요?`)) return;
  try {
    await api(`/api/credentials/${provider}`, { method: "DELETE" });
    await loadStatus();
    toast(`${label} 저장 키를 삭제했습니다.`);
  } catch (error) {
    toast(error.message, true);
  }
}

function renderJob(job, compact = false) {
  const reportedProgress = Number(job.progress_percent);
  const progress = Number.isFinite(reportedProgress)
    ? Math.min(100, Math.max(0, Math.round(reportedProgress)))
    : (job.total ? Math.round((job.completed / job.total) * 100) : 0);
  const active = !terminalStates.has(job.status);
  const phase = job.phase || (job.current
    ? "현재 파일을 MarkItDown으로 분석하고 있습니다."
    : "변환 작업을 기다리고 있습니다.");
  const description = job.current
    ? escapeHtml(job.current)
    : `${escapeHtml(job.category)} · ${escapeHtml(providerNames[job.provider] || job.provider)}`;
  const results = compact ? "" : (job.results || []).map((item) => {
    const failed = item.status === "failed";
    return `<p class="result-line${failed ? " failed" : ""}">${failed ? "×" : "✓"} ${escapeHtml(item.title || item.source_name)}${failed ? ` — ${escapeHtml(friendlyErrorMessage(item.error))}` : ""}</p>`;
  }).join("");
  return `<article class="job-card ${escapeHtml(job.status)}">
    <div class="job-top"><span class="job-status ${escapeHtml(job.status)}"></span><strong>${statusLabel(job.status)}</strong><span class="job-percent">단계 진행률 ${progress}%</span><time>${active ? `경과 ${formatElapsed(job.created_at)}` : formatDate(job.finished_at || job.created_at)}</time></div>
    <p class="job-phase" aria-live="polite"><i aria-hidden="true"></i><span>${escapeHtml(phase)}</span></p>
    <p class="job-sub">${description}${job.error ? ` — ${escapeHtml(friendlyErrorMessage(job.error))}` : ""}</p>
    ${active ? `<progress class="progress-track" max="100" value="${progress}" aria-label="${escapeHtml(phase)} · 단계 진행률 ${progress}%"></progress><div class="job-progress-meta"><span>${job.completed}/${job.total}개 파일 완료</span><strong>${progress}%</strong></div>` : ""}
    ${results}
  </article>`;
}

function showLiveJob(job) {
  $("#live-job-section").hidden = false;
  const progress = Number.isFinite(Number(job.progress_percent))
    ? Math.round(Number(job.progress_percent))
    : (job.total ? Math.round((job.completed / job.total) * 100) : 0);
  $("#live-job-label").textContent = `${progress}% · ${job.completed}/${job.total}개 완료`;
  $("#live-job").innerHTML = renderJob(job);
}

async function pollJob(jobId) {
  if (state.polling.has(jobId)) return;
  state.polling.add(jobId);
  try {
    while (true) {
      const job = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      showLiveJob(job);
      if (terminalStates.has(job.status)) {
        const hasResult = (job.results || []).some((item) => item.status !== "failed");
        if (hasResult) {
          $("#library-sync").hidden = false;
          $("#live-job-label").textContent = "문서함 반영 중";
        }
        await Promise.all([loadStatus(), loadCategories(), loadDocuments(), loadJobs()]);
        $("#library-sync").hidden = true;
        showLiveJob(job);
        if (hasResult) setView("library");
        if (job.status === "completed") toast(`${job.total}개 문서가 문서함에 저장되었습니다.`);
        else toast(job.error ? friendlyErrorMessage(job.error) : "완료된 문서는 문서함에 저장했고, 일부 파일은 변환하지 못했습니다.", true);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.polling.delete(jobId);
  }
}

async function submitConversion(event) {
  event.preventDefault();
  const remoteUrl = $("#remote-url").value.trim();
  if (!state.files.length && !remoteUrl) {
    toast("변환할 파일이나 URL을 선택하세요.", true);
    return;
  }
  const provider = $("input[name='provider']:checked").value;
  if ($("#ocr-check").checked && provider === "none") {
    toast("OCR 플러그인은 Gemini, OpenAI 또는 Claude를 선택해야 합니다.", true);
    return;
  }
  const providerConfigured = state.status?.providers?.[provider]?.configured;
  if (provider !== "none" && !providerConfigured && !$("#api-key-input").value.trim()) {
    toast(`${providerNames[provider] || provider} API 키를 입력하세요.`, true);
    return;
  }

  const form = new FormData();
  state.files.forEach((file) => form.append("files", file, file.name));
  form.append("remote_url", remoteUrl);
  form.append("category", $("#category-select").value);
  form.append("provider", provider);
  form.append("model", $("#model-input").value.trim());
  form.append("api_key", $("#api-key-input").value.trim());
  form.append("llm_prompt", $("#llm-prompt").value.trim());
  form.append("engine", $("#engine-select").value);
  form.append("ocr", String($("#ocr-check").checked));
  form.append("plugins", String($("#plugins-check").checked));
  form.append("copy_source", String($("#copy-source-check").checked));
  form.append("force", String($("#force-check").checked));
  form.append("allow_network_transcription", String($("#audio-network-check").checked));

  const button = $("#convert-button");
  button.disabled = true;
  button.querySelector("span").textContent = runtimeMode === "browser" ? "기기에서 준비 중…" : "업로드 중…";
  try {
    const job = await api("/api/convert", { method: "POST", body: form });
    state.files = [];
    renderFiles();
    $("#file-input").value = "";
    $("#remote-url").value = "";
    $("#api-key-input").value = "";
    showLiveJob(job);
    pollJob(job.id);
    toast("변환 작업을 시작했습니다.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Markdown 변환 시작";
  }
}

async function loadDocuments() {
  const query = $("#search-input").value.trim();
  const category = $("#library-category").value;
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  params.set("limit", "200");
  state.documents = query
    ? await api(`/api/search?${params}`)
    : await api(`/api/documents?${params}`);
  renderDocuments();
}

function renderDocuments() {
  const list = $("#document-list");
  $("#library-count").textContent = state.documents.length;
  $("#document-empty").hidden = state.documents.length > 0;
  list.innerHTML = "";
  state.documents.forEach((document) => {
    const row = document;
    const button = documentNode("button", "document-row");
    button.type = "button";
    button.innerHTML = `
      <span class="document-title"><strong>${escapeHtml(row.title)}</strong><small>${escapeHtml(row.id)}</small></span>
      <span class="category-tag">${escapeHtml(row.category)}</span>
      <span class="document-stat">${Number(row.word_count || 0).toLocaleString("ko-KR")} 단어</span>
      <span class="document-stat">${formatDate(row.created_at)}</span>
      <span class="document-arrow">›</span>`;
    button.addEventListener("click", () => openDocument(row.id));
    list.appendChild(button);
  });
}

function documentNode(tag, className) {
  const node = window.document.createElement(tag);
  node.className = className;
  return node;
}

async function openDocument(id) {
  try {
    const document = await api(`/api/documents/${encodeURIComponent(id)}`);
    state.currentDocument = document;
    $("#preview-title").textContent = document.title;
    $("#preview-category").textContent = document.category;
    $("#preview-content").textContent = document.content;
    $("#preview-truncated").hidden = !document.truncated;
    $("#download-link").href = runtimeMode === "browser"
      ? window.browserVault.downloadUrl(document)
      : apiUrl(`/api/documents/${encodeURIComponent(id)}/download`);
    $("#download-link").download = `${document.title || "document"}.md`;
    $("#move-category").value = document.category;
    $("#preview-meta").innerHTML = [
      `변환 ${formatDate(document.created_at)}`,
      `${Number(document.word_count || 0).toLocaleString("ko-KR")} 단어`,
      formatBytes(document.size_bytes),
      document.provider === "none" ? "LOCAL" : String(document.provider).toUpperCase(),
      document.model || document.engine,
    ].map((item) => `<span>${escapeHtml(item)}</span>`).join("");
    $("#preview-dialog").showModal();
  } catch (error) {
    toast(error.message, true);
  }
}

async function moveCurrentDocument() {
  if (!state.currentDocument) return;
  const category = $("#move-category").value;
  try {
    await api(`/api/documents/${encodeURIComponent(state.currentDocument.id)}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category }),
    });
    state.currentDocument.category = category;
    $("#preview-category").textContent = category;
    await Promise.all([loadCategories(category), loadDocuments()]);
    toast(`문서를 ${category}(으)로 이동했습니다.`);
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadJobs() {
  state.jobs = await api("/api/jobs");
  $("#jobs-empty").hidden = state.jobs.length > 0;
  $("#jobs-list").innerHTML = state.jobs.map((job) => renderJob(job)).join("");
  state.jobs.filter((job) => !terminalStates.has(job.status)).forEach((job) => pollJob(job.id));
}

async function createCategory(event) {
  event.preventDefault();
  const name = $("#new-category-name").value.trim();
  if (!name) return;
  try {
    const created = await api("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await loadCategories(created.category);
    $("#category-select").value = created.category;
    $("#move-category").value = created.category;
    $("#new-category-name").value = "";
    $("#category-dialog").close();
    toast(categoryDialogSource === "move"
      ? `${created.category} 카테고리를 만들고 이동 대상으로 선택했습니다.`
      : `${created.category} 카테고리를 만들었습니다.`);
    categoryDialogSource = "convert";
  } catch (error) {
    toast(error.message, true);
  }
}

function openCategoryDialog(source = "convert") {
  categoryDialogSource = source;
  $("#new-category-name").value = "";
  $("#category-dialog").showModal();
  requestAnimationFrame(() => $("#new-category-name").focus());
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
  $("#go-convert").addEventListener("click", () => setView("convert"));
  $("#refresh-all").addEventListener("click", async () => {
    try {
      await Promise.all([loadStatus(), loadCategories(), loadDocuments(), loadJobs()]);
      toast("최신 상태로 갱신했습니다.");
    } catch (error) { toast(error.message, true); }
  });
  $("#open-companion-guide").addEventListener("click", () => $("#companion-dialog").showModal());
  $("#retry-connection").addEventListener("click", startAndConnectCompanion);
  $("#file-input").addEventListener("change", (event) => addFiles(event.target.files));
  const dropzone = $("#dropzone");
  ["dragenter", "dragover"].forEach((name) => dropzone.addEventListener(name, (event) => {
    event.preventDefault(); dropzone.classList.add("dragging");
  }));
  ["dragleave", "drop"].forEach((name) => dropzone.addEventListener(name, (event) => {
    event.preventDefault(); dropzone.classList.remove("dragging");
  }));
  dropzone.addEventListener("drop", (event) => addFiles(event.dataTransfer.files));
  $$("input[name='provider']").forEach((radio) => radio.addEventListener("change", updateProviderPanel));
  $("#engine-select").addEventListener("change", updateEngineUi);
  $("#save-api-key").addEventListener("click", saveCurrentApiKey);
  $("#delete-api-key").addEventListener("click", deleteCurrentApiKey);
  $("#convert-form").addEventListener("submit", submitConversion);
  $("#open-category-dialog").addEventListener("click", () => openCategoryDialog("convert"));
  $("#open-move-category-dialog").addEventListener("click", () => openCategoryDialog("move"));
  $("#category-form").addEventListener("submit", createCategory);
  $("#close-preview").addEventListener("click", () => $("#preview-dialog").close());
  $("#move-document").addEventListener("click", moveCurrentDocument);
  $("#library-category").addEventListener("change", loadDocuments);
  let searchTimer;
  $("#search-input").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadDocuments().catch((error) => toast(error.message, true)), 260);
  });
  $("#copy-vault").addEventListener("click", async () => {
    if (runtimeMode === "browser") {
      toast("문서는 이 브라우저의 로컬 문서함에 저장됩니다.");
      return;
    }
    try {
      await navigator.clipboard.writeText(state.status.vault);
      toast("로컬 저장 경로를 복사했습니다.");
    } catch { toast(state.status.vault); }
  });
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const register = (tool) => {
    try {
      Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});
    } catch { /* Unsupported preview implementations may reject registration. */ }
  };

  register({
    name: "read_mark_vault_status",
    title: "Read MarkItDown Vault status",
    description: "Read the local MarkItDown engine, vault location, document count, and provider availability without exposing API keys.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    async execute() {
      const result = await api("/api/status");
      await loadStatus();
      return result;
    },
  });

  register({
    name: "search_markdown_vault",
    title: "Search Markdown vault",
    description: "Search stored Markdown documents by title and body text. Optionally narrow to one category.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        category: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    async execute(input) {
      const query = String(input?.query || "").trim();
      if (!query) throw new Error("query is required");
      const params = new URLSearchParams({ q: query, limit: String(input.limit || 20) });
      if (input.category) params.set("category", String(input.category));
      return api(`/api/search?${params}`);
    },
  });

  register({
    name: "create_vault_category",
    title: "Create vault category",
    description: "Create a local category, including nested categories written as parent/child.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      const name = String(input?.name || "").trim();
      if (!name) throw new Error("name is required");
      const result = await api("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await loadCategories(result.category);
      return result;
    },
  });

  register({
    name: "move_vault_document",
    title: "Move vault document",
    description: "Move one stored Markdown document to a different local category.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", minLength: 1 },
        category: { type: "string", minLength: 1 },
      },
      required: ["documentId", "category"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      const documentId = String(input?.documentId || "").trim();
      const category = String(input?.category || "").trim();
      if (!documentId || !category) throw new Error("documentId and category are required");
      const result = await api(`/api/documents/${encodeURIComponent(documentId)}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      });
      await Promise.all([loadCategories(category), loadDocuments()]);
      return { id: result.id, title: result.title, category: result.category };
    },
  });

  window.addEventListener("beforeunload", () => lifecycle.abort(), { once: true });
}

async function initialize() {
  bindEvents();
  registerWebMcpTools();
  try {
    await detectRuntime();
    await Promise.all([loadStatus(), loadCategories(), loadDocuments(), loadJobs()]);
  } catch (error) {
    $("#local-status").lastChild.textContent = " 연결 실패";
    $("#companion-banner").hidden = false;
    toast(error.message, true);
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

initialize();
