// server/llm.js
// --------------
// One function, two possible backends, identical output shape. This is the
// only file that knows which AI provider is in use — verify.js just calls
// callLLM() and gets text back, regardless of which one answered.
//
// Priority: GROQ_API_KEY first (genuinely free — no credit card, generous
// daily limits, OpenAI-compatible API), then ANTHROPIC_API_KEY as an
// alternative if you have Anthropic credits and prefer Claude's quality.
// Neither set -> callLLM() isn't invoked at all (see verify.js).
//
// Get a free Groq key: console.groq.com -> API Keys -> Create API Key
// (no card required). Get an Anthropic key: console.anthropic.com.

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b"; // free-tier, strong reasoning; see .env.example for alternatives
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

function activeProvider() {
  if (GROQ_API_KEY) return "groq";
  if (ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

async function callGroq(system, user) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 600,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Groq API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callAnthropic(system, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

/**
 * @returns {Promise<{text: string, provider: string}>}
 */
async function callLLM(system, user) {
  const provider = activeProvider();
  if (!provider) throw new Error("No LLM provider configured (set GROQ_API_KEY or ANTHROPIC_API_KEY)");
  const text = provider === "groq" ? await callGroq(system, user) : await callAnthropic(system, user);
  return { text, provider };
}

module.exports = { callLLM, activeProvider };