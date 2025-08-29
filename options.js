// options.js - v0.9.0
const defaults = {
  apiKey: "",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o-mini",
  temperature: 0.2,
  timeoutMs: 45000,
  replyMode: "agent",
  systemPrompt: ""
};

function restore(){
  chrome.storage.sync.get(defaults, (cfg) => {
    document.getElementById("apiKey").value = cfg.apiKey || "";
    document.getElementById("baseUrl").value = cfg.baseUrl || defaults.baseUrl;
    document.getElementById("model").value = cfg.model || defaults.model;
    document.getElementById("temperature").value = String(cfg.temperature ?? defaults.temperature);
    document.getElementById("timeoutMs").value = String(cfg.timeoutMs ?? defaults.timeoutMs);
    document.getElementById("replyMode").value = (cfg.replyMode === "user") ? "user" : "agent";
    document.getElementById("systemPrompt").value = cfg.systemPrompt || "";
  });
}

function save(){
  const status = document.getElementById("status");
  const apiKey = document.getElementById("apiKey").value.trim();
  const baseUrl = document.getElementById("baseUrl").value.trim();
  const model = document.getElementById("model").value.trim() || defaults.model;
  const temperature = parseFloat(document.getElementById("temperature").value) || defaults.temperature;
  const timeoutMs = parseInt(document.getElementById("timeoutMs").value, 10) || defaults.timeoutMs;
  const replyMode = document.getElementById("replyMode").value === "user" ? "user" : "agent";
  const systemPrompt = document.getElementById("systemPrompt").value;

  chrome.storage.sync.set({ apiKey, baseUrl, model, temperature, timeoutMs, replyMode, systemPrompt }, () => {
    status.textContent = "Saved.";
    setTimeout(() => status.textContent = "", 1500);
  });
}

function testKey(){
  const testResult = document.getElementById("testResult");
  testResult.textContent = "Testing...";
  chrome.runtime.sendMessage({ type:"pingLLM" }, (resp) => {
    if (!resp){ testResult.textContent = "No response from background service."; return; }
    if (!resp.ok){ testResult.textContent = "Error: " + (resp.error || "unknown"); return; }
    const ok = (resp.content || "").trim().toUpperCase().includes("OK");
    testResult.textContent = ok ? "OK – API key and endpoint working." : ("Response: " + (resp.content || "(empty)"));
  });
}

document.addEventListener("DOMContentLoaded", restore);
document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", testKey);
