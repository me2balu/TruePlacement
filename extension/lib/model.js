/**
 * model.js
 * --------
 * On-device inference for whichever algorithm train_from_kaggle.py picked as
 * the winner (see scripts/train_from_kaggle.py) — Logistic Regression,
 * Naive Bayes, and Linear SVM all export as a coef+intercept linear model;
 * Decision Tree and Random Forest export as sklearn's own tree arrays,
 * replicated node-by-node here. model_data.json's "algorithm" field says
 * which path to take; nothing else in this file needs to change if you
 * retrain and a different algorithm wins.
 *
 * This is the extension build (chrome.runtime.getURL for model_data.json).
 * The website ships an identical copy at website/public/lib/model.js, only
 * differing in how it locates model_data.json (plain fetch instead of
 * chrome.runtime) — keep both in sync when retraining.
 *
 * Feature layout matches training exactly: 5000 TF-IDF dimensions followed by
 * 4 metadata dimensions [telecommuting, has_company_logo, has_questions, mentions_fee].
 */

const TruePlacementModel = (() => {
  let MODEL = null; // populated by load()

  async function load() {
    if (MODEL) return MODEL;
    const url = chrome.runtime.getURL("lib/model_data.json");
    const res = await fetch(url);
    const data = await res.json();

    const algorithm = data.algorithm || "svm"; // older exports predate the field
    MODEL = {
      algorithm,
      vocab: data.vocab,
      idf: Float64Array.from(data.idf),
      stopwords: new Set(data.stopwords),
      metaOrder: data.meta_order,
    };
    if (algorithm === "logistic_regression" || algorithm === "naive_bayes" || algorithm === "svm") {
      MODEL.coef = Float64Array.from(data.coef);
      MODEL.intercept = data.intercept;
    } else if (algorithm === "decision_tree") {
      MODEL.tree = data.tree;
    } else if (algorithm === "random_forest") {
      MODEL.trees = data.trees;
    } else {
      throw new Error("Unknown model algorithm: " + algorithm);
    }
    return MODEL;
  }

  // ---- Rule-based red flags (ported 1:1 from app.py RULE_BASED_FLAGS) ----
  const RULE_BASED_FLAGS = [
    {
      key: "fee",
      label: "Requests a fee, deposit, or refundable payment",
      pattern: /registration fee|processing fee|deposit|pay to apply|refundable|security fee/i,
    },
    {
      key: "urgency",
      label: "Uses high-pressure urgency language",
      pattern: /act (now|immediately)|limited seats|within 24 hours|hurry|immediate joining|urgent(ly)?/i,
    },
    {
      key: "sensitive_info",
      label: "Asks for sensitive personal/financial details upfront",
      pattern: /bank account|aadhar|otp|credit card|debit card|pan card|cvv/i,
    },
    {
      key: "no_interview",
      label: "Promises a job with no interview or screening",
      pattern: /no interview|without interview|guaranteed (job|placement|selection)/i,
    },
    {
      key: "unrealistic_pay",
      label: "Unrealistic pay for minimal effort / experience",
      pattern: /easy money|earn.{0,15}(daily|per day)|work.{0,10}\bfrom home\b.{0,20}no experience/i,
    },
  ];

  // Out-of-domain sanity guard, ported from looks_like_job_posting()
  const JOB_POSTING_KEYWORDS = new RegExp(
    "\\b(" +
      [
        "job", "jobs", "hiring", "hire", "vacancy", "vacancies", "position", "role",
        "opening", "openings", "salary", "stipend", "ctc", "pay", "compensation",
        "apply", "applicant", "application", "resume", "cv", "interview", "recruit",
        "recruitment", "recruiter", "placement", "internship", "intern", "employer",
        "employee", "employment", "company", "organization", "candidate",
        "qualification", "experience", "responsibilities", "requirements", "skills",
        "degree", "department", "full[- ]time", "part[- ]time", "work from home",
        "remote job", "shift", "hr team", "joining",
      ].join("|") +
      ")\\b",
    "gi"
  );

  function looksLikeJobPosting(rawText) {
    const words = rawText.match(/[a-zA-Z]+/g) || [];
    if (words.length < 8) return false;
    const hits = (rawText.match(JOB_POSTING_KEYWORDS) || []).length;
    return hits >= 2;
  }

  // ---- Text cleaning, ported 1:1 from utils.clean_text() ----
  const PUNCT_RE = /[!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\]/g;

  function cleanText(rawText) {
    if (typeof rawText !== "string") return "";
    let text = rawText.toLowerCase();
    text = text.replace(/https?:\/\/\S+|www\.\S+/g, " ");
    text = text.replace(/\S+@\S+/g, " ");
    text = text.replace(/<[^>]*>/g, " ");
    text = text.replace(/\d+/g, " ");
    text = text.replace(PUNCT_RE, "");
    text = text.replace(/\s+/g, " ").trim();

    const tokens = text.length ? text.split(" ") : [];
    const stop = MODEL.stopwords;
    return tokens.filter((t) => !stop.has(t) && t.length > 1);
  }

  // Build the L2-normalized TF-IDF vector for the cleaned token list,
  // using unigrams + adjacent-pair bigrams (ngram_range=(1,2)), restricted
  // to the 5000-word trained vocabulary — identical to what
  // TfidfVectorizer.transform() does internally.
  function tfidfVector(tokens) {
    const { vocab, idf } = MODEL;
    const counts = new Map();
    const bump = (gram) => {
      if (Object.prototype.hasOwnProperty.call(vocab, gram)) {
        counts.set(gram, (counts.get(gram) || 0) + 1);
      }
    };
    for (let i = 0; i < tokens.length; i++) {
      bump(tokens[i]);
      if (i < tokens.length - 1) bump(tokens[i] + " " + tokens[i + 1]);
    }

    const entries = []; // {idx, gram, value}
    let sumSquares = 0;
    for (const [gram, c] of counts) {
      const idx = vocab[gram];
      const value = c * idf[idx];
      entries.push({ idx, gram, value });
      sumSquares += value * value;
    }
    const norm = Math.sqrt(sumSquares);
    if (norm > 0) {
      for (const e of entries) e.value = e.value / norm;
    }
    return entries; // sparse representation: only nonzero components
  }

  // ---- linear scoring path (logistic regression / naive bayes / svm) ----
  // All three reduce to the same dot-product-plus-intercept form at
  // inference time (see the export-side comment in train_from_kaggle.py),
  // so one function serves all of them.
  function scoreLinear(sparseVec, meta) {
    const { coef, intercept } = MODEL;
    let decision = intercept;
    for (const e of sparseVec) decision += e.value * coef[e.idx];
    for (let i = 0; i < meta.length; i++) decision += meta[i] * coef[5000 + i];
    const prediction = decision > 0 ? 1 : 0;
    const rawSigmoid = 1 / (1 + Math.exp(-decision));
    const confidence = prediction === 1 ? rawSigmoid : 1 - rawSigmoid;
    return { prediction, confidence, decision };
  }

  // ---- tree scoring path (decision tree / random forest) ----
  // Replicates sklearn's own Tree traversal from the flat arrays exported
  // by export_tree() in train_from_kaggle.py: feature/threshold per node,
  // children_left/children_right (-1 marks a leaf), value = [p_genuine,
  // p_fraud] at that node.
  function featureValueAt(idx, sparseVec, meta) {
    if (idx < 5000) {
      // sparseVec only carries nonzero TF-IDF entries; scan for this index.
      // Trees only touch a handful of features per prediction, so a linear
      // scan over the (typically short) sparse entry list is cheap.
      for (const e of sparseVec) if (e.idx === idx) return e.value;
      return 0;
    }
    return meta[idx - 5000] || 0;
  }

  function walkTree(tree, sparseVec, meta) {
    let node = 0;
    while (tree.left[node] !== -1) {
      const f = tree.feature[node];
      const v = featureValueAt(f, sparseVec, meta);
      node = v <= tree.threshold[node] ? tree.left[node] : tree.right[node];
    }
    const [pGenuine, pFraud] = tree.value[node];
    return { pGenuine, pFraud };
  }

  function scoreTree(sparseVec, meta) {
    const { pGenuine, pFraud } = walkTree(MODEL.tree, sparseVec, meta);
    const prediction = pFraud > pGenuine ? 1 : 0;
    const confidence = Math.max(pGenuine, pFraud);
    return { prediction, confidence, decision: pFraud - pGenuine };
  }

  function scoreForest(sparseVec, meta) {
    let sumFraud = 0;
    for (const tree of MODEL.trees) {
      const { pFraud } = walkTree(tree, sparseVec, meta);
      sumFraud += pFraud;
    }
    const avgFraud = sumFraud / MODEL.trees.length;
    const prediction = avgFraud > 0.5 ? 1 : 0;
    const confidence = prediction === 1 ? avgFraud : 1 - avgFraud;
    return { prediction, confidence, decision: avgFraud - 0.5 };
  }

  /**
   * Run the full pipeline on raw posting text + optional metadata checkboxes.
   * Returns prediction (0=real,1=fraud), confidence (0-1, in the predicted
   * class), the rule-based flag results, top contributing n-grams for
   * explainability (linear algorithms only — see note below), and whether a
   * hard rule override flipped the ML verdict.
   */
  async function analyze(rawText, { telecommuting = false, hasLogo = false, hasQuestions = false } = {}) {
    await load();

    const tokens = cleanText(rawText);
    const sparseVec = tfidfVector(tokens);

    const feePattern = RULE_BASED_FLAGS[0].pattern;
    const mentionsFee = feePattern.test(rawText.toLowerCase()) ? 1 : 0;
    const meta = [telecommuting ? 1 : 0, hasLogo ? 1 : 0, hasQuestions ? 1 : 0, mentionsFee];

    let scored;
    if (MODEL.algorithm === "decision_tree") scored = scoreTree(sparseVec, meta);
    else if (MODEL.algorithm === "random_forest") scored = scoreForest(sparseVec, meta);
    else scored = scoreLinear(sparseVec, meta);

    let { prediction, confidence, decision } = scored;

    let overridden = false;
    if (mentionsFee && prediction === 0) {
      prediction = 1;
      overridden = true;
      // confidence display keeps the pre-override model confidence,
      // matching the original app's "Model confidence (pre-override)" label
    }

    // Per-instance explainability (which phrases pushed the score which
    // way) only makes sense for linear models, where each n-gram's
    // contribution is literally tfidf_value * coef. Tree/forest models
    // don't have a per-instance equivalent without extra bookkeeping
    // (e.g. SHAP), so they simply return no chips here rather than a
    // misleading approximation.
    let topFraudWords = [];
    let topGenuineWords = [];
    if (MODEL.coef) {
      const contributions = sparseVec
        .map((e) => ({ gram: e.gram, weight: e.value * MODEL.coef[e.idx] }))
        .filter((c) => Math.abs(c.weight) > 1e-9)
        .sort((a, b) => b.weight - a.weight);
      topFraudWords = contributions.slice(0, 8);
      topGenuineWords = contributions.slice(-8).reverse();
    }

    const flagResults = RULE_BASED_FLAGS.map((f) => ({
      key: f.key,
      label: f.label,
      hit: f.pattern.test(rawText.toLowerCase()),
    }));

    const outOfDomain = !looksLikeJobPosting(rawText);

    return {
      algorithm: MODEL.algorithm,
      prediction, // 1 = fraudulent, 0 = genuine
      confidence, // 0..1
      decision,
      overridden,
      mentionsFee: !!mentionsFee,
      flagResults,
      topFraudWords,
      topGenuineWords,
      outOfDomain,
      tokenCount: tokens.length,
    };
  }

  return { load, analyze, cleanText, looksLikeJobPosting, RULE_BASED_FLAGS };
})();
