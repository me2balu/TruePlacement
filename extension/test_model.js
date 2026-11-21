const fs = require("fs");
const path = require("path");

global.chrome = { runtime: { getURL: (p) => p } };
global.fetch = async (p) => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, p), "utf8"));
  return { json: async () => data };
};

// Load model.js by eval'ing it in this context (it's an IIFE assigning
// TruePlacementModel, no module.exports, so grab it off globalThis after eval)
const src = fs.readFileSync(path.join(__dirname, "lib/model.js"), "utf8");
eval(src + "\nglobalThis.TruePlacementModel = TruePlacementModel;");

const SAMPLE_SCAM =
  "Congratulations! You have been shortlisted for a guaranteed Work-From-Home " +
  "placement with Global Data Solutions Pvt Ltd. Salary: Rs. 45,000/month, no " +
  "interview required. To confirm your seat, please pay a refundable registration " +
  "fee of Rs. 1,500 within 24 hours. Limited seats available, act immediately. " +
  "Share your bank account details and Aadhar number to process your offer letter.";

const SAMPLE_REAL =
  "Software Engineering Intern - Backend Team. We're looking for a Computer " +
  "Science student with experience in Python or Node.js to join our engineering " +
  "team for a 6-month paid internship. Responsibilities include building REST " +
  "APIs, writing unit tests, and collaborating with senior engineers in code " +
  "review. Please apply through our careers portal with your resume and GitHub " +
  "profile. Interviews will be conducted over two technical rounds.";

(async () => {
  const model = await TruePlacementModel.load();
  console.log("Algorithm:", model.algorithm, "\n");

  for (const [name, text] of [["SCAM", SAMPLE_SCAM], ["REAL", SAMPLE_REAL]]) {
    const r = await TruePlacementModel.analyze(text, {});
    console.log(
      name,
      "prediction=", r.prediction,
      "decision=", r.decision.toFixed(4),
      "confidence=", r.confidence.toFixed(4),
      "overridden=", r.overridden,
      "mentionsFee=", r.mentionsFee,
      "outOfDomain=", r.outOfDomain
    );
    console.log("  top fraud-pushing:", r.topFraudWords.slice(0, 5).map((c) => `${c.gram}(${c.weight.toFixed(3)})`).join(", "));
    console.log("  top genuine-pushing:", r.topGenuineWords.slice(0, 5).map((c) => `${c.gram}(${c.weight.toFixed(3)})`).join(", "));
  }

  const gibberish = await TruePlacementModel.analyze("the quick brown fox jumps over the lazy dog in the park today", {});
  console.log("GIBBERISH outOfDomain=", gibberish.outOfDomain);
})();
