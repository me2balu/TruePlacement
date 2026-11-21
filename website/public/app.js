// app.js — wires the TruePlacement website UI on top of TruePlacementModel
// (lib/model.js, on-device) and the /api/verify-opening backend (AI-assisted).
// A single "Analyze" action runs both and merges them into one verdict.

const ICON_CHECK =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M4.5 12.5l5 5L19.5 7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WARNING =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.2L22 20.8H2L12 3.2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9.8v4.6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1" fill="currentColor"/></svg>';
const ICON_DASH =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M6 12h12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

const HISTORY_KEY = "tp_web_history_v1";
const MAX_HISTORY = 25;

// Fixed extension ID — the extension ships a pinned "key" in manifest.json so
// this ID stays the same whether it's loaded unpacked or from the store.
// If you re-key the extension yourself, update this to match.
const EXTENSION_ID = "gcgifnaaflgbmojodegaeaijbipemnep";

const els = {
  title: document.getElementById("field-title"),
  company: document.getElementById("field-company"),
  location: document.getElementById("field-location"),
  desc: document.getElementById("field-desc"),
  remote: document.getElementById("chk-remote"),
  logo: document.getElementById("chk-logo"),
  questions: document.getElementById("chk-questions"),
  form: document.getElementById("scan-form"),
  analyzeBtn: document.getElementById("btn-analyze"),
  clearBtn: document.getElementById("btn-clear"),
  resultArea: document.getElementById("scan-result"),
  modelStatus: document.getElementById("model-status"),
  historyList: document.getElementById("history-list"),
  historyEmpty: document.getElementById("history-empty"),
  clearHistoryBtn: document.getElementById("btn-clear-history"),

  openExtensionBtn: document.getElementById("btn-open-extension"),
  extensionStatus: document.getElementById("extension-status"),
};

// ---------------------------------------------------------- model preload
TruePlacementModel.load()
  .then((model) => {
    els.modelStatus.textContent = `Model ready (${model.algorithm.replace(/_/g, " ")})`;
    els.modelStatus.style.color = "";
  })
  .catch((err) => {
    console.error(err);
    els.modelStatus.textContent = "Model failed to load — refresh to retry";
    els.modelStatus.style.color = "var(--danger)";
  });

function pct(n) {
  return Math.round(n * 100) + "%";
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return (s || "").replace(/"/g, "&quot;");
}

// ------------------------------------------------------- combined analyze
els.form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.desc.value.trim();
  if (!text) {
    els.desc.focus();
    return;
  }

  const company = els.company.value.trim();
  const role = els.title.value.trim();
  const location = els.location.value.trim();

  els.analyzeBtn.disabled = true;
  els.analyzeBtn.textContent = "Analyzing…";

  let mlResult = null;
  try {
    mlResult = await TruePlacementModel.analyze(text, {
      telecommuting: els.remote.checked,
      hasLogo: els.logo.checked,
      hasQuestions: els.questions.checked,
    });
  } catch (err) {
    console.error(err);
    els.resultArea.className = "card result-card result-empty";
    els.resultArea.innerHTML = `<p class="result-placeholder">Something went wrong analyzing that text. Please try again.</p>`;
    els.analyzeBtn.disabled = false;
    els.analyzeBtn.textContent = "Analyze";
    return;
  }

  // Render the model result immediately; the AI block fills in once (and if)
  // the opening-verification call returns. The AI check now always runs (it
  // can read the text alone even with no company given) — the only way it's
  // skipped is if the server has no AI key AND no company was given, which
  // the "done" render below handles by showing an explanatory state rather
  // than pretending nothing was requested.
  renderCombinedResult({ mlResult, aiState: "loading" });

  saveHistoryEntry({
    title: role || "(untitled posting)",
    company,
    prediction: mlResult.prediction,
    confidence: mlResult.confidence,
    ts: Date.now(),
  });
  renderHistory();

  els.analyzeBtn.disabled = false;
  els.analyzeBtn.textContent = "Analyze";

  try {
    const res = await fetch("/api/verify-opening", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company, role, location, text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Verification failed");
    renderCombinedResult({ mlResult, aiState: "done", aiData: data });
  } catch (err) {
    console.error(err);
    renderCombinedResult({ mlResult, aiState: "error", aiError: err.message });
  }
});

els.clearBtn.addEventListener("click", () => {
  els.title.value = "";
  els.company.value = "";
  els.location.value = "";
  els.desc.value = "";
  els.remote.checked = false;
  els.logo.checked = false;
  els.questions.checked = false;
  els.resultArea.className = "card result-card result-empty";
  els.resultArea.innerHTML = `<p class="result-placeholder">Your combined verdict will appear here — on-device wording analysis plus an AI read of the text and (if you add a company) public evidence.</p>`;
});

// ----------------------------------------------------- combining verdicts
// Merge the two independent signals into one overall call. Text wording and
// "does this opening exist publicly" can disagree — when they do, that's a
// caution state, not a simple average.
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
      ? { tone: "fraud", title: "Likely fraudulent", note: "Based on wording only — the AI check didn't run (no server API key and no company given)." }
      : { tone: "genuine", title: "Likely genuine", note: "Based on wording only — the AI check didn't run (no server API key and no company given)." };
  }
  // Actual evidence of trouble is a strong signal regardless of what the
  // wording model thought.
  if (aiKey === "warning_signs_found")
    return { tone: "fraud", title: "Likely fraudulent", note: "Public warning signs were found for this company/opening." };
  if (aiKey === "likely_genuine") {
    if (mlFraud)
      return { tone: "caution", title: "Mixed signals", note: "The wording matches statistical fraud patterns, but a fuller read plus public evidence suggests this is likely genuine. Still worth a quick check with the official source." };
    return { tone: "genuine", title: "Likely genuine", note: "The wording looks clean and the opening checks out." };
  }
  // aiKey is no_evidence_found or unable_to_verify: genuinely inconclusive
  // from the AI/evidence side — this is NOT agreement with the wording
  // model either way, so defer to it with an honest caveat instead of
  // claiming the two signals "point the same way."
  if (mlFraud)
    return { tone: "fraud", title: "Likely fraudulent", note: "Wording matches fraud patterns; we couldn't independently confirm the opening either way, so treat this as a caution, not a certainty." };
  return { tone: "caution", title: "Likely genuine, unconfirmed", note: "Wording looks clean, but we couldn't independently confirm this specific opening. That alone isn't proof it's fake — verify directly with the company before applying." };
}

function renderCombinedResult({ mlResult, aiState, aiData, aiError }) {
  const mlFraud = mlResult.prediction === 1;
  const aiKey = aiState === "done" ? (aiData.ai && aiData.ai.verdict) || aiData.heuristic.label : null;
  const combined = combineVerdict(mlFraud, aiKey);
  const combinedIcon = combined.tone === "fraud" ? ICON_WARNING : combined.tone === "genuine" ? ICON_CHECK : ICON_DASH;

  // ---- text-analysis sub-block (always available) ----
  const flagsHtml = mlResult.flagResults
    .map((f) => `<li class="flag-item ${f.hit ? "hit" : "miss"}"><span class="flag-dot"></span>${f.label}</li>`)
    .join("");
  const fraudChips = mlResult.topFraudWords
    .filter((c) => c.weight > 0)
    .slice(0, 6)
    .map((c) => `<span class="chip fraud">${escapeHtml(c.gram)}</span>`)
    .join("");
  const genuineChips = mlResult.topGenuineWords
    .filter((c) => c.weight < 0)
    .slice(0, 6)
    .map((c) => `<span class="chip genuine">${escapeHtml(c.gram)}</span>`)
    .join("");
  const outOfDomainNotice = mlResult.outOfDomain
    ? `<div class="notice-banner">This text doesn't look much like a job posting — the wording verdict may not be meaningful.</div>`
    : "";

  const textBlock = `
    <div class="sub-section">
      <div class="sub-section-head">
        <h5>Text analysis <span class="meta-caption" style="margin-left:4px;">(on-device)</span></h5>
        <span class="sub-tag ${mlFraud ? "fraud" : "genuine"}">${mlFraud ? "Fraud patterns" : "Clean wording"} · ${pct(mlResult.confidence)}</span>
      </div>
      ${outOfDomainNotice}
      <ul class="flag-list">${flagsHtml}</ul>
      ${fraudChips || genuineChips ? `<div class="chip-row">${fraudChips}${genuineChips}</div>` : ""}
    </div>`;

  // ---- AI verification sub-block (loading / done / error) ----
  let aiBlock = "";
  if (aiState === "loading") {
    aiBlock = `
    <div class="sub-section">
      <div class="sub-section-head">
        <h5>AI verification</h5>
        <span class="sub-tag pending">Checking…</span>
      </div>
      <p class="meta-caption" style="margin:0;">Reading the posting text and checking for public evidence about the company.</p>
    </div>`;
  } else if (aiState === "error") {
    aiBlock = `
    <div class="sub-section">
      <div class="sub-section-head">
        <h5>AI verification</h5>
        <span class="sub-tag pending">Failed</span>
      </div>
      <p class="meta-caption" style="margin:0;">${escapeHtml(aiError || "Verification lookup failed.")}</p>
    </div>`;
  } else if (aiState === "done") {
    const meta = AI_META[aiKey] || AI_META.unable_to_verify;
    const confidence = (aiData.ai && typeof aiData.ai.confidence === "number") ? aiData.ai.confidence : aiData.heuristic.score;
    const noKeyNote = !aiData.ai
      ? (aiData.aiError
          ? `AI call failed: ${aiData.aiError}`
          : aiData.company
            ? "No ANTHROPIC_API_KEY configured on the server — showing raw search evidence and a heuristic verdict instead of an AI-written read."
            : "The AI check needs either a company name (for the evidence search) or an ANTHROPIC_API_KEY on the server (to read the text directly) — neither was available, so nothing ran here.")
      : "";
    const summary = (aiData.ai && aiData.ai.summary) || noKeyNote;
    const redFlagsHtml = (aiData.ai && aiData.ai.redFlags && aiData.ai.redFlags.length)
      ? `<div class="chip-row">${aiData.ai.redFlags.map((f) => `<span class="chip fraud">${escapeHtml(f)}</span>`).join("")}</div>`
      : "";
    const evidenceHtml = (aiData.evidence || [])
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
      ? `<p class="meta-caption" style="margin:0;">No public search results came back for this company/role.</p>`
      : "";
    aiBlock = `
    <div class="sub-section">
      <div class="sub-section-head">
        <h5>AI verification</h5>
        <span class="sub-tag ${meta.tone}">${meta.label} · ${pct(confidence)}</span>
      </div>
      ${summary ? `<p style="margin:0;font-size:13px;color:var(--text-dim);">${escapeHtml(summary)}</p>` : ""}
      ${redFlagsHtml}
      ${evidenceHtml ? `<div class="evidence-list">${evidenceHtml}</div>` : noEvidenceNote}
    </div>`;
  }

  els.resultArea.className = `card result-card verdict-${combined.tone}`;
  els.resultArea.innerHTML = `
    <div class="verdict-head">
      <div class="verdict-icon">${combinedIcon}</div>
      <div>
        <p class="verdict-title">${combined.title}</p>
        <p class="verdict-sub">${escapeHtml(combined.note)}</p>
      </div>
    </div>
    <hr class="result-divider" />
    ${textBlock}
    <hr class="result-divider" />
    ${aiBlock}
  `;
}

// ----------------------------------------------------------------- history
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}
function saveHistoryEntry(entry) {
  const list = loadHistory();
  list.unshift(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
}
function renderHistory() {
  const list = loadHistory();
  els.historyEmpty.hidden = list.length > 0;
  els.clearHistoryBtn.hidden = list.length === 0;
  els.historyList.innerHTML = list
    .map((h) => {
      const tag = h.prediction === 1 ? "fraud" : "genuine";
      const label = h.prediction === 1 ? "Fraud" : "Genuine";
      const date = new Date(h.ts).toLocaleString();
      const meta = [h.company, date].filter(Boolean).join(" · ");
      return `<div class="history-item">
        <div class="history-item-left">
          <div class="history-item-title">${escapeHtml(h.title)}</div>
          <div class="history-item-meta">${escapeHtml(meta)}</div>
        </div>
        <span class="history-item-tag ${tag}">${label}</span>
      </div>`;
    })
    .join("");
}
els.clearHistoryBtn.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});
renderHistory();

// ------------------------------------------------------------ open extension
// The extension declares "externally_connectable" for this site's origin, so
// a plain webpage button can ping it and ask it to open its side panel —
// no store listing or protocol handler needed.
els.openExtensionBtn.addEventListener("click", () => {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
    els.extensionStatus.textContent = "This only works in Chrome/Edge desktop — install it from the folder below.";
    return;
  }

  els.extensionStatus.textContent = "Looking for the extension…";
  chrome.runtime.sendMessage(EXTENSION_ID, { type: "TP_PING" }, (pingResponse) => {
    if (chrome.runtime.lastError || !pingResponse) {
      els.extensionStatus.textContent = "Not installed yet — load it unpacked from the folder below, then try again.";
      return;
    }
    chrome.runtime.sendMessage(EXTENSION_ID, { type: "TP_OPEN_PANEL" }, (openResponse) => {
      if (chrome.runtime.lastError || !openResponse || !openResponse.opened) {
        els.extensionStatus.textContent = "Installed — click the TruePlacement icon in your toolbar to open it (Chrome blocks auto-opening the panel from a webpage).";
      } else {
        els.extensionStatus.textContent = "Opened.";
      }
    });
  });
});