// server/search.js
// ------------------
// Web search used by the AI verification feature. This module is what lets
// the site check whether a company actually has a matching opening posted
// anywhere public. Text scanning (the on-device ML model) never calls
// this at all.
//
// Provider priority:
//   1. SerpAPI (if SERPAPI_KEY is set) — reliable structured Google results.
//   2. DuckDuckGo HTML endpoint (no key needed).
//   3. Bing HTML endpoint (no key needed) — tried per-query if DuckDuckGo
//      comes back empty for that query, since HTML-scraping any one search
//      engine is inherently fragile (markup changes, rate limiting) and a
//      single provider going quiet shouldn't mean "no evidence found" when
//      there may well be evidence.

const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

async function searchWithSerpApi(query) {
  const url =
    "https://serpapi.com/search.json?engine=google&num=8&q=" +
    encodeURIComponent(query) +
    "&api_key=" +
    encodeURIComponent(SERPAPI_KEY);
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("SerpAPI request failed: " + res.status);
  const data = await res.json();
  const organic = data.organic_results || [];
  return organic.slice(0, 8).map((r) => ({
    title: r.title || "",
    link: r.link || "",
    snippet: r.snippet || "",
    source: hostnameOf(r.link || ""),
  }));
}

async function searchWithDuckDuckGo(query) {
  const url = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("DuckDuckGo request failed: " + res.status);
  const html = await res.text();

  const results = [];
  // Lightweight regex scrape of DDG's server-rendered HTML result markup.
  // Best-effort: DDG's markup can change, so this degrades to an empty
  // array rather than throwing if the shape shifts — searchOpening() below
  // falls through to Bing when that happens.
  const blockRe = /<div class="result results_links[^"]*"[\s\S]*?<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = blockRe.exec(html)) && results.length < 8) {
    let link = match[1];
    // DDG wraps outbound links in a redirect; unwrap uddg= param if present.
    try {
      const u = new URL(link, "https://duckduckgo.com");
      const real = u.searchParams.get("uddg");
      if (real) link = decodeURIComponent(real);
    } catch {
      // keep link as-is
    }
    results.push({ title: stripTags(match[2]), link, snippet: stripTags(match[3]), source: hostnameOf(link) });
  }
  return results;
}

async function searchWithBing(query) {
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(query);
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("Bing request failed: " + res.status);
  const html = await res.text();

  const results = [];
  // Bing's organic results sit in <li class="b_algo"> blocks with an <h2><a>
  // title/link and a snippet paragraph. Same best-effort/degrade-to-empty
  // approach as the DuckDuckGo scraper above.
  const blockRe = /<li class="b_algo"[\s\S]*?<h2>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p>([\s\S]*?)<\/p>/g;
  let match;
  while ((match = blockRe.exec(html)) && results.length < 8) {
    const link = match[1];
    results.push({ title: stripTags(match[2]), link, snippet: stripTags(match[3]), source: hostnameOf(link) });
  }
  return results;
}

async function searchOneQuery(query) {
  if (SERPAPI_KEY) {
    try {
      const results = await searchWithSerpApi(query);
      return { results, provider: "serpapi" };
    } catch (err) {
      console.warn("[search] serpapi failed, falling back:", query, err.message);
    }
  }

  try {
    const ddg = await searchWithDuckDuckGo(query);
    if (ddg.length > 0) return { results: ddg, provider: "duckduckgo" };
  } catch (err) {
    console.error("[search] duckduckgo failed:", query, err.message);
  }
  try {
    const bing = await searchWithBing(query);
    return { results: bing, provider: "bing" };
  } catch (err) {
    console.error("[search] bing failed:", query, err.message);
    return { results: [], provider: "duckduckgo" };
  }
}

/**
 * Run a handful of targeted queries about a company + role and return a
 * merged, de-duplicated list of search results (title, link, snippet, source).
 */
async function searchOpening({ company, role, location }) {
  const base = [company, role].filter(Boolean).join(" ");
  const queries = [
    `${base} official careers page`,
    `${company} careers ${role}`,
    `${company} scam OR fraud OR fake job reviews`,
  ].filter((q) => q.trim().length > 0);

  const seen = new Set();
  const all = [];
  let lastProvider = SERPAPI_KEY ? "serpapi" : "duckduckgo";
  for (const q of queries) {
    const { results, provider } = await searchOneQuery(q);
    lastProvider = provider;
    for (const r of results) {
      const key = r.link || r.title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push({ ...r, query: q });
    }
  }
  return { results: all, provider: lastProvider };
}

module.exports = { searchOpening };