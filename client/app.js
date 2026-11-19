const API_BASE = "http://localhost:8000";
const STORAGE_KEY = "chatbot.history.v1";

const chatLog   = document.getElementById("chat-log");
const chatForm  = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn   = document.getElementById("send-btn");
const stopBtn   = document.getElementById("stop-btn");
const clearBtn  = document.getElementById("clear-btn");
const modelSel  = document.getElementById("model-select");
const tempInput = document.getElementById("temperature");
const tempValue = document.getElementById("temperature-value");
const attachBtn = document.getElementById("attach-btn");
const imageInput = document.getElementById("image-input");
const imagePreview = document.getElementById("image-preview");

// [{ role: "user"|"assistant", content: "...", images?: string[] }, ...]
let history = loadHistory();
let controller = null;
/** @type {{ id: string, name: string, base64: string, dataUrl: string }[]} */
let pendingImages = [];

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch (e) {
    console.warn("Could not save history:", e);
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
function stripDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function renderPendingImages() {
  imagePreview.innerHTML = "";
  if (pendingImages.length === 0) {
    imagePreview.hidden = true;
    return;
  }

  imagePreview.hidden = false;
  for (const img of pendingImages) {
    const chip = document.createElement("div");
    chip.className = "image-chip";

    const thumb = document.createElement("img");
    thumb.src = img.dataUrl;
    thumb.alt = img.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "image-chip-remove";
    remove.setAttribute("aria-label", `Remove ${img.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pendingImages = pendingImages.filter((p) => p.id !== img.id);
      renderPendingImages();
    });

    chip.appendChild(thumb);
    chip.appendChild(remove);
    imagePreview.appendChild(chip);
  }
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    pendingImages.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      dataUrl,
      base64: stripDataUrl(dataUrl),
    });
  }
  renderPendingImages();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function addMessage(role, text, images = []) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;

  if (images && images.length > 0) {
    const grid = document.createElement("div");
    grid.className = "msg-images";
    for (const b64 of images) {
      const img = document.createElement("img");
      img.src = b64.startsWith("data:") ? b64 : `data:image/*;base64,${b64}`;
      img.alt = "Attached";
      grid.appendChild(img);
    }
    div.appendChild(grid);
  }

  const textEl = document.createElement("div");
  textEl.className = "msg-text";
  textEl.textContent = text;
  div.appendChild(textEl);

  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return { root: div, textEl };
}

function renderHistory() {
  chatLog.innerHTML = "";
  for (const m of history) {
    if (m.role === "system") continue;
    addMessage(m.role, m.content, m.images || []);
  }
}

// ---------------------------------------------------------------------------
// Pack the full conversation into a single string for the backend,
// which only accepts a single Message { model, role, content, stream }.
// ---------------------------------------------------------------------------
function buildConversationString() {
  const lines = ["[Conversation so far]", ""];

  for (const m of history) {
    const content = (m.content || "").trim();
    if (!content) continue;

    if (m.role === "user") {
      lines.push(`User: ${content}`);
      if (m.images && m.images.length) {
        lines.push(`(User attached ${m.images.length} image(s) with this message.)`);
      }
    } else if (m.role === "assistant") {
      if (content.endsWith("[stopped]")) {
        const partial = content.slice(0, -"[stopped]".length).trim();
        if (partial) {
          lines.push(`Assistant: ${partial}`);
          lines.push("(Note: this response was interrupted by the user.)");
        } else {
          lines.push(
            "Assistant: (no response was produced — the user interrupted before any text appeared.)"
          );
        }
      } else {
        lines.push(`Assistant: ${content}`);
      }
    } else if (m.role === "system") {
      lines.push(`System: ${content}`);
    }
    lines.push("");
  }

  lines.push(
    "Do not summarize the conversation. Answer only the latest User message above, " +
    "using the earlier turns as context."
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
async function loadModels() {
  try {
    const res = await fetch(`${API_BASE}/models`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const names = await res.json();

    modelSel.innerHTML = "";
    if (names.length === 0) {
      modelSel.innerHTML = `<option value="">No models</option>`;
      return;
    }
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      modelSel.appendChild(opt);
    }
  } catch (e) {
    modelSel.innerHTML = `<option value="">Failed to load</option>`;
    console.error(e);
  }
}

// ---------------------------------------------------------------------------
// Send (streaming)
// ---------------------------------------------------------------------------
async function sendMessage(text, model, images) {
  controller = new AbortController();
  sendBtn.disabled = true;
  chatInput.disabled = true;
  attachBtn.disabled = true;
  imageInput.disabled = true;
  stopBtn.disabled = false;

  const temperature = Number(tempInput.value);

  history.push({ role: "user", content: text, images: images.length ? images : undefined });
  saveHistory();
  addMessage("user", text, images);

  const thinking = addMessage("thinking", "Thinking...");
  let assistantEl = null;
  let assistantText = "";

  try {
    const body = {
      model,
      role: "user",
      content: buildConversationString(),
      stream: true,
      temperature,
      images,
    };

    const res = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

    thinking.root.remove();
    assistantEl = addMessage("assistant", "");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let partial = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      partial += decoder.decode(value, { stream: true });
      const lines = partial.split("\n");
      partial = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        if (obj.error) throw new Error(obj.error);
        if (obj.message?.content) {
          assistantText += obj.message.content;
          assistantEl.textEl.textContent = assistantText;
          chatLog.scrollTop = chatLog.scrollHeight;
        }
        if (obj.done) {
          finishAssistant(assistantText);
          return;
        }
      }
    }

    finishAssistant(assistantText);
  } catch (err) {
    if (err.name === "AbortError") {
      if (assistantEl) {
        assistantEl.textEl.textContent = assistantText
          ? `${assistantText} [stopped]`
          : "[stopped]";
      }
      if (assistantText) {
        history.push({ role: "assistant", content: `${assistantText} [stopped]` });
        saveHistory();
      }
    } else {
      if (assistantEl) assistantEl.textEl.textContent = `Error: ${err.message}`;
      else thinking.textEl.textContent = `Error: ${err.message}`;
    }
  } finally {
    controller = null;
    sendBtn.disabled = false;
    chatInput.disabled = false;
    attachBtn.disabled = false;
    imageInput.disabled = false;
    stopBtn.disabled = true;
    chatInput.focus();
  }
}

function finishAssistant(text) {
  if (!text) return;
  history.push({ role: "assistant", content: text });
  saveHistory();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
tempInput.addEventListener("input", () => {
  tempValue.textContent = Number(tempInput.value).toFixed(1);
});

attachBtn.addEventListener("click", () => imageInput.click());

imageInput.addEventListener("change", async () => {
  try {
    await addFiles(imageInput.files);
  } catch (e) {
    console.error(e);
  } finally {
    imageInput.value = "";
  }
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  const model = modelSel.value;
  if ((!text && pendingImages.length === 0) || !model || controller) return;

  const images = pendingImages.map((p) => p.base64);
  pendingImages = [];
  renderPendingImages();

  chatInput.value = "";
  sendMessage(text || "Describe the attached image(s).", model, images);
});

stopBtn.addEventListener("click", () => {
  if (controller) controller.abort();
});

clearBtn.addEventListener("click", () => {
  if (controller) controller.abort();
  history = [];
  pendingImages = [];
  saveHistory();
  renderHistory();
  renderPendingImages();
  chatInput.focus();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
tempValue.textContent = Number(tempInput.value).toFixed(1);
renderHistory();
loadModels();
