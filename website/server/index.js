require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { verifyOpening } = require("./verify");
const { activeProvider } = require("./llm");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "200kb" }));

// Serve the static frontend (client-side ML model + UI).
app.use(express.static(path.join(__dirname, "..", "public")));

// The AI verification endpoint is the only part of the site that makes
// outbound network calls, so it's the only part that needs rate limiting.
const verifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many verification requests. Please wait a few minutes and try again." },
});

app.post("/api/verify-opening", verifyLimiter, async (req, res) => {
  const { company, role, location, text } = req.body || {};
  const cleanCompany = typeof company === "string" ? company.trim().slice(0, 200) : "";
  const cleanText = typeof text === "string" ? text.trim().slice(0, 8000) : "";
  if (!cleanCompany && !cleanText) {
    return res.status(400).json({ error: "Provide a company name and/or the posting text." });
  }
  try {
    const result = await verifyOpening({
      company: cleanCompany,
      role: (role || "").trim().slice(0, 200),
      location: (location || "").trim().slice(0, 200),
      text: cleanText,
    });
    res.json(result);
  } catch (err) {
    console.error("[verify-opening] failed:", err);
    res.status(502).json({ error: "Verification lookup failed. Please try again shortly." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(activeProvider()),
    aiProvider: activeProvider(),
    searchProvider: process.env.SERPAPI_KEY ? "serpapi" : "duckduckgo",
  });
});

app.listen(PORT, () => {
  console.log(`TruePlacement web server running on http://localhost:${PORT}`);
});