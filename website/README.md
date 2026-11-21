# TruePlacement — Website

The website counterpart to the TruePlacement browser extension: any user, on
any device, can paste a job/internship posting and get a fraud verdict — and
optionally get an AI-assisted check for whether the opening actually exists.

## What it does

**1. Scan a posting (100% on-device, no server call)**
The model that scores your posting is whichever algorithm won a five-way
benchmark — Logistic Regression, Naive Bayes, Linear SVM, Decision Tree,
Random Forest — trained on the same TF-IDF + metadata features (see
`extension/README.md` → "Which algorithm, and why" for the full comparison
table; Linear SVM currently wins). `public/lib/model.js` reads the
`model_data.json`'s `"algorithm"` field and runs whichever scoring path
that algorithm needs — the posting text never leaves the device for this
part.

- Verdict (Genuine / Fraudulent) with a confidence meter
- The rule-based red-flag checklist (fee requests, urgency language, requests
  for sensitive info, "no interview" promises, unrealistic pay) — a fee/
  deposit request always flips the verdict to Fraudulent
- "Why the model leans this way" — the actual phrases from the pasted text
  that pushed the score, ranked by contribution
- A local, on-device history (localStorage) of postings checked this browser

**2. Verify this opening (AI-assisted, new — needs the backend)**
A wording-based scan can only judge *how* a posting is written, not whether
the opening is real. This feature takes a company (+ role/location) and:

1. Runs a few targeted web searches for the company's official careers page,
   the role on major job boards, and any public scam/fraud reports.
2. Scores that evidence with a heuristic (official-domain hit? known job
   board hit? scam-warning hit? nothing at all?).
3. If an Anthropic API key is configured, hands the evidence to Claude to
   write a short, evidence-grounded explanation and a verdict:
   `likely_genuine`, `unable_to_verify`, `no_evidence_found`, or
   `warning_signs_found`.

Only the company/role/location go to the server for this — never the pasted
posting text from step 1.

## Project layout

```
website/
  public/            static frontend — served as-is, no build step
    index.html
    styles.css
    app.js
    lib/model.js         on-device inference (ported from extension/lib/model.js)
    lib/model_data.json  trained vocabulary/weights (copied from the extension)
  server/
    index.js          Express app: serves public/ + the API
    search.js          pluggable web search (SerpAPI or DuckDuckGo fallback)
    verify.js          heuristic scoring + optional Claude synthesis
  package.json
  .env.example
```

## Run it locally

```bash
npm install
cp .env.example .env   # optional — see below
npm start               # http://localhost:3000
```

Without any `.env` values, the site fully works for scanning postings
(client-side). The "Verify this opening" feature will also run — using the
no-key DuckDuckGo fallback for search — but without `ANTHROPIC_API_KEY` it
shows the raw search evidence and a heuristic verdict instead of a
written AI explanation.

### Optional environment variables

| Variable | Effect if unset |
|---|---|
| `SERPAPI_KEY` | Falls back to scraping DuckDuckGo's HTML results (works, but lower quality / easier to rate-limit). Get a free-tier key at serpapi.com for better results. |
| `ANTHROPIC_API_KEY` | "Verify this opening" skips the AI-written summary and shows only the heuristic verdict + raw evidence. Get a key at console.anthropic.com. |
| `CLAUDE_MODEL` | Defaults to `claude-sonnet-5`. Check https://docs.claude.com if this model string stops working. |
| `PORT` | Defaults to `3000`. |

## Deploying

This is a plain Node/Express app — no framework lock-in. Any of these work:

- **Render / Railway / Fly.io** — connect the repo, set the build command to
  `npm install` and the start command to `npm start`, add your env vars in
  the dashboard.
- **A VPS** — `npm install --production && npm start` behind nginx/Caddy, or
  run it under `pm2`/`systemd`.
- **Vercel/Netlify serverless** — works too, but you'll need to convert
  `server/index.js`'s routes into serverless functions (the static `public/`
  folder can be served as-is either way).

Set `SERPAPI_KEY` and `ANTHROPIC_API_KEY` as secrets in whichever platform
you use — never commit `.env`.

## Security / rate limiting notes

- `/api/verify-opening` is rate-limited (20 requests / 10 min / IP) since
  it's the only route that makes outbound calls and costs money once keys
  are configured.
- Company/role/location inputs are trimmed and length-capped before use.
- CORS is open by default since this is a public tool with no accounts; tighten
  `cors()` in `server/index.js` if you deploy this behind a specific domain
  only.

## Relationship to the browser extension

`extension/` (unchanged) is the Manifest V3 Chrome/Edge extension version —
same model, same math, packaged for select-to-scan on any page. This website
reuses its `lib/model.js` / `lib/model_data.json` verbatim (only the loader
was adapted from `chrome.runtime.getURL` to a plain `fetch`), so both stay in
sync with the same trained model. If you retrain the model, re-export
`model_data.json` and copy it into both `extension/lib/` and
`website/public/lib/`.

## Limitations

- The AI verification feature is best-effort: absence of search results
  doesn't prove a posting is fake (small/new employers may have little
  online footprint), and presence of a careers-page hit doesn't guarantee
  the specific opening or its terms are legitimate. Always confirm directly
  with the company's official channels before applying or paying anything.
- Like the extension, this is decision support, not a guarantee.
