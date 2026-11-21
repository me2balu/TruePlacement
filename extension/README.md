# TruePlacement — Browser Extension

A Chrome/Edge extension version of the TruePlacement fake-job-posting
detector. It runs the **exact same TF-IDF + Linear SVM model** as the
original Streamlit app (`models/vectorizer.pkl` + `models/best_model.pkl`),
re-implemented in plain JavaScript, so it works **entirely on-device** — no
server, no API calls, no data ever leaves your browser.

## What it does

- **Select text on any page → a small toolbar appears with explicit actions**
  ("Scan for fraud" / dismiss) — nothing analyzes automatically. Choose
  "Scan for fraud" and a panel docks to the right edge of the page (in-page,
  not the browser's native side panel) showing a brief scan animation, then
  the verdict, confidence, and the top reasons why.
- **The full report lives in the same panel** — click "Full report" to
  expand the complete rule-flag checklist and the contributing phrase chips
  inline. This is a local UI toggle, not a cross-context handoff, so it
  can't silently fail to open.
- The panel also has a **quick recheck box** at the bottom to paste and
  analyze different text without leaving it.
- **Right-click a selection → "Check '...' with TruePlacement"** opens the
  browser's native side panel instead, for the full workspace: drag-and-drop,
  page scanning, and your check history.
- The native side panel (toolbar icon) covers the rest:
  - **Drag-and-drop** — drag-select text on the page and drop it into the
    Description box.
  - **"Scan current page"** — best-effort auto-grab of the page's title +
    main text.
  - **History tab** — every posting you check is logged locally.
- Every analysis returns:
  - A verdict (Genuine / Fraudulent) with a confidence meter, styled like
    the original app's "case file" report.
  - The same rule-based red-flag checklist (fee requests, urgency language,
    requests for sensitive info, "no interview" promises, unrealistic pay),
    including the hard override: a fee/deposit request always flips the
    verdict to Fraudulent even if the ML model leans "Genuine".
  - **New: "Why the model leans this way"** — the actual phrases from your
    text that pushed the score toward fraudulent or genuine, ranked by how
    much they mattered (a per-posting explanation, derived directly from the
    trained model's own weights, not a canned message).
  - An out-of-domain notice if the pasted text doesn't look like a job
    posting at all.
- **History tab** — every posting you check this session is logged locally
  (title, verdict, confidence, timestamp) so you can revisit it. Nothing is
  synced anywhere; clear it any time with one button.
- **Badge counter** — the toolbar icon shows how many postings you've caught
  as fraudulent today, as a quick at-a-glance signal.

## Design

Flat, restrained dark theme — a single flat brand blue (`#3a5fff`) rather
than gradient/glow effects, thin hairline borders, Space Grotesk for the
brand mark, Inter for body text, JetBrains Mono for data and labels. The
logo is a flat hexagon badge with a white "T" monogram and a small accent
dot (`icons/`) — not a generic shield-and-checkmark.

The in-page toolbar and panel (`content.js`/`content.css`) render inside a
**Shadow DOM**, so host-page CSS can never bleed into TruePlacement's UI (or
vice versa) regardless of what site you're on.

## Why the in-page panel instead of only the native side panel

Chrome's `chrome.sidePanel.open()` API must be called synchronously inside a
trusted user-gesture callback — even one `await` beforehand can invalidate
that and make it silently fail. That's reliable from a direct toolbar-icon
click or a `contextMenus.onClicked` handler (both used here), but *not*
from a message relayed from a content script's button click, since the
gesture doesn't survive the round-trip. Rather than fight that, the
select-to-scan flow builds its own panel directly in the page, so it works
the same way every time.

## Why on-device instead of a backend server

The original Streamlit app needs Python running somewhere. For a browser
extension, shipping a backend means the user has to host a server (cost,
uptime, and a privacy trade-off — every posting they check would be sent
over the network). Instead, `lib/model.js` re-implements the trained
pipeline's math directly:

- `cleanText()` mirrors `utils.clean_text()` exactly (lowercasing, URL/email/
  HTML/digit/punctuation stripping, the same stopword list used at training
  time, exported verbatim into `lib/model_data.json`).
- The TF-IDF step (unigrams + bigrams, 5000-word vocabulary, IDF weights,
  L2 normalization) is reproduced from the fitted vectorizer's own
  vocabulary/IDF arrays.
- The classifier's own decision function runs directly against the trained
  weights — see "Which algorithm, and why" below for exactly how, since it
  differs depending on which algorithm won.

This was verified against the original scikit-learn pipeline directly (same
prediction and probability values, to full floating-point precision, on
held-out rows) before being wired into the extension — see `test_model.js`
for the check.

## Which algorithm, and why

`scripts/train_from_kaggle.py` trains and benchmarks five algorithms on the
same TF-IDF + metadata features — Logistic Regression, Multinomial Naive
Bayes, Linear SVM, Decision Tree, and Random Forest — all with
class-balanced weighting, since fraud is only ~5% of the Kaggle dataset. It
picks whichever scores best on held-out **fraud-class F1** (accuracy alone
is misleading this imbalanced) and ships that one.

On the current dataset, **Linear SVM wins clearly**:

| Algorithm | Fraud-class F1 | Macro F1 |
|---|---|---|
| **SVM** | **0.823** | **0.907** |
| Random Forest | 0.692 | 0.837 |
| Logistic Regression | 0.665 | 0.821 |
| Naive Bayes | 0.558 | 0.771 |
| Decision Tree | 0.549 | 0.756 |

`model_data.json` records which algorithm won as an `"algorithm"` field, and
`lib/model.js` reads it to pick the right scoring path at inference time —
if a retrain on different/cleaned data ever picks a different winner, no
code changes are needed on the extension or website side:

- **Logistic Regression / Naive Bayes / SVM** all reduce to the same
  `coef · x + intercept` linear form (Naive Bayes's log-odds ratio is
  linear in the TF-IDF counts, so it fits the same schema as the other two)
  — `lib/model.js`'s `scoreLinear()` handles all three.
- **Decision Tree / Random Forest** export sklearn's own tree arrays
  (`feature`, `threshold`, `left`, `right`, `value`) and `lib/model.js`
  replicates the node-by-node traversal (`scoreTree()` / `scoreForest()`,
  the latter averaging leaf probabilities across the forest). This was
  cross-checked against sklearn's own `predict_proba()` on held-out rows
  and reproduces it exactly.

One trade-off worth knowing: the "why the model leans this way" phrase
explanation only works for the linear algorithms, where each n-gram's
contribution is literally `tfidf_value × coef`. Tree/forest models don't
have a per-instance equivalent without extra bookkeeping (e.g. SHAP), so if
one of those ever wins a retrain, that panel will simply show nothing
rather than a misleading approximation.

## Install (unpacked, for development / grading)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the TruePlacement icon to your toolbar. Click it to open the side
   panel.

## Notes / limitations

- The side panel API (`chrome.sidePanel`) needs **Chrome 114+** or a recent
  Chromium-based Edge. It won't work as-is on Firefox (Firefox uses a
  different `sidebar_action` API) — that would need a small manifest
  adaptation.
- "Scan current page" uses a generic heuristic (looks for `<article>`,
  `<main>`, or elements with "description"/"job-desc" in their class/id,
  falling back to the whole page's visible text). It works well on most job
  boards but isn't guaranteed to grab exactly the right block — the text is
  always editable before you hit Analyze.
- Like the original app, this is a decision-support tool, not a guarantee.
  Always verify a placement through your college placement cell or the
  company's official careers page.
