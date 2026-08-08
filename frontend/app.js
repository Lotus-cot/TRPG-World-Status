const STORAGE_KEY = "trpg-world-status:last-snapshot";
const WAITING_TEXT = "Waiting for generation";
const API_BASE = window.location.protocol === "file:" ? "http://127.0.0.1:8000" : "";
const IS_NETLIFY_HOST = /(^|\.)netlify\.app$/i.test(window.location.hostname);

const snowfield = document.querySelector("#snowfield");
const sourceText = document.querySelector("#sourceText");
const fileInput = document.querySelector("#fileInput");
const maxChars = document.querySelector("#maxChars");
const characterRoster = document.querySelector("#characterRoster");
const runButton = document.querySelector("#runButton");
const analyzeCharactersButton = document.querySelector("#analyzeCharactersButton");
const copyButton = document.querySelector("#copyButton");
const output = document.querySelector("#output");
const worldViewDescription = document.querySelector("#worldViewDescription");
const worldViewButtons = document.querySelectorAll("[data-world-view]");
const resolvedOutput = document.querySelector("#resolvedOutput");
const meta = document.querySelector("#meta");
const health = document.querySelector("#health");
const saveStatus = document.querySelector("#saveStatus");
const storageNotice = document.querySelector("#storageNotice");
const saveButton = document.querySelector("#saveButton");
const loadButton = document.querySelector("#loadButton");
const clearButton = document.querySelector("#clearButton");
const downloadJsonButton = document.querySelector("#downloadJsonButton");
const downloadTxtButton = document.querySelector("#downloadTxtButton");
const graphFileInput = document.querySelector("#graphFileInput");
const actsOutput = document.querySelector("#actsOutput");
const actsCount = document.querySelector("#actsCount");
const downloadActsButton = document.querySelector("#downloadActsButton");
const downloadGraphButton = document.querySelector("#downloadGraphButton");
const downloadInteractiveGraphButton = document.querySelector("#downloadInteractiveGraphButton");
const characterStages = document.querySelector("#characterStages");
const characterOutput = document.querySelector("#characterOutput");
const characterCount = document.querySelector("#characterCount");
const downloadCharactersButton = document.querySelector("#downloadCharactersButton");

let currentWorldState = null;
let currentModel = "";
let currentUsage = null;
let currentCharacterResolution = null;
let lastSavedAt = "";
let noticeTimer = null;
let activeWorldView = "full";
let isBusy = false;
let modelReady = false;
let cloudDeployment = IS_NETLIFY_HOST;

const WORLD_VIEWS = {
  full: {
    label: "Full JSON",
    fields: null,
  },
  micro: {
    label: "Micro: characters and narrative objects/clues",
    fields: ["characters", "items"],
  },
  meso: {
    label: "Meso: locations, collective agents, and social relations",
    fields: ["locations", "factions", "relationships"],
  },
  macro: {
    label: "Macro: narrative events, quests, and open threads",
    fields: ["acts", "timeline", "quests", "open_threads"],
  },
  context: {
    label: "Global context: atmosphere and current scene state",
    fields: ["context_variables"],
  },
};

function previewResponseText(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

async function readJsonResponse(response, endpointLabel = "endpoint") {
  const contentType = response.headers.get("content-type") || "";
  const bodyText = await response.text();
  const preview = previewResponseText(bodyText);

  if (!bodyText) {
    return {};
  }

  if (!contentType.toLowerCase().includes("application/json")) {
    const status = `${response.status} ${response.statusText || ""}`.trim();
    if (preview.startsWith("<")) {
      throw new Error(
        `${endpointLabel} returned HTML instead of JSON. Confirm that this page is connected to the ` +
          `World Status backend or Netlify Functions, not a static host, 404 page, or deployment fallback. HTTP ${status}`
      );
    }
    throw new Error(
      `${endpointLabel} did not return JSON (${contentType || "unknown content type"}). Preview: ${preview || "empty response"}`
    );
  }

  try {
    return JSON.parse(bodyText);
  } catch (error) {
    throw new Error(`${endpointLabel} returned invalid JSON: ${error.message}`);
  }
}

function createSnowfield() {
  if (!snowfield) {
    return;
  }

  const symbols = ["❄", "❅", "❆", "✻", "·"];
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < 78; index += 1) {
    const flake = document.createElement("span");
    const edgePosition = Math.random() < 0.7
      ? (Math.random() < 0.5 ? Math.random() * 25 : 75 + Math.random() * 25)
      : 25 + Math.random() * 50;

    flake.className = "snowflake";
    flake.textContent = symbols[Math.floor(Math.random() * symbols.length)];
    flake.style.setProperty("--snow-x", `${edgePosition.toFixed(2)}vw`);
    flake.style.setProperty("--snow-size", `${(11 + Math.random() * 17).toFixed(1)}px`);
    flake.style.setProperty("--snow-opacity", `${(0.48 + Math.random() * 0.42).toFixed(2)}`);
    flake.style.setProperty("--snow-duration", `${(10 + Math.random() * 15).toFixed(1)}s`);
    flake.style.setProperty("--snow-delay", `${(-Math.random() * 28).toFixed(1)}s`);
    flake.style.setProperty("--snow-drift", `${(-54 + Math.random() * 108).toFixed(1)}px`);
    flake.style.setProperty(
      "--snow-color",
      Math.random() < 0.55 ? "rgba(30, 92, 103, 0.72)" : "rgba(255, 255, 255, 0.96)"
    );
    fragment.appendChild(flake);
  }

  snowfield.appendChild(fragment);
}

async function checkHealth() {
  if (window.location.protocol === "file:") {
    modelReady = false;
    health.textContent = "Offline file mode · generation service disconnected";
    health.className = "status";
    setRunButtonState();
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/api/health`);
    const payload = await readJsonResponse(response, "/api/health");
    if (!response.ok) throw new Error(payload.detail || "health check failed");
    cloudDeployment = IS_NETLIFY_HOST || payload.deployment === "netlify";
    modelReady = true;
    const pipeline = payload.character_pipeline;
    const relik = pipeline?.relik?.enabled && pipeline?.relik?.installed ? "ReLiK" : "alias fallback";
    const validation = pipeline?.deepseek_validation?.configured ? "DeepSeek validation" : "local validation";
    const maverick = pipeline?.maverick?.enabled && pipeline?.maverick?.installed ? "Maverick" : "no pronoun expansion";
    health.textContent = cloudDeployment ? "Cloud generation available" : `Ready | ${relik} | ${validation} | ${maverick}`;
    health.className = "status ok";
  } catch (error) {
    modelReady = false;
    cloudDeployment = IS_NETLIFY_HOST;
    health.textContent = error.message?.includes("HTML") ? "API route error" : "Service unavailable";
    health.className = "status error";
  }
  setRunButtonState();
}

function setBusy(busy) {
  isBusy = busy;
  setRunButtonState();
}

function setRunButtonState() {
  runButton.disabled = isBusy || !modelReady;
  analyzeCharactersButton.disabled = isBusy || !modelReady || cloudDeployment;
  analyzeCharactersButton.title = cloudDeployment
    ? "Full character analysis requires the local FastAPI backend."
    : "Run character linking without calling DeepSeek.";
  if (isBusy) {
    runButton.textContent = "Generating...";
  } else if (window.location.protocol === "file:") {
    runButton.textContent = "Open through the local service to generate";
  } else if (!modelReady) {
    runButton.textContent = "Waiting for service";
  } else {
    runButton.textContent = "Generate English World Status";
  }
}

function getVisibleWorldState() {
  if (!currentWorldState || typeof currentWorldState !== "object") {
    return {};
  }

  const view = WORLD_VIEWS[activeWorldView];
  if (!view || !view.fields) {
    return currentWorldState;
  }

  return Object.fromEntries(
    view.fields.map((field) => [field, currentWorldState[field] ?? emptyValueForField(field)])
  );
}

function emptyValueForField(field) {
  return field === "context_variables" ? {} : [];
}

function renderWorldState() {
  output.textContent = JSON.stringify(getVisibleWorldState(), null, 2);
  const view = WORLD_VIEWS[activeWorldView] || WORLD_VIEWS.full;
  worldViewDescription.textContent = `Current view: ${view.label}`;

  worldViewButtons.forEach((button) => {
    const isActive = button.dataset.worldView === activeWorldView;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function renderGraph() {
  window.WorldGraph?.render(currentWorldState);
}

function renderGame() {
  window.WorldGame?.setWorldState(currentWorldState);
}

function renderCharacterResolution() {
  if (!characterStages || !characterOutput || !characterCount) return;
  const result = currentCharacterResolution;
  const stages = Array.isArray(result?.stages) ? result.stages : [];
  const characters = Array.isArray(result?.characters) ? result.characters : [];
  characterStages.replaceChildren();
  characterOutput.replaceChildren();
  characterCount.textContent = characters.length
    ? `${characters.length} linked characters · ${result.window_count || 0} windows`
    : "Waiting for character data";

  stages.forEach((stage) => {
    const card = document.createElement("article");
    card.className = "character-stage";
    const title = document.createElement("strong");
    title.textContent = String(stage.name || "pipeline stage").replaceAll("_", " ");
    const status = document.createElement("span");
    status.textContent = stage.status || "unknown";
    const detail = document.createElement("small");
    detail.textContent = [
      stage.engine,
      Number.isFinite(stage.characters) ? `${stage.characters} characters` : "",
      Number.isFinite(stage.mentions) ? `${stage.mentions} mentions` : "",
      stage.reason,
    ].filter(Boolean).join(" · ");
    card.append(title, status, detail);
    characterStages.appendChild(card);
  });

  if (!characters.length) {
    const empty = document.createElement("p");
    empty.className = "character-empty";
    empty.textContent = "Provide a roster or generate from an English narrative to inspect character clusters.";
    characterOutput.appendChild(empty);
    return;
  }

  characters.forEach((character) => {
    const card = document.createElement("article");
    card.className = "character-cluster";
    const title = document.createElement("h3");
    title.textContent = character.name || character.id;
    const aliases = document.createElement("p");
    aliases.textContent = `Aliases: ${(character.aliases || []).join(", ") || "none"}`;
    const mentions = document.createElement("p");
    const examples = [...new Set((character.mentions || []).map((item) => item.text).filter(Boolean))].slice(0, 8);
    mentions.textContent = `${character.mention_count || 0} mentions · ${examples.join(" · ")}`;
    card.append(title, aliases, mentions);
    characterOutput.appendChild(card);
  });
}

function appendActDetail(container, label, value) {
  if (value === undefined || value === null || value === "") return;
  if (Array.isArray(value) && value.length === 0) return;

  const block = document.createElement("div");
  block.className = "act-detail";
  const heading = document.createElement("strong");
  heading.textContent = label;
  block.appendChild(heading);

  if (Array.isArray(value)) {
    const list = document.createElement("ul");
    value.forEach((item) => {
      const entry = document.createElement("li");
      entry.textContent = typeof item === "string" ? item : JSON.stringify(item);
      list.appendChild(entry);
    });
    block.appendChild(list);
  } else {
    const paragraph = document.createElement("p");
    paragraph.textContent = typeof value === "string" ? value : JSON.stringify(value);
    block.appendChild(paragraph);
  }
  container.appendChild(block);
}

function renderActs() {
  if (!actsOutput || !actsCount) return;
  const acts = Array.isArray(currentWorldState?.acts) ? currentWorldState.acts : [];
  actsOutput.replaceChildren();
  actsCount.textContent = acts.length ? `${acts.length} acts` : "Waiting for acts";

  if (!acts.length) {
    const empty = document.createElement("p");
    empty.className = "acts-empty";
    empty.textContent = "Generated World Status acts and detailed scenes will appear here.";
    actsOutput.appendChild(empty);
    return;
  }

  acts.forEach((act, actIndex) => {
    const article = document.createElement("article");
    article.className = "act-card";
    const header = document.createElement("header");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = `Act ${act.act_number || actIndex + 1}`;
    const title = document.createElement("h3");
    title.textContent = act.title || `Untitled Act ${actIndex + 1}`;
    header.append(eyebrow, title);
    article.appendChild(header);

    appendActDetail(article, "Dramatic Purpose", act.dramatic_purpose);
    appendActDetail(article, "Opening State", act.opening_state);

    (Array.isArray(act.scenes) ? act.scenes : []).forEach((scene, sceneIndex) => {
      const sceneCard = document.createElement("section");
      sceneCard.className = "scene-card";
      const sceneTitle = document.createElement("h4");
      sceneTitle.textContent = `Scene ${sceneIndex + 1} · ${scene.title || "Untitled Scene"}`;
      sceneCard.appendChild(sceneTitle);
      appendActDetail(sceneCard, "Location / Time", [scene.location, scene.time].filter(Boolean));
      appendActDetail(sceneCard, "Participants", scene.participants);
      appendActDetail(sceneCard, "Objective", scene.objective);
      appendActDetail(sceneCard, "Beats", scene.beats);
      appendActDetail(sceneCard, "Conflict", scene.conflict);
      appendActDetail(sceneCard, "Discoveries", scene.discoveries);
      appendActDetail(sceneCard, "Player Choices", scene.player_choices);
      appendActDetail(sceneCard, "Consequences", scene.consequences);
      appendActDetail(sceneCard, "Transition", scene.transition);
      article.appendChild(sceneCard);
    });

    appendActDetail(article, "Character Changes", act.character_changes);
    appendActDetail(article, "Clues Revealed", act.clues_revealed);
    appendActDetail(article, "Unresolved Threads", act.unresolved_threads);
    appendActDetail(article, "Closing State", act.closing_state);
    appendActDetail(article, "Next-Act Hook", act.next_act_hook);
    actsOutput.appendChild(article);
  });
}

function setWorldView(viewName) {
  if (!WORLD_VIEWS[viewName]) return;
  activeWorldView = viewName;
  renderWorldState();
}

function hasGeneratedContent() {
  return Boolean(sourceText.value.trim() || resolvedOutput.textContent.trim() || currentWorldState);
}

function readStoredSnapshot() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function updateStorageControls() {
  const storedSnapshot = readStoredSnapshot();
  saveButton.disabled = !hasGeneratedContent();
  loadButton.disabled = !storedSnapshot;
  clearButton.disabled = !storedSnapshot && !hasGeneratedContent();
  downloadJsonButton.disabled = !currentWorldState;
  downloadTxtButton.disabled = !resolvedOutput.textContent.trim() || resolvedOutput.textContent === WAITING_TEXT;
  downloadActsButton.disabled = !Array.isArray(currentWorldState?.acts) || currentWorldState.acts.length === 0;
  downloadGraphButton.disabled = !currentWorldState;
  downloadInteractiveGraphButton.disabled = !currentWorldState;
  downloadCharactersButton.disabled = !currentCharacterResolution;

  if (lastSavedAt) {
    saveStatus.textContent = `Last saved: ${formatDate(lastSavedAt)}`;
  } else if (storedSnapshot) {
    saveStatus.textContent = "A snapshot is available in this browser.";
  } else {
    saveStatus.textContent = "No saved snapshot.";
  }
}

function showStorageNotice(message, type = "info", timeout = 4500) {
  storageNotice.textContent = message;
  storageNotice.className = `notice ${type}`;
  storageNotice.hidden = false;

  if (noticeTimer) {
    window.clearTimeout(noticeTimer);
  }

  noticeTimer = window.setTimeout(() => {
    storageNotice.hidden = true;
    noticeTimer = null;
  }, timeout);
}

function buildSnapshot(savedAt = new Date().toISOString()) {
  return {
    sourceText: sourceText.value,
    characterRoster: characterRoster?.value || "",
    resolvedText: resolvedOutput.textContent,
    characterResolution: currentCharacterResolution,
    worldState: currentWorldState,
    maxChars: Number(maxChars.value || 1200),
    model: currentModel,
    usage: currentUsage,
    savedAt,
  };
}

function saveSnapshot() {
  const savedAt = new Date().toISOString();
  const snapshot = buildSnapshot(savedAt);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    lastSavedAt = savedAt;
    updateStorageControls();
    showStorageNotice("Saved locally. You can reopen this same browser page and use Load Last.", "success");
  } catch {
    showStorageNotice(
      "Save failed: browser storage unavailable. This can happen in private browsing, restricted browser settings, or when site data is full.",
      "error",
      7000
    );
  }
}

function loadSnapshot() {
  const snapshot = readStoredSnapshot();
  if (!snapshot) return;

  sourceText.value = snapshot.sourceText || "";
  if (characterRoster) characterRoster.value = snapshot.characterRoster || "";
  resolvedOutput.textContent = snapshot.resolvedText || "";
  currentCharacterResolution = snapshot.characterResolution || null;
  currentWorldState = snapshot.worldState || null;
  renderWorldState();
  renderActs();
  renderCharacterResolution();
  renderGraph();
  renderGame();
  maxChars.value = snapshot.maxChars || 1200;
  currentModel = snapshot.model || "";
  currentUsage = snapshot.usage || null;
  lastSavedAt = snapshot.savedAt || "";
  meta.textContent = currentModel ? `Loaded snapshot · ${currentModel}` : "Loaded snapshot";
  copyButton.disabled = !currentWorldState;
  updateStorageControls();
  showStorageNotice("Loaded the last saved snapshot from this browser.", "info");
}

async function importGraphJson(file) {
  if (!file) return;
  try {
    const rawText = await file.text();
    const preview = previewResponseText(rawText);
    if (preview.startsWith("<")) {
      throw new Error(
        "The selected file is HTML, not World Status JSON. Import a Full JSON export and verify " +
          "that the generation endpoint did not return a 404, deployment error, or static home page."
      );
    }

    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      throw new Error(`The file does not contain valid JSON: ${error.message}`);
    }

    currentWorldState = payload.worldState || payload.world_state || payload;
    if (!currentWorldState || typeof currentWorldState !== "object" || Array.isArray(currentWorldState)) {
      throw new Error("No valid World Status object was found.");
    }
    sourceText.value = payload.sourceText || payload.source_text || sourceText.value;
    resolvedOutput.textContent = payload.resolvedText || payload.resolved_text || resolvedOutput.textContent;
    currentCharacterResolution = payload.characterResolution || payload.character_resolution || null;
    currentModel = payload.model || currentModel;
    currentUsage = payload.usage || currentUsage;
    activeWorldView = "full";
    renderWorldState();
    renderActs();
    renderCharacterResolution();
    renderGraph();
    renderGame();
    copyButton.disabled = false;
    updateStorageControls();
    showStorageNotice("Imported World Status JSON and rebuilt the interactive graph.", "success");
  } catch (error) {
    showStorageNotice(`JSON import failed: ${error.message}`, "error", 7000);
  } finally {
    graphFileInput.value = "";
  }
}

function clearSnapshot() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    showStorageNotice("Could not clear browser storage from this page.", "error", 7000);
    return;
  }

  sourceText.value = "";
  if (characterRoster) characterRoster.value = "";
  resolvedOutput.textContent = WAITING_TEXT;
  currentWorldState = null;
  currentCharacterResolution = null;
  activeWorldView = "full";
  renderWorldState();
  renderActs();
  renderCharacterResolution();
  renderGraph();
  renderGame();
  meta.textContent = "";
  currentModel = "";
  currentUsage = null;
  lastSavedAt = "";
  copyButton.disabled = true;
  updateStorageControls();
  showStorageNotice("Snapshot cleared from this browser.", "info");
}

function downloadFullJson() {
  const savedAt = lastSavedAt || new Date().toISOString();
  downloadFile(
    `world-status-${fileDate(savedAt)}.json`,
    JSON.stringify(buildSnapshot(savedAt), null, 2),
    "application/json"
  );
}

function downloadResolvedText() {
  const savedAt = lastSavedAt || new Date().toISOString();
  downloadFile(
    `coreference-resolved-${fileDate(savedAt)}.txt`,
    resolvedOutput.textContent,
    "text/plain;charset=utf-8"
  );
}

function downloadActs() {
  const savedAt = lastSavedAt || new Date().toISOString();
  downloadFile(
    `world-status-acts-${fileDate(savedAt)}.json`,
    JSON.stringify({ summary: currentWorldState?.summary || "", acts: currentWorldState?.acts || [] }, null, 2),
    "application/json"
  );
}

function downloadGraph() {
  const savedAt = lastSavedAt || new Date().toISOString();
  const svg = window.WorldGraph?.exportSvg();
  if (!svg) {
    showStorageNotice("The graph has not been generated and cannot be exported.", "error");
    return;
  }
  downloadFile(`world-status-graph-${fileDate(savedAt)}.svg`, svg, "image/svg+xml;charset=utf-8");
}

function downloadInteractiveGraph() {
  const savedAt = lastSavedAt || new Date().toISOString();
  const html = window.WorldGraph?.exportInteractiveHtml();
  if (!html) {
    showStorageNotice("The graph has not been generated and cannot be exported.", "error");
    return;
  }
  downloadFile(`world-status-graph-${fileDate(savedAt)}.html`, html, "text/html;charset=utf-8");
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function fileDate(value) {
  return value.replace(/[:.]/g, "-").slice(0, 19);
}

function downloadCharacters() {
  if (!currentCharacterResolution) return;
  const savedAt = lastSavedAt || new Date().toISOString();
  downloadFile(
    `world-status-characters-${fileDate(savedAt)}.json`,
    JSON.stringify(currentCharacterResolution, null, 2),
    "application/json"
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function parseCharacterRoster() {
  return String(characterRoster?.value || "")
    .split(/\r?\n|,/)
    .map((name) => name.trim())
    .filter(Boolean);
}

async function analyzeCharacters() {
  const text = sourceText.value.trim();
  if (!text) {
    output.textContent = "Enter an English narrative first.";
    return;
  }
  setBusy(true);
  currentCharacterResolution = null;
  renderCharacterResolution();
  resolvedOutput.textContent = "Analyzing English character mentions...";
  try {
    const response = await fetch(`${API_BASE}/api/characters`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        max_chars: Number(maxChars.value || 1200),
        character_names: parseCharacterRoster(),
      }),
    });
    const payload = await readJsonResponse(response, "/api/characters");
    if (!response.ok) throw new Error(payload.detail || `Character analysis failed (HTTP ${response.status})`);
    currentCharacterResolution = payload;
    resolvedOutput.textContent = payload.annotated_text || text;
    meta.textContent = `${payload.roster_size || 0} roster entries · ${payload.window_count || 0} windows · English`;
    renderCharacterResolution();
    updateStorageControls();
  } catch (error) {
    resolvedOutput.textContent = `Character analysis failed: ${error.message}`;
  } finally {
    setBusy(false);
  }
}

async function requestWorldStatePart(body, label, retryCount = 0) {
  try {
    const response = await fetch(`${API_BASE}/api/world-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await readJsonResponse(response, label);
    if (!response.ok) {
      const requestError = new Error(payload.detail || `Request failed (HTTP ${response.status})`);
      requestError.status = response.status;
      throw requestError;
    }
    return payload;
  } catch (error) {
    const retryable = /HTTP 50[234]|timed?\s*out/i.test(error.message || "");
    if (retryable && retryCount < 1) {
      await wait(1500);
      return requestWorldStatePart({ ...body, compact_retry: true }, label, retryCount + 1);
    }
    throw error;
  }
}

function createGenerationJobId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `job-${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

async function requestCloudWorldStatePart(body, label, retryCount = 0) {
  const jobId = createGenerationJobId();
  try {
    const startResponse = await fetch("/api/world-state-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, job_id: jobId }),
    });
    if (startResponse.status !== 202 && !startResponse.ok) {
      const payload = await readJsonResponse(startResponse, `${label} background job`);
      throw new Error(payload.detail || `Background job submission failed (HTTP ${startResponse.status})`);
    }

    const deadline = Date.now() + 14 * 60 * 1000;
    while (Date.now() < deadline) {
      await wait(2000);
      const resultResponse = await fetch(`/api/world-state-result?job_id=${encodeURIComponent(jobId)}`, {
        headers: { "Cache-Control": "no-cache" },
      });
      const payload = await readJsonResponse(resultResponse, `${label} result poll`);
      if (resultResponse.status === 202) continue;
      if (!resultResponse.ok) throw new Error(payload.detail || `Result polling failed (HTTP ${resultResponse.status})`);
      if (payload.status === "completed" && payload.result) {
        fetch(`/api/world-state-result?job_id=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
        return payload.result;
      }
    }
    throw new Error("Cloud generation exceeded 14 minutes and polling has stopped.");
  } catch (error) {
    if (retryCount < 1) {
      await wait(1200);
      return requestCloudWorldStatePart({ ...body, compact_retry: true }, label, retryCount + 1);
    }
    throw error;
  }
}

async function generateWorldState(text, maxChunkChars, characterNames = []) {
  if (!cloudDeployment) {
    try {
      return await requestWorldStatePart({
        text,
        max_chars: maxChunkChars,
        character_names: characterNames,
      }, "/api/world-state");
    } catch (error) {
      const requiresChunking = error.status === 413 || /Cloud input is too long/i.test(error.message || "");
      if (!requiresChunking) throw error;
      cloudDeployment = true;
      return generateWorldState(text, maxChunkChars, characterNames);
    }
  }

  const client = window.WorldStateClient;
  if (!client) throw new Error("The cloud chunking module is unavailable. Hard-refresh the page and try again.");
  const chunks = client.splitNarrativeText(text, maxChunkChars);
  if (!chunks.length) throw new Error("No narrative text is available for generation.");

  const payloads = new Array(chunks.length);
  let nextIndex = 0;
  let completed = 0;
  async function generateNextChunk() {
    while (nextIndex < chunks.length) {
      const index = nextIndex;
      nextIndex += 1;
      const position = index + 1;
      output.textContent = `Cloud generation: ${completed}/${chunks.length} completed; processing chunk ${position}...`;
      payloads[index] = await requestCloudWorldStatePart({
        text: chunks[index],
        max_chars: maxChunkChars,
        cloud_chunked: true,
        chunk_index: position,
        chunk_count: chunks.length,
        character_names: characterNames,
      }, `/api/world-state (chunk ${position}/${chunks.length})`);
      completed += 1;
      runButton.textContent = `Completed ${completed}/${chunks.length}`;
    }
  }
  const concurrency = Math.min(2, chunks.length);
  await Promise.all(Array.from({ length: concurrency }, () => generateNextChunk()));
  return client.mergeWorldStatePayloads(payloads, text);
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  sourceText.value = await file.text();
  updateStorageControls();
});

sourceText.addEventListener("input", updateStorageControls);
characterRoster?.addEventListener("input", updateStorageControls);
analyzeCharactersButton.addEventListener("click", analyzeCharacters);
maxChars.addEventListener("input", updateStorageControls);
saveButton.addEventListener("click", saveSnapshot);
loadButton.addEventListener("click", loadSnapshot);
clearButton.addEventListener("click", clearSnapshot);
downloadJsonButton.addEventListener("click", downloadFullJson);
downloadTxtButton.addEventListener("click", downloadResolvedText);
downloadActsButton.addEventListener("click", downloadActs);
downloadCharactersButton.addEventListener("click", downloadCharacters);
downloadGraphButton.addEventListener("click", downloadGraph);
downloadInteractiveGraphButton.addEventListener("click", downloadInteractiveGraph);
graphFileInput.addEventListener("change", () => importGraphJson(graphFileInput.files?.[0]));
worldViewButtons.forEach((button) => {
  button.addEventListener("click", () => setWorldView(button.dataset.worldView));
});

runButton.addEventListener("click", async () => {
  const text = sourceText.value.trim();
  if (!text) {
    output.textContent = "Enter an English narrative first.";
    return;
  }

  setBusy(true);
  copyButton.disabled = true;
  currentWorldState = null;
  currentCharacterResolution = null;
  currentModel = "";
  currentUsage = null;
  output.textContent = cloudDeployment
    ? "Splitting the English source and generating through Netlify background functions. Keep this page open..."
    : "Building the roster, linking explicit mentions, validating identities, expanding coreference windows, and generating World Status...";
  resolvedOutput.textContent = "Processing English text...";
  meta.textContent = "";
  renderGame();
  renderCharacterResolution();
  updateStorageControls();

  try {
    const payload = await generateWorldState(
      text,
      Number(maxChars.value || 1200),
      parseCharacterRoster()
    );

    currentWorldState = payload.world_state;
    currentCharacterResolution = payload.character_resolution || null;
    currentModel = payload.model || "";
    currentUsage = payload.usage || null;
    activeWorldView = "full";
    renderWorldState();
    renderActs();
    renderCharacterResolution();
    renderGraph();
    renderGame();
    resolvedOutput.textContent = payload.resolved_text || "";
    meta.textContent = payload.cloud_chunked
      ? `${payload.cloud_chunk_count} cloud chunks · merged · ${payload.model}`
      : `${payload.character_resolution?.window_count || 0} coreference windows · ${payload.resolved_chunks.length} generation chunks · ${payload.model}`;
    copyButton.disabled = false;
    saveSnapshot();
  } catch (error) {
    output.textContent = `Generation failed: ${error.message}`;
    resolvedOutput.textContent = "No result";
  } finally {
    setBusy(false);
    updateStorageControls();
  }
});

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(output.textContent);
  copyButton.textContent = "Copied";
  window.setTimeout(() => {
    copyButton.textContent = "Copy Current View";
  }, 1200);
});

const initialSnapshot = readStoredSnapshot();
if (initialSnapshot) {
  lastSavedAt = initialSnapshot.savedAt || "";
}
updateStorageControls();
renderWorldState();
renderActs();
renderCharacterResolution();
renderGraph();
window.WorldGame?.mount();
renderGame();
createSnowfield();
checkHealth();
if (window.location.protocol !== "file:") {
  window.setInterval(checkHealth, 5000);
}
