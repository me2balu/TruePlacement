// sidepanel.js — wires up the TruePlacement side panel UI on top of
// TruePlacementModel (lib/model.js).

const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M4.5 12.5l5 5L19.5 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WARNING =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.2L22 20.8H2L12 3.2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9.8v4.6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1" fill="currentColor"/></svg>';
const ICON_DASH =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M6 12h12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

const els = {
  tabs: document.querySelectorAll(".tab"),
  panelCheck: document.getElementById("panel-check"),
  panelHistory: document.getElementById("panel-history"),
  title: document.getElementById("field-title"),
  company: document.getElementById("field-company"),
  location: document.getElementById("field-location"),
  desc: document.getElementById("field-desc"),
  remote: document.getElementById("chk-remote"),
  logo: document.getElementById("chk-logo"),
  questions: document.getElementById("chk-questions"),
  analyzeBtn: document.getElementById("btn-analyze"),
  resultArea: document.getElementById("result-area"),
  clearBtn: document.getElementById("btn-clear"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  clearHistoryBtn: document.getElementById("btn-clear-history"),
  aiSettingsBtn: document.getElementById("btn-ai-settings"),
  footerModelStatus: document.getElementById("footer-model-status"),
};

// ---------------------------------------------------------------- tabs ----
els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    els.tabs.forEach((t) => {
      t.classList.remove("active");
      t.setAttribute("aria-selected", "false");
    });
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    const target = tab.dataset.tab;
    els.panelCheck.hidden = target !== "check";
    els.panelHistory.hidden = target !== "history";
    if (target === "history") renderHistory();
  });
});

function goToCheckTab() {
  document.querySelector('.tab[data-tab="check"]').click();
}

// ------------------------------------------------------- drag and drop ----
function wireDropTarget(el, { append = true } = {}) {
  ["dragenter", "dragover"].forEach((evt) =>
    el.addEventListener(evt, (e) => {
      e.preventDefault();
      el.classList.add("drag-over");
    })
  );
  ["dragleave", "dragend"].forEach((evt) =>
    el.addEventListener(evt, () => el.classList.remove("drag-over"))
  );
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    const text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text");
    if (!text) return;
    if (append && el.value.trim()) {
      el.value = el.value.trim() + "\n\n" + text.trim();
    } else {
      el.value = text.trim();
    }
  });
}
wireDropTarget(els.desc);
wireDropTarget(els.title, { append: false });
wireDropTarget(els.company, { append: false });

// ------------------------------------------------------- quick actions ----
els.clearBtn.addEventListener("click", () => {
  els.title.value = "";
  els.company.value = "";
  els.location.value = "";
  els.desc.value = "";
  els.remote.checked = false;
  els.logo.checked = false;
  els.questions.checked = false;
  els.resultArea.innerHTML = "";
});

// ---------------------------------------------------- AI backend settings --
// The AI verification feature (public-evidence search + Claude reading the
// posting text) needs a server — the same Node backend that ships with the
// website (website/server/), since the extension itself has no server and
// shouldn't embed an Anthropic API key in shipped code. Point this at
// wherever you're running that server; defaults to a local dev instance.
const AI_BACKEND_KEY = "tp_ai_backend_url";
const DEFAULT_AI_BACKEND = "http://localhost:3000";

async function getAIBackendUrl() {
  const { [AI_BACKEND_KEY]: url } = await chrome.storage.local.get(AI_BACKEND_KEY);
  return (url || DEFAULT_AI_BACKEND).replace(/\/+$/, "");
}

els.aiSettingsBtn.addEventListener("click", async () => {
  const current = await getAIBackendUrl();
  const next = window.prompt(
    "URL of the TruePlacement website server (used for the AI verification check). " +
      "Run it locally with `npm start` in the website/ folder, or point this at a deployed instance.",
    current
  );
  if (next === null) return; // cancelled
  const trimmed = next.trim().replace(/\/+$/, "");
  if (!trimmed) return;
  await chrome.storage.local.set({ [AI_BACKEND_KEY]: trimmed });
  showToast(`AI backend set to ${trimmed}`);
});

// ------------------------------------------ selection handoff from page ----
async function consumePendingSelection() {
  const { pendingText, pendingAutoAnalyze } = await chrome.storage.session.get([
    "pendingText",
    "pendingAutoAnalyze",
  ]);
  if (pendingText) {
    els.desc.value = pendingText;
    goToCheckTab();
    chrome.storage.session.remove(["pendingText", "pendingAutoAnalyze"]);
    if (pendingAutoAnalyze) {
      runAnalysis();
    } else {
      showToast("Loaded the text you selected on the page.");
    }
  }
}
consumePendingSelection();

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "trueplacement:pending-text" && message.text) {
    els.desc.value = message.text;
    goToCheckTab();
    chrome.storage.session.remove(["pendingText", "pendingAutoAnalyze"]);
    if (message.autoAnalyze) {
      runAnalysis();
    } else {
      showToast("Loaded the text you selected on the page.");
    }
  }
});

// -------------------------------------------------------------- toast ----
let toastTimer = null;
function showToast(text) {
  let toast = document.getElementById("tp-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "tp-toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

// ------------------------------------------------------------ analyze ----
els.analyzeBtn.addEventListener("click", () => runAnalysis());

const SCAN_LOADING_HTML = `
  <div class="scan-loading">
    <div class="scan-loading-head">
      <span class="scan-dot"></span>
      <span>Analyzing…</span>
    </div>
    <div class="scan-track"><div class="scan-beam"></div></div>
  </div>`;

let analyzing = false;

async function runAnalysis() {
  if (analyzing) return;
  const bodyText = els.desc.value.trim();
  if (!bodyText) {
    els.resultArea.innerHTML = `<div class="notice">Add some posting text first — paste it, or drag a selection in.</div>`;
    return;
  }
  const fullText = [els.title.value, els.company.value, bodyText].filter(Boolean).join(". ");
  const company = els.company.value.trim();
  const role = els.title.value.trim();
  const location = els.location.value.trim();

  analyzing = true;
  els.analyzeBtn.disabled = true;
  els.analyzeBtn.textContent = "Analyzing…";
  els.resultArea.innerHTML = SCAN_LOADING_HTML;

  let result;
  try {
    const [r] = await Promise.all([
      TruePlacementModel.analyze(fullText, {
        telecommuting: els.remote.checked,
        hasLogo: els.logo.checked,
        hasQuestions: els.questions.checked,
      }),
      new Promise((r2) => setTimeout(r2, 380)),
    ]);
    result = r;
    renderResult(result, { aiState: "loading" });
    await saveHistoryEntry(result, els.title.value, bodyText);
    chrome.runtime.sendMessage({ type: "trueplacement:record-result", isFraud: result.prediction === 1 }).catch(() => {});
  } catch (err) {
    console.error("Error during analysis:", err);
    els.resultArea.innerHTML = `<div class="notice">An error occurred during analysis. Please try again.</div>`;
    analyzing = false;
    els.analyzeBtn.disabled = false;
    els.analyzeBtn.textContent = "Analyze";
    return;
  }

  analyzing = false;
  els.analyzeBtn.disabled = false;
  els.analyzeBtn.textContent = "Analyze";

  // The wording model above already ran fully on-device. The AI check below
  // is a separate, additional signal — it sends the posting text and any
  // company/role/location you filled in to the backend server configured
  // in "AI backend settings" (see getAIBackendUrl()), which reads the text
  // directly and, if a company was given, searches for public evidence.
  runAIVerification(result, { text: bodyText, company, role, location });
}

async function runAIVerification(mlResult, { text, company, role, location }) {
  const backendUrl = await getAIBackendUrl();
  try {
    const res = await fetch(`${backendUrl}/api/verify-opening`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, company, role, location }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Verification failed");
    renderResult(mlResult, { aiState: "done", aiData: data });
  } catch (err) {
    console.error("AI verification failed:", err);
    const friendly = err instanceof TypeError
      ? `Couldn't reach the AI backend at ${backendUrl}. Make sure the TruePlacement website server is running (see "AI backend settings" below), or update the URL there.`
      : err.message;
    renderResult(mlResult, { aiState: "error", aiError: friendly });
  }
}

// --------------------------------------------------- combining verdicts ---
// Merge the on-device wording model with the AI check into one overall
// call. The two can disagree — when they do, that's a caution state, not
// a simple average. Ported from website/public/app.js so both surfaces
// agree on the same logic.
const AI_META = {
  likely_genuine: { tone: "genuine", label: "Looks genuine" },
  warning_signs_found: { tone: "fraud", label: "Warning signs found" },
  no_evidence_found: { tone: "caution", label: "No public evidence" },
  unable_to_verify: { tone: "caution", label: "Unable to verify" },
  not_applicable: { tone: "caution", label: "Not run" },
};

function combineVerdict(mlFraud, aiKey) {
  if (!aiKey || aiKey === "not_applicable") {
    return mlFraud
      ? { tone: "fraud", title: "Likely fraudulent", note: "Based on wording only — the AI check didn't run (no server reachable / no API key configured there)." }
      : { tone: "genuine", title: "Looks genuine", note: "Based on wording only — the AI check didn't run (no server reachable / no API key configured there)." };
  }
  if (aiKey === "warning_signs_found")
    return { tone: "fraud", title: "Likely fraudulent", note: "Public warning signs were found for this company/opening." };
  if (aiKey === "likely_genuine") {
    if (mlFraud)
      return { tone: "caution", title: "Mixed signals", note: "The wording matches statistical fraud patterns, but a fuller read plus public evidence suggests this is likely genuine. Still worth a quick check with the official source." };
    return { tone: "genuine", title: "Looks genuine", note: "The wording looks clean and the opening checks out." };
  }
  if (mlFraud)
    return { tone: "fraud", title: "Likely fraudulent", note: "Wording matches fraud patterns; we couldn't independently confirm the opening either way, so treat this as a caution, not a certainty." };
  return { tone: "caution", title: "Likely genuine, unconfirmed", note: "Wording looks clean, but we couldn't independently confirm this specific opening. Verify directly with the company before applying." };
}

function renderResult(result, { aiState = "loading", aiData = null, aiError = null } = {}) {
  const isFraud = result.prediction === 1;
  const aiKey = aiState === "done" ? (aiData.ai && aiData.ai.verdict) || aiData.heuristic.label : null;
  const combined = combineVerdict(isFraud, aiKey);
  const cardClass = combined.tone === "fraud" ? "verdict-fraud" : combined.tone === "genuine" ? "verdict-real" : "verdict-fraud";
  const icon = combined.tone === "genuine" ? ICON_CHECK : combined.tone === "fraud" ? ICON_WARNING : ICON_DASH;
  const pct = result.confidence * 100;
  const confLabel = result.overridden ? "wording-model confidence (pre-override)" : "wording-model confidence";

  let html = "";

  if (result.outOfDomain) {
    html += `<div class="notice">This text doesn't contain much job-posting vocabulary, so treat the result below as unreliable rather than a genuine assessment.</div>`;
  }

  html += `
    <div class="verdict ${cardClass}">
      <div class="verdict-eyebrow">Verdict<span class="verdict-eyebrow-icon">${icon}</span></div>
      <div class="verdict-title">${combined.title}</div>
      <p class="explain-empty" style="margin-bottom:0.7rem;">${escapeHtml(combined.note)}</p>
      <div class="verdict-bar-row">
        <div class="verdict-bar-track"><div class="verdict-bar-fill" style="width:${pct}%"></div></div>
        <span class="verdict-pct">${pct.toFixed(0)}%</span>
      </div>
      <div class="verdict-conf-label">${confLabel}</div>
    </div>`;

  if (result.overridden) {
    html += `<div class="override-note">The model's initial read leaned genuine, but this posting explicitly requests a fee or deposit — a near-certain scam signal on its own — so the verdict was changed to fraudulent.</div>`;
  }

  html += `<div class="panel"><div class="panel-row"><h3>Verification notes</h3></div>`;
  for (const flag of result.flagResults) {
    const chipClass = flag.hit ? "flag-chip-hit" : "flag-chip-clear";
    const icon2 = flag.hit ? ICON_WARNING : ICON_DASH;
    html += `<div class="flag-item"><span class="flag-chip ${chipClass}">${icon2}</span><span>${flag.hit ? `<b>${escapeHtml(flag.label)}</b>` : escapeHtml(flag.label)}</span></div>`;
  }
  html += `</div>`;

  html += `<div class="panel"><div class="panel-row"><h3>Why the wording model leans this way</h3></div><div class="explain-grid">`;
  html += renderChipRow("Pushed toward fraudulent", result.topFraudWords, "fraud");
  html += renderChipRow("Pushed toward genuine", result.topGenuineWords, "genuine");
  html += `<p class="explain-empty">Phrases are ranked by how much they moved the on-device score for this posting.</p>`;
  html += `</div></div>`;

  html += renderAIPanel(aiState, aiData, aiError);

  els.resultArea.innerHTML = html;
  els.resultArea.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderAIPanel(aiState, aiData, aiError) {
  const aiKey = aiState === "done" ? (aiData.ai && aiData.ai.verdict) || aiData.heuristic.label : null;

  if (aiState === "loading") {
    return `<div class="panel">
      <div class="sub-section-head"><h3>AI verification</h3><span class="sub-tag pending">Checking…</span></div>
      <p class="explain-empty">Reading the posting text and checking for public evidence about the company.</p>
    </div>`;
  }
  if (aiState === "error") {
    return `<div class="panel">
      <div class="sub-section-head"><h3>AI verification</h3><span class="sub-tag pending">Unavailable</span></div>
      <p class="explain-empty">${escapeHtml(aiError || "Verification lookup failed.")}</p>
    </div>`;
  }

  const meta = AI_META[aiKey] || AI_META.unable_to_verify;
  const confidence = (aiData.ai && typeof aiData.ai.confidence === "number") ? aiData.ai.confidence : aiData.heuristic.score;
  const noKeyNote = !aiData.ai
    ? (aiData.aiError
        ? `AI call failed: ${aiData.aiError}`
        : aiData.company
          ? "No AI key configured on that server — showing raw search evidence and a heuristic verdict instead of an AI-written read."
          : "The AI check needs either a company name (for the evidence search) or an AI key on the server (to read the text directly) — neither was available.")
    : "";
  const summary = (aiData.ai && aiData.ai.summary) || noKeyNote;
  const redFlags = (aiData.ai && aiData.ai.redFlags) || [];
  const redFlagsHtml = redFlags.length
    ? `<div class="chip-row" style="margin-top:0.6rem;">${redFlags.map((f) => `<span class="word-chip fraud">${escapeHtml(f)}</span>`).join("")}</div>`
    : "";
  const evidence = aiData.evidence || [];
  const evidenceHtml = evidence
    .slice(0, 6)
    .map(
      (r) => `<div class="evidence-item">
        <a href="${escapeAttr(r.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title || r.link)}</a>
        <p class="evidence-source">${escapeHtml(r.source || "")}</p>
        <p class="evidence-snippet">${escapeHtml(r.snippet || "")}</p>
      </div>`
    )
    .join("");
  const noEvidenceNote = aiData.company && !evidenceHtml
    ? `<p class="explain-empty">No public search results came back for this company/role.</p>`
    : "";

  return `<div class="panel">
    <div class="sub-section-head"><h3>AI verification</h3><span class="sub-tag ${meta.tone}">${meta.label} · ${confidence != null ? Math.round(confidence * 100) + "%" : ""}</span></div>
    ${summary ? `<p class="explain-empty">${escapeHtml(summary)}</p>` : ""}
    ${redFlagsHtml}
    ${evidenceHtml ? `<div class="evidence-list">${evidenceHtml}</div>` : noEvidenceNote}
  </div>`;
}

function escapeAttr(s) {
  return (s || "").replace(/"/g, "&quot;");
}

function renderChipRow(label, words, kind) {
  if (!words || !words.length) {
    return `<div><div class="explain-col-label">${label}</div><p class="explain-empty">No contributing phrases found.</p></div>`;
  }
  const chips = words
    .filter((w) => (kind === "fraud" ? w.weight > 0 : w.weight < 0))
    .slice(0, 8)
    .map((w) => `<span class="word-chip ${kind}">${escapeHtml(w.gram)}</span>`)
    .join("");
  if (!chips) {
    return `<div><div class="explain-col-label">${label}</div><p class="explain-empty">No contributing phrases found.</p></div>`;
  }
  return `<div><div class="explain-col-label">${label}</div><div class="chip-row">${chips}</div></div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ------------------------------------------------------------- history ----
const HISTORY_KEY = "trueplacement_history";
const HISTORY_LIMIT = 40;

async function saveHistoryEntry(result, title, bodyText) {
  const { [HISTORY_KEY]: existing = [] } = await chrome.storage.local.get(HISTORY_KEY);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    title: title || bodyText.slice(0, 60),
    snippet: bodyText.slice(0, 140),
    prediction: result.prediction,
    confidence: result.confidence,
    overridden: result.overridden,
  };
  const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
}

async function renderHistory() {
  const { [HISTORY_KEY]: entries = [] } = await chrome.storage.local.get(HISTORY_KEY);
  els.historyEmpty.hidden = entries.length > 0;
  els.clearHistoryBtn.hidden = entries.length === 0;
  els.historyList.innerHTML = entries
    .map((e) => {
      const isFraud = e.prediction === 1;
      const date = new Date(e.at);
      const timeStr = date.toLocaleDateString('en-US', { month: "short", day: "numeric" }) + " · " + date.toLocaleTimeString('en-US', { hour: "numeric", minute: "2-digit" });
      return `
        <div class="history-card" data-id="${e.id}">
          <div class="history-top">
            <span class="history-title">${escapeHtml(e.title)}</span>
            <span class="history-verdict ${isFraud ? "fraud" : "real"}">${isFraud ? "Fraud" : "Genuine"}</span>
          </div>
          <div class="history-meta">${timeStr} &middot; ${(e.confidence * 100).toFixed(0)}% confidence${e.overridden ? " &middot; rule override" : ""}</div>
          <div class="history-snippet">${escapeHtml(e.snippet)}${e.snippet.length >= 140 ? "…" : ""}</div>
        </div>`;
    })
    .join("");

  els.historyList.querySelectorAll(".history-card").forEach((card) => {
    card.addEventListener("click", async () => {
      const { [HISTORY_KEY]: entries2 = [] } = await chrome.storage.local.get(HISTORY_KEY);
      const entry = entries2.find((e) => e.id === card.dataset.id);
      if (!entry) return;
      els.title.value = entry.title;
      els.desc.value = entry.snippet;
      goToCheckTab();
      showToast("Loaded from history — the snippet is truncated to 140 chars, re-paste the full text to re-check.");
    });
  });
}

els.clearHistoryBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(HISTORY_KEY);
  renderHistory();
});

// Warm the model up in the background so the first Analyze click is instant.
TruePlacementModel.load().then((model) => {
  if (els.footerModelStatus) {
    els.footerModelStatus.textContent = `On-device model (${model.algorithm.replace(/_/g, " ")}) + AI verification`;
  }
});