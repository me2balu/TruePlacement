// server/verify.js
// ------------------
// The AI-assisted layer of the analysis. Two independent inputs feed it,
// and either alone is enough to produce a verdict:
//   1. Public evidence — a handful of web searches (server/search.js) for
//      the company's official careers page, the role on job boards, and
//      any public scam reports, scored by simple heuristics.
//   2. The posting text itself — if an LLM provider is configured (see
//      server/llm.js — Groq is free, Anthropic is an optional paid
//      alternative), it reads the actual pasted text (tone, specificity,
//      red flags) alongside whatever evidence was found, and writes one
//      combined verdict rather than judging company-existence in
//      isolation. This is what lets the AI catch things the on-device
//      wording model misses (and vice versa) — e.g. a real company's own
//      posting that happens to trip the trained model's n-gram patterns.
//
// Without a company, there's nothing to search for, but the LLM can still
// read the text alone. Without any LLM provider configured, there's no
// text-reading step, but a company still gets the heuristic-only evidence
// check as before. The only truly empty case is no company AND no key.

const { searchOpening } = require("./search");
const { callLLM } = require("./llm");

const MAX_TEXT_CHARS = 6000; // keep prompts small and cheap; postings rarely need more than this to judge

const KNOWN_JOB_BOARDS = [
  "linkedin.com", "indeed.com", "glassdoor.com", "naukri.com", "monster.com",
  "ziprecruiter.com", "simplyhired.com", "angel.co", "wellfound.com",
  "internshala.com", "shine.com", "foundit.in",
];
const SCAM_SIGNAL_WORDS = /\b(scam|fraud|fake job|phishing|ponzi|too good to be true|never received)\b/i;

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function looksLikeOfficialDomain(source, company) {
  if (!source || !company) return false;
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, "");
  const host = source.toLowerCase().replace(/[^a-z0-9.]/g, "");
  return slug.length > 2 && host.replace(/\./g, "").includes(slug);
}

function heuristicVerdict({ results, company }) {
  if (!company) return { label: "not_applicable", score: 0.5, officialHits: 0, boardHits: 0, scamHits: 0 };

  const officialHits = results.filter((r) => looksLikeOfficialDomain(r.source, company));
  const boardHits = results.filter((r) => KNOWN_JOB_BOARDS.some((b) => r.source.includes(b)));
  const scamHits = results.filter(
    (r) => SCAM_SIGNAL_WORDS.test(r.title) || SCAM_SIGNAL_WORDS.test(r.snippet)
  );

  let label = "unable_to_verify";
  let score = 0.5;

  if (scamHits.length >= 1) {
    label = "warning_signs_found";
    score = 0.2;
  } else if (officialHits.length >= 1 || boardHits.length >= 2) {
    label = "likely_genuine";
    score = 0.8;
  } else if (results.length === 0) {
    label = "no_evidence_found";
    score = 0.35;
  }

  return { label, score, officialHits: officialHits.length, boardHits: boardHits.length, scamHits: scamHits.length };
}

async function llmSynthesis({ text, company, role, location, results, heuristic }) {
  if (!activeProviderCheck()) return null;

  const evidence = results
    .slice(0, 12)
    .map((r, i) => `[${i + 1}] ${r.source || hostnameOf(r.link)} — "${r.title}"\n${r.snippet}\nURL: ${r.link}`)
    .join("\n\n");

  const system =
    "You are a careful assistant helping someone judge whether a job or internship " +
    "posting is a scam before they apply, pay any fee, or share personal data. You may be " +
    "given the posting's own text, web search snippets about the company, or both — use " +
    "whatever you're given and say plainly when something wasn't provided. Judge the text on " +
    "its own merits: tone, specificity, professionalism, red flags (fee requests, urgency, " +
    "requests for sensitive info, guarantees with no interview, unrealistic pay) — the same " +
    "kind of thing a careful human reader would notice. Combine that with the search evidence " +
    "if there is any. Never invent facts about the company that aren't in what you were given. " +
    "Respond ONLY with minified JSON, no prose, no markdown fences, matching this shape: " +
    '{"verdict":"likely_genuine|unable_to_verify|no_evidence_found|warning_signs_found",' +
    '"confidence":0-1 number,"summary":"2-3 sentence plain-English explanation",' +
    '"redFlags":["short phrase",...]}' +
    ' redFlags is 0-4 short specific things (from the text or the evidence) that most influenced ' +
    "your verdict, empty array if none stood out.";

  const parts = [`Company: ${company || "(not given)"}`, `Role: ${role || "(not given)"}`, `Location: ${location || "(not given)"}`];
  if (text) parts.push(`\nPosting text:\n${text.slice(0, MAX_TEXT_CHARS)}`);
  parts.push(`\nSearch evidence:\n${evidence || "(no search performed or no results found)"}`);
  if (company) {
    parts.push(
      `\nA heuristic pre-check of the evidence found: ${heuristic.officialHits} official-domain hit(s), ` +
        `${heuristic.boardHits} known job-board hit(s), ${heuristic.scamHits} scam-warning hit(s).`
    );
  }
  parts.push("\nWeigh everything given and produce the JSON verdict.");
  const user = parts.join("\n");

  const { text: raw } = await callLLM(system, user);
  if (!raw) return null;
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.redFlags)) parsed.redFlags = [];
    return parsed;
  } catch {
    return { verdict: heuristic.label, confidence: heuristic.score, summary: raw.slice(0, 500), redFlags: [] };
  }
}

function activeProviderCheck() {
  return Boolean(process.env.GROQ_API_KEY || process.env.ANTHROPIC_API_KEY);
}

/**
 * @param {object} params
 * @param {string} [params.text] - the posting's own text, read directly by Claude if a key is configured
 * @param {string} [params.company] - if given, triggers the public-evidence web search
 * @param {string} [params.role]
 * @param {string} [params.location]
 */
async function verifyOpening({ text, company, role, location }) {
  let results = [];
  let provider = null;
  if (company) {
    const searchResult = await searchOpening({ company, role, location });
    results = searchResult.results;
    provider = searchResult.provider;
  }
  const heuristic = heuristicVerdict({ results, company });

  let ai = null;
  let aiError = null;
  if (company || text) {
    try {
      ai = await llmSynthesis({ text, company, role, location, results, heuristic });
    } catch (err) {
      aiError = err.message;
    }
  }

  return {
    company: company || null,
    role: role || null,
    location: location || null,
    searchProvider: provider,
    evidence: results.slice(0, 12),
    heuristic,
    ai, // null if ANTHROPIC_API_KEY wasn't set, neither text nor company was given, or the call failed
    aiError,
  };
}

module.exports = { verifyOpening };