# TruePlacement — Fake Job / Internship Posting Detector

TruePlacement helps students spot fraudulent job and internship postings. It ships in two forms that share **one trained model**:

- **Browser extension** (Chrome/Edge, Manifest V3): select text on any page and scan it.
- **Website** (Node/Express): paste a posting to scan it, and optionally run an AI-assisted "Verify this opening" check.

Scanning runs **fully on-device** (in the browser). The posting text is never sent to a server.

---

## Project workflow (end to end)

```
Kaggle dataset  ->  Clean + features  ->  Train 5 models  ->  Pick best (fraud F1)
      |                                                              |
      |                                                              v
      |                                                   Export model_data.json
      |                                                              |
      |                                       +----------------------+----------------------+
      |                                       v                                             v
      |                          extension/lib/model.js                         website/public/lib/model.js
      |                          (on-device inference)                          (on-device inference)
      |                                       |                                             |
      |                                       v                                             v
      |                         Select text -> Scan -> Verdict                  Paste text -> Scan -> Verdict
      |                                                                                      |
      |                                                                                      v (optional)
      |                                                                       "Verify this opening"
      |                                                                       Express API -> web search
      |                                                                       -> heuristic score -> LLM summary
```

### Step 1 — Data
- Dataset: Kaggle **Real / Fake Job Posting** (`fake_job_postings.csv`).
- Only about 5% of postings are fraudulent, so the data is heavily imbalanced.
- Title, company profile, description, requirements and benefits are merged into one text field per posting.
- Missing values are filled, not dropped.
- The CSV is large (~48 MB), so it is **not stored in this repo**. Download it from Kaggle and place it in `extension/scripts/`.

### Step 2 — Text cleaning and features
- Cleaning: lowercase, strip URLs, emails, HTML, digits and punctuation, remove stopwords and 1-character tokens.
- The same cleaning is implemented in Python (training) and JavaScript (`lib/model.js`) so both behave identically.
- TF-IDF: unigrams + bigrams, 5000 features.
- 4 extra metadata features: `telecommuting`, `has_company_logo`, `has_questions`, `mentions_fee`.

### Step 3 — Train and compare 5 algorithms
`extension/scripts/train_from_kaggle.py` trains all five on a stratified 80/20 split with class-balanced weights:

| Algorithm | Fraud-class F1 | Macro F1 |
|---|---|---|
| **Linear SVM (winner)** | **0.823** | **0.907** |
| Random Forest | 0.692 | 0.837 |
| Logistic Regression | 0.665 | 0.821 |
| Naive Bayes | 0.558 | 0.771 |
| Decision Tree | 0.549 | 0.756 |

The winner is chosen by **fraud-class F1**, because plain accuracy is misleading on imbalanced data.

### Step 4 — Export for on-device use
- The winning model is refit on the full dataset and exported to `extension/lib/model_data.json`.
- The file holds the vocabulary, IDF weights, stopwords, metadata order, model weights and an `algorithm` field.
- `lib/model.js` reads `algorithm` and picks the right scoring path (linear or tree/forest), so a retrain needs no code changes.
- `extension/test_model.js` checks the JavaScript output on a sample scam and a sample real posting.

### Step 5 — Inference (extension and website)
For every scanned text:
1. Clean the text and build the TF-IDF vector.
2. Score with the model and convert to a confidence value.
3. Apply **rule-based red flags**: fee or deposit requests, urgency language, requests for sensitive info, "no interview" promises, unrealistic pay. A fee request **always** flips the verdict to Fraudulent.
4. Show the verdict, confidence, red-flag checklist, and "Why the model leans this way" (the phrases that pushed the score, from the model's own weights).

**Extension extras:** in-page panel (Shadow DOM), right-click "Check with TruePlacement", side panel with drag-and-drop and page scan, local history, and a badge counter.
**Website extras:** local history in the browser (localStorage).

### Step 6 — "Verify this opening" (website only, optional)
The text scan judges how a posting is *written*, not whether the opening is *real*. This step:
1. Runs web searches (SerpAPI, or a DuckDuckGo fallback) for the company's careers page, job-board listings and scam reports.
2. Scores the evidence with a heuristic.
3. If an LLM key is set (Groq or Anthropic), asks the LLM for a short evidence-based explanation and one verdict: `likely_genuine`, `unable_to_verify`, `no_evidence_found` or `warning_signs_found`.

Only company, role and location go to the server for this step. The endpoint is rate-limited to 20 requests per 10 minutes per IP.

---

## Repository structure

```
trueplacement-project/
├── extension/
│   ├── manifest.json            # MV3 config
│   ├── background.js            # service worker (context menu, badge, side panel)
│   ├── content.js / content.css # in-page select-to-scan UI
│   ├── sidepanel.html/.js/.css  # side panel workspace + history
│   ├── lib/model.js             # on-device inference
│   ├── lib/model_data.json      # trained model
│   ├── scripts/train_from_kaggle.py   # training + benchmark + export
│   ├── test_model.js            # sanity test
│   └── icons/
└── website/
    ├── server/ index.js, search.js, verify.js, llm.js
    ├── public/ index.html, app.js, styles.css, lib/
    ├── package.json
    └── .env.example
```

---

## How to run

### Extension
1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder (Chrome 114+ needed for the side panel).

### Website
```bash
cd website
npm install
cp .env.example .env     # optional: add your own keys
npm start                # http://localhost:3000
```
Without any keys, scanning still works. Add keys only to improve "Verify this opening".

### Retrain the model (optional)
```bash
cd extension/scripts
pip install pandas scikit-learn numpy
# put fake_job_postings.csv in this folder (download from Kaggle)
python train_from_kaggle.py
# then copy the new model into the website:
cp ../lib/model_data.json ../../website/public/lib/model_data.json
```

### Test the model
```bash
cd extension
node test_model.js
```

---

## Environment variables (website)

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3000) |
| `SERPAPI_KEY` | Better web search (falls back to DuckDuckGo) |
| `GROQ_API_KEY` | Free LLM for the verification summary (used first if set) |
| `ANTHROPIC_API_KEY` | Alternative LLM provider |
| `GROQ_MODEL`, `CLAUDE_MODEL` | Optional model overrides |

**Never commit `.env`.** It is listed in `.gitignore`.

---

## Tech stack
Python, scikit-learn, pandas, NumPy (training) · JavaScript, Chrome Extension MV3 (extension) · Node.js, Express (website) · SerpAPI / DuckDuckGo, Groq / Anthropic (verification).

## Limitations
- This is decision support, not a guarantee. Always confirm with the company's official careers page or your placement cell before paying or sharing documents.
- The model is trained on English postings, so accuracy on other languages or formats may be lower.
- "Why the model leans this way" works only for linear models (not trees/forests).
- Verification is best-effort: no search results does not prove a posting is fake.
- The Chrome extension needs Chrome 114+ or a recent Edge; Firefox is not supported as-is.

