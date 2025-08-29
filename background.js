// background.js - v0.9.0
// Service worker for API communication with OpenAI-compatible endpoints
// Handles configuration management, API calls, and error recovery

const DEFAULTS = {
  apiKey: "",
  baseUrl: "https://api.openai.com",
  model: "gpt-4o-mini",
  temperature: 0.2,
  timeoutMs: 45_000,
  replyMode: "agent",
  systemPrompt: ""
};

chrome.runtime.onInstalled.addListener(() => {
  // Set only missing defaults without overwriting existing values
  chrome.storage.sync.get(DEFAULTS, (cfg) => {
    const toSet = {};
    for (const k of Object.keys(DEFAULTS)){
      if (cfg[k] === undefined) toSet[k] = DEFAULTS[k];
    }
    if (Object.keys(toSet).length){
      chrome.storage.sync.set(toSet);
    }
  });
});

function buildEndpoint(baseUrl){
  let base = (baseUrl || DEFAULTS.baseUrl).trim().replace(/\/+$/,"");
  if (/\/chat\/completions$/i.test(base)){ return base; }
  if (/\/v1$/i.test(base)){ return base + "/chat/completions"; }
  return base + "/v1/chat/completions";
}

async function callLLM({endpoint, apiKey, model, temperature, system, user, timeoutMs}){
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try{
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model, temperature,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      }),
      signal: controller.signal
    });
    const text = await res.text().catch(()=> "");
    if (!res.ok){
      const err = new Error(`LLM Error (${res.status}): ${text || res.statusText}`);
      err.status = res.status; err.body = text;
      throw err;
    }
    const data = text ? JSON.parse(text) : {};
    return data?.choices?.[0]?.message?.content || "";
  } finally { clearTimeout(t); }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "pingLLM"){
      try{
        const cfg = await chrome.storage.sync.get(DEFAULTS);
        const apiKey = (cfg.apiKey || "").trim();
        if (!apiKey){ sendResponse({ ok:false, error:"API key missing." }); return; }
        const endpointPrimary = buildEndpoint(cfg.baseUrl);
        const model = cfg.model || DEFAULTS.model;
        const temperature = typeof cfg.temperature === "number" ? cfg.temperature : DEFAULTS.temperature;
        const timeoutMs = typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULTS.timeoutMs;
        const system = "Quick test. Respond with 'OK'.";
        const user = "Reply exactly: OK";
        let content = "";
        try{
          content = await callLLM({endpoint:endpointPrimary, apiKey, model, temperature, system, user, timeoutMs});
        }catch(e){
          // try alternative path
          let alt;
          if (/\/v1\/chat\/completions$/i.test(endpointPrimary)){
            alt = endpointPrimary.replace(/\/v1\/chat\/completions$/i, "/chat/completions");
          }else if (/\/chat\/completions$/i.test(endpointPrimary)){
            alt = endpointPrimary.replace(/\/chat\/completions$/i, "/v1/chat/completions");
          }
          if (!alt) throw e;
          content = await callLLM({endpoint:alt, apiKey, model, temperature, system, user, timeoutMs});
        }
        sendResponse({ ok:true, content });
      }catch(e){
        sendResponse({ ok:false, error: e?.message || String(e) });
      }
      return;
    }

    
    if (msg?.type === "suggestActions"){
      try{
        const cfg = await chrome.storage.sync.get(DEFAULTS);
        const apiKey = (cfg.apiKey || "").trim();
        if (!apiKey){ sendResponse({ ok:false, error:"API key missing." }); return; }
        const endpointPrimary = buildEndpoint(cfg.baseUrl);
        const model = cfg.model || DEFAULTS.model;
        const temperature = 0.1;
        const timeoutMs = typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULTS.timeoutMs;

        const system = `You are an assistant that suggests the next logical actions for a Jira ticket.
- Return only a JSON list of 3-6 objects, no additional explanation.
- Each object: { "label": "Button text", "instruction": "concise, precise instruction for response generation" }.
- Adapt actions to category, history, and missing information (e.g., request logs, specific checks, escalation, workaround, follow-up questions).
- Keep label short (<= 24 characters).`;

        const user = msg?.context || "";

        const tryCall = async (ep) => {
          const content = await callLLM({
            endpoint: ep, apiKey, model, temperature, system, user, timeoutMs
          });
          return content;
        };

        let raw = "";
        try{
          raw = await tryCall(endpointPrimary);
        }catch(e1){
          try{
            let alt;
            if (/\/v1\/chat\/completions$/i.test(endpointPrimary)){
              alt = endpointPrimary.replace(/\/v1\/chat\/completions$/i, "/chat/completions");
            }else if (/\/chat\/completions$/i.test(endpointPrimary)){
              alt = endpointPrimary.replace(/\/chat\/completions$/i, "/v1/chat/completions");
            }
            if (!alt) throw e1;
            raw = await tryCall(alt);
          }catch(e2){
            sendResponse({ ok:false, error: e2?.message || e1?.message || "Error generating action suggestions" });
            return;
          }
        }

        // Try parse JSON from model output (robust against code fences)
        let txt = (raw || "").trim();
        try{
          const m = txt.match(/\[[\s\S]*\]$/);
          if (m) txt = m[0];
          const parsed = JSON.parse(txt);
          const list = Array.isArray(parsed) ? parsed.slice(0, 8) : [];
          sendResponse({ ok:true, actions: list });
        }catch(e){
          sendResponse({ ok:false, error: "Could not parse suggestions JSON.", raw });
        }
      }catch(e){
        sendResponse({ ok:false, error: e?.message || String(e) });
      }
      return;
    }


    if (msg?.type === "generateReply"){
      try{
        const cfg = await chrome.storage.sync.get(DEFAULTS);
        const apiKey = (cfg.apiKey || "").trim();
        if (!apiKey) { sendResponse({ error: "API key missing. Please configure in options." }); return; }

        const model = cfg.model || DEFAULTS.model;
        const temperature = (typeof cfg.temperature === "number") ? cfg.temperature : DEFAULTS.temperature;
        const timeoutMs = (typeof cfg.timeoutMs === "number") ? cfg.timeoutMs : DEFAULTS.timeoutMs;

        const sysBase = (cfg.systemPrompt && cfg.systemPrompt.trim()) ? cfg.systemPrompt.trim() :
`You are an IT support assistant for Jira tickets.
- Language: English. No jargon, no small talk, no markdown.
- Write concisely, precisely, numbered when appropriate.
- When "Agent" mode: technical responses with root cause hypotheses, next steps, required artifacts (logs/IDs/URLs).
- When "User" mode: user-friendly, flowing text without numbered steps, only necessary details, no technical jargon.
- For incomplete information: ask targeted follow-up questions as a short list.
- Adapt depth/terminology to the detected ticket category (e.g., SSO/VPN/Mail/Storage/Network/Hardware/Software).
`;

        const endpointPrimary = buildEndpoint(cfg.baseUrl);

        const tryOnce = async (ep) => {
          return await callLLM({
            endpoint: ep, apiKey, model, temperature,
            system: sysBase, user: msg.payload || "",
            timeoutMs
          });
        };

        let content = "";
        try{
          content = await tryOnce(endpointPrimary);
        }catch(e1){
          try{
            let alt;
            if (/\/v1\/chat\/completions$/i.test(endpointPrimary)){
              alt = endpointPrimary.replace(/\/v1\/chat\/completions$/i, "/chat/completions");
            }else if (/\/chat\/completions$/i.test(endpointPrimary)){
              alt = endpointPrimary.replace(/\/chat\/completions$/i, "/v1/chat/completions");
            }
            if (!alt) throw e1;
            content = await tryOnce(alt);
          }catch(e2){
            sendResponse({ error: e2?.message || e1?.message || "Unknown LLM error" });
            return;
          }
        }
        sendResponse({ ok:true, content });
      }catch(e){
        sendResponse({ error: `Error: ${e?.message || e}` });
      }
      return;
    }
  })();
  return true; // keep message channel open for async
});
