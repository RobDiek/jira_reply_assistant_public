// contentScript.js - v0.9.0
// AI-powered Jira ticket response assistant with personalized user communication
// Supports both Jira Cloud and Server with intelligent categorization

(function(){
  // Global reporter name resolver with memoization
  function getReporterName(){
    if (window.__jraReporterNameCached) return window.__jraReporterNameCached;
    const text = (el) => (el ? (el.textContent || "").trim() : "");
    const sels = [
      '[data-testid="issue.views.field.user.reporter"]',
      '[data-testid="issue-field-reporter"]', 
      '[data-test-id="issue.views.field.reporter"]',
      '[data-testid="issue.views.field.people.reporter"]',
      '#reporter-val',
      '[aria-label="Reporter"]'
    ];
    for (const s of sels){
      const n = document.querySelector(s);
      if (n){
        const cand = n.querySelector('a, span, div') || n;
        const t = text(cand);
        if (t && !/reporter/i.test(t)){
          window.__jraReporterNameCached = t.replace(/\s*\(\w+\)\s*$/,"").trim();
          return window.__jraReporterNameCached;
        }
      }
    }
    const dts = Array.from(document.querySelectorAll('dt, label, span'));
    for (const dt of dts){
      if (/^\s*Reporter\s*$/i.test(text(dt))){
        const dd = dt.nextElementSibling;
        if (dd){
          const t = text(dd.querySelector('a, span, div') || dd);
          if (t){
            window.__jraReporterNameCached = t.replace(/\s*\(\w+\)\s*$/,"").trim();
            return window.__jraReporterNameCached;
          }
        }
      }
    }
    window.__jraReporterNameCached = "";
    return "";
  }

  const STYLE_ID = "jra-style-090";
  if (!document.getElementById(STYLE_ID)){
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = `
      #jra-fab{
        position: fixed; z-index: 2147483000; right: 18px; bottom: 18px;
        width: 54px; height: 54px; border-radius: 50%;
        background:#0072C6; color:#fff; display:flex; align-items:center; justify-content:center;
        font-weight:700; font-size:18px; box-shadow: 0 8px 24px rgba(0,0,0,.2); cursor:pointer;
      }
      #jra-panel{
        position: fixed; z-index: 2147483001; right: 18px; bottom: 84px; width: 600px; max-height: 78vh;
        background:#fff; border:1px solid #dcdcdc; border-radius: 12px; box-shadow: 0 16px 54px rgba(0,0,0,.2);
        display:flex; flex-direction:column; overflow:hidden; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      }
      #jra-panel .jra-hd{ display:flex; gap:8px; align-items:center; padding:10px 12px; border-bottom:1px solid #eee; flex-wrap: wrap; }
      #jra-panel .jra-btn{ background:#f6f6f6; border:1px solid #dcdcdc; border-radius:8px; padding:6px 10px; cursor:pointer; }
      #jra-panel .jra-btn.primary{ background:#0072C6; color:#fff; border-color:#0072C6; }
      #jra-panel .jra-body{ padding:10px 12px; display:flex; gap:8px; flex-direction:column; }
      #jra-output{ width:100%; min-height:180px; resize:vertical; border:1px solid #ddd; border-radius:8px; padding:8px;
                   font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
      #jra-status{ font-size:12px; color:#666; }
      #jra-copy{ align-self:flex-end; }
      #jra-analysis{ display:none !important; }
      .jra-chips{ display:flex; gap:6px; flex-wrap:wrap; }
      #jra-freewrap{ display:flex; gap:6px; }
      #jra-free{ flex:1; border:1px solid #ddd; border-radius:8px; padding:8px; font-size:14px; }
    `;
    document.head.appendChild(st);
  }

  const ensureOnJiraHost = () => /\.atlassian\.net$/i.test(location.hostname) || /\/browse\//i.test(location.pathname);

  function ensureFab(){
    if (!ensureOnJiraHost()) return;
    if (document.getElementById("jra-fab")) return;
    const fab = document.createElement("div");
    fab.id = "jra-fab";
    fab.title = "Open/Close Jira Reply Assistant";
    fab.textContent = "J";
    fab.addEventListener("click", function(){
      try{
        const holder = document.getElementById("jra-panel");
        if (holder){ holder.remove(); }
        else { openPanel(true); }
      }catch(e){}
    });
    document.documentElement.appendChild(fab);
  }

  // SPA changes
  let lastHref = location.href;
  const obs = new MutationObserver(()=>{
    if (location.href !== lastHref){
      lastHref = location.href;
      setTimeout(ensureFab, 50);
    }
  });
  obs.observe(document.documentElement, { childList:true, subtree:true });

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  function getIssueKeyFromUrl(){
    try {
      const m = location.pathname.match(/\/browse\/([A-Z0-9\-]+)/i);
      return m ? decodeURIComponent(m[1]) : "";
    } catch { return ""; }
  }

  async function ensureAllCommentsLoaded(issueKey){
    try{
      const matchesKey = (btn) => {
        const u = btn.getAttribute("data-url") || btn.getAttribute("data-url-all") || "";
        if (!u) return true;
        return issueKey && u.includes("/browse/" + issueKey);
      };
      let btnAll = Array.from(document.querySelectorAll("button.show-more-comment-tabpanel"))
        .find(b => matchesKey(b) && ((b.getAttribute("data-url-all") || "").includes("showAll=true")));
      if (btnAll){
        btnAll.click();
        await sleep(900);
      }
      let guard = 0;
      while (guard++ < 30){
        const btn = Array.from(document.querySelectorAll("button.show-more-comment-tabpanel, button.collapsed-comment-tabpanel"))
          .find(b => matchesKey(b) && ((b.getAttribute("data-fetch-mode") || "").toLowerCase() === "older"));
        if (!btn) break;
        btn.click();
        await sleep(1000);
      }
    }catch(e){ /* silent */ }
  }

  function textOf(el){
    if (!el) return "";
    return (el.textContent || "").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  }

  function getData(){
    const key = getIssueKeyFromUrl();
    let summary = "";
    let description = "";
    const comments = [];

    const sumCandidates = [
      'h1[data-test-id="issue.views.issue-base.foundation.summary.heading"]',
      '#summary-val',
      '[data-testid="issue-view-summary"]',
      'header [data-issue-id] h1'
    ];
    for (const sel of sumCandidates){
      const el = document.querySelector(sel);
      if (el && textOf(el)){ summary = textOf(el); break; }
    }
    if (!summary) summary = document.title.split(" - ")[0] || "";

    const descCandidates = [
      '[data-testid="issue.views.field.rich-text"]',
      '[data-test-id="issue.views.issue-details.issue-layout.container-left"] [data-testid="issue-description"]',
      '#description-val',
      '.ak-renderer-document',
      '.user-content-block'
    ];
    for (const sel of descCandidates){
      const el = document.querySelector(sel);
      if (el && textOf(el)){ description = textOf(el); break; }
    }

    const commentSelectors = [
      '[data-test-id="issue.activity.comments"] [data-testid="comment"] article',
      '#issue_actions_container .activity-comment .action-body',
      '[data-testid="issue-activity-feed.comments"] [data-testid="virtual-list-item"]',
      '.issuePanelContainer .issuePanelWrapper .comment',
      '.activitymodule .comment-actions + .action-body'
    ];
    const seen = new Set();
    for (const sel of commentSelectors){
      document.querySelectorAll(sel).forEach(n => {
        const t = textOf(n);
        if (t && t.length > 2 && !seen.has(t)){ comments.push(t); seen.add(t); }
      });
      if (comments.length) break;
    }
    return { key, summary, description, comments, author: getReporterName() };
  }

  async function requestDynamicActions(d, a){
    const context = `[CONTEXT]
Ticket Key: ${d.key || "(N/A)"}
Title: ${d.summary || "(N/A)"}
Description:
${(d.description||"").trim()}

Recent Comments (newest first), max 8:
${(d.comments||[]).slice(0,8).join("\n---\n")}

Detected Category: ${a.category}
Tags: ${a.tags.join(", ")}

[TASK]
Suggest 3-6 logical next actions as JSON list (label + instruction).`;

    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type:"suggestActions", context }, (resp) => {
        if (!resp || !resp.ok || !Array.isArray(resp.actions)){ resolve(null); return; }
        resolve(resp.actions);
      });
    });
  }

  function analyze(d){
    const txt = [d.summary, d.description, ...(d.comments||[])].join("\n").toLowerCase();
    const tags = [];
    const has = (arr) => arr.some(k => txt.includes(k));

    let category = "generic";
    if (has(["vpn", "anyconnect", "ipsec", "cisco"])) { category = "vpn"; tags.push("network"); }
    else if (has(["mfa", "2fa", "authenticator", "sso", "single sign-on", "consent", "aadsts"])) { category = "sso/mfa"; }
    else if (has(["outlook", "smtp", "imap", "mailflow", "mailbox", "shared mailbox", "bounce"])) { category = "mail"; }
    else if (has(["onedrive", "odsp", "sharepoint", "sync"])) { category = "storage"; }
    else if (has(["printer", "print"])) { category = "print"; }
    if (has(["teams", "meeting", "call"])) { tags.push("teams"); }
    if (has(["certificate", "ssl", "tls"])) { tags.push("cert"); }
    if (has(["firewall", "policy"])) { tags.push("firewall"); }

    return { category, tags: Array.from(new Set(tags)), author: getReporterName() };
  }

  function buildSuggestionButtons(cat){
    const map = {
      "vpn": [
        { k:"steps", label:"VPN Steps" },
        { k:"vpn_diag", label:"VPN Diagnosis" },
        { k:"vpn_work", label:"VPN Workaround" },
        { k:"question", label:"VPN Questions" }
      ],
      "sso/mfa":[
        { k:"steps", label:"SSO/MFA Steps" },
        { k:"sso_chk", label:"SSO/MFA Checklist" },
        { k:"question", label:"SSO/MFA Questions" }
      ],
      "mail":[
        { k:"steps", label:"Mail Steps" },
        { k:"smtp_diag", label:"SMTP Diagnosis" },
        { k:"mx_check", label:"MX/SPF Check" },
        { k:"question", label:"Mail Questions" }
      ],
      "storage":[
        { k:"steps", label:"Storage Steps" },
        { k:"sync_reset", label:"Sync Reset" },
        { k:"question", label:"Storage Questions" }
      ],
      "print":[
        { k:"steps", label:"Print Steps" },
        { k:"print_diag", label:"Print Diagnosis" },
        { k:"workaround", label:"Print Workaround" }
      ],
      "generic":[
        { k:"steps", label:"General Steps" },
        { k:"triage", label:"Triage Checklist" },
        { k:"question", label:"Follow-up Questions" },
        { k:"workaround", label:"Workaround" }
      ]
    };
    return map[cat] || map["generic"];
  }

  function promptFor(kind, analysis, mode, freePromptText){
    const cat = analysis?.category || "generic";
    if (kind === "agent_summary"){
      return `Create a brief technical summary for internal use:
- TL;DR (1-2 sentences)
- Timeline of events
- Current status
- Top 3 suspected causes with verification steps
- Missing information (targeted questions)
- Next steps (prioritized)
- Risks/workarounds if relevant
Adapt terminology to ${cat} category.`;
    }
    if (kind === "no_response"){
      return `Compose a polite request for user feedback:
- Brief, professional, friendly tone
- Summarize what the issue was about
- Reference the last question asked if any
- Suggest 1-2 specific response options (Yes/No, screenshot, timing, etc.)
- English, no formal greeting/closing.`;
    }
    if (kind === "free"){
      return (freePromptText || "Generate helpful, precise response.").slice(0, 4000);
    }
    switch(kind){
      case "vpn_diag": return "VPN troubleshooting guide (client status, certificates, timing, location, network changes, DNS resolution, firewall). Max 7 steps.";
      case "vpn_work": return (mode==="user") ? "User-friendly VPN workaround (reconnect WiFi, DNS flush, client restart, mobile hotspot), mention risks." : "Technical VPN workaround with policy notes, security impact, fallback plan.";
      case "sso_chk": return "SSO/MFA checklist (app consent, token lifetime, conditional access, sign-in logs, UPN/domain, time/NTP, error codes).";
      case "smtp_diag": return "SMTP diagnosis (port/TLS, auth, sender, SPF/DMARC/DKIM, bounces, throttling, connector policies).";
      case "mx_check": return "MX/SPF quick check: current MX records, SPF includes, DKIM selectors, DMARC policy, common misconfigurations.";
      case "sync_reset": return "Cloud storage reset/repair sequence (disconnect account, reset command, folder moves, permissions, placeholders, limits). Max 7 steps.";
      case "print_diag": return "Printer troubleshooting: drivers, queue, spooler, network/port, firmware, test page, permissions, default printer.";
      case "triage": return "General IT triage: scope, timing, error messages, affected users/locations, reproducibility, recent changes, logs/IDs.";
    }
    const baseUser = {
      short: "Brief user response with key message and current status.",
      steps: "Step-by-step user guide, max 7 steps, clear menu names.",
      question: "Targeted user questions, max 6 points.",
      workaround: "Safe user workaround with limitation notes."
    };
    const baseAgent = {
      short: "Brief technical status with key issues, blockers, ETA.",
      steps: `Technical checklist (max 7) with specific checks/logs for ${cat}.`,
      question: "Technical questions (artifacts/IDs/logs/times/systems), max 8 points.",
      workaround: "Technical workaround with impact, fallback, required permissions."
    };
    const map = (mode === "user") ? baseUser : baseAgent;
    return map[kind] || "Generate helpful, precise response.";
  }

  function mk(el, cls, text){
    const n = document.createElement(el);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function extractLastQuestion(d){
    const texts = [];
    if (d.description) texts.push(d.description);
    if (Array.isArray(d.comments)) texts.push(...d.comments);
    for (let i = texts.length - 1; i >= 0; i--){
      const t = (texts[i] || "").trim();
      if (!t) continue;
      const qm = t.lastIndexOf("?");
      if (qm !== -1){
        let start = Math.max(0, t.lastIndexOf("\n", qm-1) + 1);
        return t.slice(start).trim();
      }
    }
    return "";
  }

  async function openPanel(force){
    let holder = document.getElementById("jra-panel");
    if (holder && !force) return;
    if (holder && force) holder.remove();

    holder = mk("div"); holder.id = "jra-panel";
    const hd = mk("div", "jra-hd");
    const body = mk("div", "jra-body");

    // Mode switch group
    const modeWrap = document.createElement("div");
    modeWrap.style.display = "inline-flex";
    modeWrap.style.border = "1px solid #dcdcdc";
    modeWrap.style.borderRadius = "999px";
    modeWrap.style.overflow = "hidden";

    function mkModeBtn(val, label){
      const b = document.createElement("button");
      b.textContent = label;
      b.style.padding = "6px 10px";
      b.style.border = "none";
      b.style.cursor = "pointer";
      b.style.background = "#f6f6f6";
      b.dataset.mode = val;
      return b;
    }
    const btnAgent = mkModeBtn("agent","Technical (Agent)");
    const btnUser = mkModeBtn("user","User-Friendly");

    const saved = await chrome.storage.sync.get({ replyMode:"agent" });
    let replyMode = (saved.replyMode === "user") ? "user" : "agent";

    const setActive = (active) => {
      [btnAgent, btnUser].forEach(b => {
        b.style.background = (b.dataset.mode === active) ? "#0072C6" : "#f6f6f6";
        b.style.color = (b.dataset.mode === active) ? "#fff" : "#000";
      });
    };
    setActive(replyMode);
    [btnAgent, btnUser].forEach(b => b.addEventListener("click", async () => {
      replyMode = b.dataset.mode;
      await chrome.storage.sync.set({ replyMode });
      setActive(replyMode);
    }));

    modeWrap.appendChild(btnAgent); modeWrap.appendChild(btnUser);
    hd.appendChild(modeWrap);

    // Initial actions
    const btnAnalyze = mk("button","jra-btn primary","Analyze & Suggest");
    btnAnalyze.classList.add("jra-generate"); btnAnalyze.setAttribute("data-kind","summarize_analyze");
    const btnNoResponse = mk("button","jra-btn","Request Follow-up");
    btnNoResponse.classList.add("jra-generate"); btnNoResponse.setAttribute("data-kind","no_response");

    const btnDynHolder = mk("div");
    btnDynHolder.style.display = "flex";
    btnDynHolder.style.gap = "8px";
    btnDynHolder.style.flexWrap = "wrap";

    hd.appendChild(btnAnalyze);
    hd.appendChild(btnNoResponse);
    hd.appendChild(btnDynHolder);

    const status = mk("div"); status.id = "jra-status"; status.textContent = "Ready.";
    const analysisBox = mk("div"); analysisBox.id = "jra-analysis"; analysisBox.textContent = "(No analysis performed yet.)";
    const chips = mk("div","jra-chips");

    // Free text input
    const freeWrap = mk("div"); freeWrap.id = "jra-freewrap";
    const free = mk("input"); free.id = "jra-free"; free.placeholder = "Free text: Type your question and press Enter...";
    const freeBtn = mk("button","jra-btn","Submit");
    freeWrap.appendChild(free); freeWrap.appendChild(freeBtn);

    const out = mk("textarea"); out.id = "jra-output"; out.placeholder = "Response will appear here...";
    const outputEl = out;
    const copy = mk("button", "jra-btn"); copy.id = "jra-copy"; copy.textContent = "Copy to Clipboard";
    copy.addEventListener("click", async ()=>{
      try { await navigator.clipboard.writeText(out.value || ""); status.textContent = "Copied."; }
      catch(e){ status.textContent = "Copy failed."; }
    });

    body.appendChild(status);
    body.appendChild(analysisBox);
    body.appendChild(chips);
    body.appendChild(freeWrap);
    body.appendChild(out);
    body.appendChild(copy);

    holder.appendChild(hd);
    holder.appendChild(body);
    document.documentElement.appendChild(holder);

    // Main event handler
    holder.addEventListener("click", async (ev) => {
      const btn = ev.target.closest(".jra-generate"); if (!btn) return;
      const kindRaw = btn.getAttribute("data-kind");

      const saved = await chrome.storage.sync.get({ replyMode:"agent" });
      const mode = (saved.replyMode === "user") ? "user" : "agent";

      if (kindRaw === "summarize_analyze"){
        status.textContent = "Loading older comments...";
        const d0 = getData();
        await ensureAllCommentsLoaded(d0.key);

        console.debug("[JRA] Analyzing ticket..."); status.textContent = "Analyzing ticket...";
        const d = getData();
        const a = analyze(d);
        analysisBox.textContent = `Ticket: ${d.key || "(N/A)"} | Category: ${a.category} | Tags: ${a.tags.join(", ") || "–"}`;
        chips.innerHTML = "";
        a.tags.forEach(t => { const c = mk("span","jra-btn",t); c.style.cursor="default"; chips.appendChild(c); });

        const instruction = promptFor("agent_summary", a, "agent");
        const greetName = (d.author || getReporterName() || "").trim();

        const payload = 
`[CONTEXT]
Ticket Key: ${d.key || "(N/A)"}
Title: ${d.summary || "(N/A)"}
Description:
${(d.description||"").trim()}

Comments (newest to oldest):
${(d.comments||[]).join("\n---\n")}

Detected Category: ${a.category}
Tags: ${a.tags.join(", ")}

[TASK]
${instruction}

[FORMAT]
- English, no markdown, no greeting/closing.
- Technical, internal use, concise.
- Maximum relevant details, no context repetition.`;

        outputEl.value = "";
        chrome.runtime.sendMessage({ type:"generateReply", payload }, (resp) => {
          if (!resp){ status.textContent = "No response from background service."; return; }
          if (resp.error){ outputEl.value = ""; status.textContent = resp.error; return; }
          outputEl.value = (resp.content || "").trim();
          console.debug("[JRA] Analysis complete"); status.textContent = "Analysis complete.";
        });

        // Build suggestion buttons
        btnDynHolder.innerHTML = "";
        let dynActions = null;
        try{ dynActions = await requestDynamicActions(d, a); }catch(e){ dynActions = null; }
        if (Array.isArray(dynActions) && dynActions.length){
          dynActions.slice(0,8).forEach((item, idx) => {
            const label = (item && item.label) ? String(item.label).trim().slice(0, 28) : `Action ${idx+1}`;
            const instr = (item && item.instruction) ? String(item.instruction).trim().slice(0, 1400) : "Generate helpful response.";
            const b = mk("button","jra-btn", label);
            b.classList.add("jra-generate");
            b.setAttribute("data-kind", "dyn");
            b.setAttribute("data-instr", instr);
            btnDynHolder.appendChild(b);
          });
        } else {
          buildSuggestionButtons(a.category).forEach(aBtn => {
            const b = mk("button","jra-btn",aBtn.label);
            b.classList.add("jra-generate");
            b.setAttribute("data-kind", aBtn.k);
            btnDynHolder.appendChild(b);
          });
        }
        // Add refresh button
        const refresh = mk("button","jra-btn","Refresh Analysis");
        refresh.classList.add("jra-generate");
        refresh.setAttribute("data-kind","refresh_after");
        btnDynHolder.appendChild(refresh);

        return;
      }

      if (kindRaw === "refresh_after"){
        status.textContent = "Loading older comments...";
        const d0 = getData();
        await ensureAllCommentsLoaded(d0.key);
        const d = getData();
        const a = analyze(d);
        analysisBox.textContent = `Ticket: ${d.key || "(N/A)"} | Category: ${a.category} | Tags: ${a.tags.join(", ") || "–"}`;
        chips.innerHTML = "";
        a.tags.forEach(t => { const c = mk("span","jra-btn",t); c.style.cursor="default"; chips.appendChild(c); });
        btnDynHolder.innerHTML = "";
        buildSuggestionButtons(a.category).forEach(aBtn => {
          const b = mk("button","jra-btn",aBtn.label);
          b.classList.add("jra-generate");
          b.setAttribute("data-kind", aBtn.k);
          btnDynHolder.appendChild(b);
        });
        const refresh = mk("button","jra-btn","Refresh Analysis");
        refresh.classList.add("jra-generate");
        refresh.setAttribute("data-kind","refresh_after");
        btnDynHolder.appendChild(refresh);
        console.debug("[JRA] Analysis updated"); status.textContent = "Analysis updated.";
        return;
      }

      if (kindRaw === "no_response"){
        status.textContent = "Generating follow-up request...";
        const dPre = getData();
        await ensureAllCommentsLoaded(dPre.key);
        const d = getData();
        const a = analyze(d);
        const lastQ = extractLastQuestion(d);

        const instruction = promptFor("no_response", a, mode);
        const greetName = (d.author || getReporterName() || "").trim();

        const formatUser = `- English, no markdown.
- User-friendly, flowing text without numbered steps.
- Start with "Hello${greetName ? " " + greetName : ""}".
- End with "Best regards".
- Maximum relevant details, no context repetition.`;

        const formatAgent = `- English, no markdown, no greeting/closing.
- Technical, internal use, concise.
- Maximum relevant details, no context repetition.`;

        const payload = 
`[CONTEXT]
Ticket Key: ${d.key || "(N/A)"}
Title: ${d.summary || "(N/A)"}
Case summary (brief).
Last question asked (if any):
${lastQ || "(none detected)"}

[TASK]
${instruction}

[FORMAT]
${mode === "agent" ? (
  "- English, no markdown, no greeting/closing.\n- Internal text that can be sent 1:1 to end user.\n- Maximum 6 short sentences."
) : (
  `- English, no markdown.\n- User-friendly, flowing text without numbered steps.\n- Start with "Hello${(d.author || getReporterName() || "").trim() ? " " + (d.author || getReporterName() || "").trim() : ""}".\n- End with "Best regards".\n- Maximum 6 short sentences.`
)}`;

        outputEl.value = "";
        chrome.runtime.sendMessage({ type:"generateReply", payload }, (resp) => {
          if (!resp){ status.textContent = "No response from background service."; return; }
          if (resp.error){ outputEl.value = ""; status.textContent = resp.error; return; }
          outputEl.value = (resp.content || "").trim();
          status.textContent = "Complete.";
        });
        return;
      }

      // Suggestion button pressed
      status.textContent = "Generating response...";
      const dPre = getData();
      await ensureAllCommentsLoaded(dPre.key);
      const d = getData();
      const a = analyze(d);
      let instruction;
      if (kindRaw === "dyn"){
        instruction = (btn.getAttribute("data-instr") || "Generate helpful, precise response.");
      } else {
        instruction = promptFor(kindRaw, a, mode);
      }
      const greetName = (d.author || getReporterName() || "").trim();

      const formatUser = `- English, no markdown.
- User-friendly, flowing text without numbered steps.
- Start with "Hello${greetName ? " " + greetName : ""}".
- End with "Best regards".
- Maximum relevant details, no context repetition.`;

      const formatAgent = `- English, no markdown, no greeting/closing.
- Technical, internal use, concise.
- Maximum relevant details, no context repetition.`;

      const payload = 
`[CONTEXT]
Ticket Key: ${d.key || "(N/A)"}
Title: ${d.summary || "(N/A)"}
Description:
${(d.description||"").trim()}

Comments (newest to oldest):
${(d.comments||[]).join("\n---\n")}

Detected Category: ${a.category}
Tags: ${a.tags.join(", ")}

[TASK]
${instruction}

[FORMAT]
${mode === "agent" ? formatAgent : formatUser}`;

      outputEl.value = "";
      chrome.runtime.sendMessage({ type:"generateReply", payload }, (resp) => {
        if (!resp){ status.textContent = "No response from background service."; return; }
        if (resp.error){ outputEl.value = ""; status.textContent = resp.error; return; }
        outputEl.value = (resp.content || "").trim();
        status.textContent = "Complete.";
      });
    });

    // Free text handler
    async function sendFree(){
      const txt = (free.value || "").trim();
      if (!txt){ status.textContent = "Please enter free text."; return; }
      const saved = await chrome.storage.sync.get({ replyMode:"agent" });
      const mode = (saved.replyMode === "user") ? "user" : "agent";

      status.textContent = "Loading older comments...";
      const dPre = getData();
      await ensureAllCommentsLoaded(dPre.key);

      status.textContent = "Reading ticket data...";
      const d = getData();
      const a = analyze(d);

      const instruction = promptFor("free", a, mode, txt);
      const greetName = (d.author || getReporterName() || "").trim();

      const formatUser = `- English, no markdown.
- User-friendly, flowing text without numbered steps.
- Start with "Hello${greetName ? " " + greetName : ""}".
- End with "Best regards".
- Maximum relevant details, no context repetition.`;

      const formatAgent = `- English, no markdown, no greeting/closing.
- Technical, internal use, concise.
- Maximum relevant details, no context repetition.`;

      const payload = 
`[CONTEXT]
Ticket Key: ${d.key || "(N/A)"}
Title: ${d.summary || "(N/A)"}
Description:
${(d.description||"").trim()}

Comments (newest to oldest):
${(d.comments||[]).join("\n---\n")}

Detected Category: ${a.category}
Tags: ${a.tags.join(", ")}

[TASK]
${instruction}

[FORMAT]
${mode === "agent" ? formatAgent : formatUser}`;

      status.textContent = "Sending free text request...";
      outputEl.value = "";
      chrome.runtime.sendMessage({ type:"generateReply", payload }, (resp) => {
        if (!resp){ status.textContent = "No response from background service."; return; }
        if (resp.error){ outputEl.value = ""; status.textContent = resp.error; return; }
        outputEl.value = (resp.content || "").trim();
        status.textContent = "Complete.";
      });
    }

    free.addEventListener("keydown", (e)=>{ if (e.key === "Enter"){ e.preventDefault(); sendFree(); } });
    freeBtn.addEventListener("click", sendFree);
  }

  // Initialize
  ensureFab();
  setTimeout(ensureFab, 600);
})();
