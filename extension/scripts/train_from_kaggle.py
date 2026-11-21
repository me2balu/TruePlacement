"""
train_from_kaggle.py
---------------------
Trains TruePlacement's fraud-detection model on the Kaggle "Real / Fake Job
Posting" dataset, benchmarks it across five algorithms, keeps whichever one
scores best on held-out fraud-class F1, and exports it into a
model_data.json format that lib/model.js already knows how to load and run
on-device -- no other extension/website code needs to change.

Algorithms benchmarked (all on the same TF-IDF + metadata features):
  - Logistic Regression   (linear, calibrated probabilities)
  - Multinomial Naive Bayes (fast text baseline)
  - Linear SVM            (LinearSVC -- effective on high-dim sparse TF-IDF)
  - Decision Tree         (single rule-based tree)
  - Random Forest         (ensemble of trees)

Place `fake_job_postings.csv` in the same folder as this script (or edit
CSV_PATH below), then run:

    pip install pandas scikit-learn numpy --break-system-packages
    python train_from_kaggle.py

This will:
  1. Load and clean the dataset (title + company_profile + description +
     requirements + benefits -> one text blob per posting). Missing values
     in any text/metadata/label column are filled, not dropped (see
     load_dataset()).
  2. Re-implement the exact same text-cleaning steps used by the JS
     inference code (lowercase, strip URLs/emails/HTML/digits/punctuation,
     drop stopwords + 1-char tokens) so training and on-device inference
     agree byte-for-byte.
  3. Fit a shared TF-IDF vectorizer (unigrams+bigrams, 5000 features), then
     train all five classifiers above on a stratified 80/20 split, all
     with class-balanced weighting since fraudulent postings are a small
     minority of the dataset (~5%).
  4. Print a side-by-side precision/recall/F1 comparison table and pick the
     winner by fraud-class F1 (the metric that matters here -- accuracy
     alone is misleading on this imbalanced a dataset).
  5. Refit the winning algorithm on the FULL dataset and write
     extension/lib/model_data.json in whichever schema that algorithm needs
     (see MODEL SCHEMA note below).

MODEL SCHEMA
------------
Every export has: vocab, idf, meta_order, stopwords, algorithm.

- Linear algorithms (logistic_regression, naive_bayes, svm) additionally
  carry `coef` (length 5004: 5000 TF-IDF dims + 4 metadata dims) and
  `intercept`. The decision function is the same dot product for all three
  -- for logistic regression and Naive Bayes it IS the model's own math
  (Naive Bayes's log-odds ratio reduces exactly to a linear function of the
  TF-IDF counts); for the SVM it's LinearSVC's decision_function. JS then
  applies a sigmoid to turn that into a 0..1 confidence.

- Tree algorithms (decision_tree, random_forest) carry `tree` (single tree)
  or `trees` (list, for the forest), each as sklearn's own flat
  arrays -- feature, threshold, children_left, children_right, value --
  so the JS side just replicates sklearn's node-by-node traversal. No
  retraining needed to change the runtime; the exported arrays fully
  describe the fitted tree(s).
"""

import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer, ENGLISH_STOP_WORDS
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression
from sklearn.naive_bayes import MultinomialNB
from sklearn.svm import LinearSVC
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix, f1_score
import re

# ------------------------------------------------------------------ paths --

CSV_PATH = "fake_job_postings.csv"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "lib" / "model_data.json"
MAX_FEATURES = 5000
META_ORDER = ["telecommuting", "has_company_logo", "has_questions", "mentions_fee"]

STOPWORDS = set(ENGLISH_STOP_WORDS)

# ---------------------------------------------------------- text cleaning --
# Ported 1:1 from extension/lib/model.js cleanText() / PUNCT_RE, so a
# posting is tokenized identically whether it happens in training or
# on-device inference.

PUNCT_RE = re.compile(r"[!\"#$%&'()*+,\-./:;<=>?@\[\]^_`{|}~\\]")


def clean_text_to_tokens(raw_text: str) -> list[str]:
    if not isinstance(raw_text, str):
        return []
    text = raw_text.lower()
    text = re.sub(r"https?://\S+|www\.\S+", " ", text)
    text = re.sub(r"\S+@\S+", " ", text)
    text = re.sub(r"<[^>]*>", " ", text)
    text = re.sub(r"\d+", " ", text)
    text = PUNCT_RE.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()

    tokens = text.split(" ") if text else []
    return [t for t in tokens if t not in STOPWORDS and len(t) > 1]


def clean_text_to_string(raw_text: str) -> str:
    """TfidfVectorizer needs a string per document; join the already
    stopword-filtered tokens back together and let the vectorizer's own
    ngram builder do the unigram+bigram work using a no-op tokenizer."""
    return " ".join(clean_text_to_tokens(raw_text))


FEE_PATTERN = re.compile(
    r"registration fee|processing fee|deposit|pay to apply|refundable|security fee",
    re.IGNORECASE,
)


def mentions_fee(raw_text: str) -> int:
    return 1 if FEE_PATTERN.search(raw_text or "") else 0


# ------------------------------------------------------------- load data --
# Missing-value policy: nothing is dropped. Missing text -> "" (contributes
# nothing to TF-IDF rather than crashing the concatenation). Missing
# telecommuting/has_company_logo/has_questions -> 0 (same default the JS
# side uses for an unchecked box). Missing `fraudulent` label -> 0
# (genuine) -- flagged here because unlike the other columns this one is
# an assumption, not a neutral default; check your CSV has none before
# trusting this silently.

def load_dataset(csv_path: str) -> pd.DataFrame:
    df = pd.read_csv(csv_path)

    text_cols = ["title", "company_profile", "description", "requirements", "benefits"]
    for col in text_cols:
        if col not in df.columns:
            df[col] = ""
        df[col] = df[col].fillna("")

    df["raw_text"] = (
        df["title"] + " " + df["company_profile"] + " " + df["description"]
        + " " + df["requirements"] + " " + df["benefits"]
    ).str.strip()

    for col in ["telecommuting", "has_company_logo", "has_questions"]:
        if col not in df.columns:
            df[col] = 0
        df[col] = df[col].fillna(0).astype(int)

    if "fraudulent" not in df.columns:
        raise ValueError("Expected a 'fraudulent' label column in the CSV.")
    n_missing_labels = df["fraudulent"].isna().sum()
    if n_missing_labels:
        print(f"WARNING: {n_missing_labels} rows have a missing 'fraudulent' label "
              f"and will default to 0 (genuine). Consider dropping these instead.")
    df["fraudulent"] = df["fraudulent"].fillna(0).astype(int)

    df["mentions_fee"] = df["raw_text"].apply(mentions_fee)
    df["cleaned"] = df["raw_text"].apply(clean_text_to_string)

    return df


# --------------------------------------------------------------- vectorize --

def build_feature_matrix(vectorizer: TfidfVectorizer, df: pd.DataFrame, fit: bool):
    if fit:
        tfidf = vectorizer.fit_transform(df["cleaned"])
    else:
        tfidf = vectorizer.transform(df["cleaned"])

    meta = df[META_ORDER].to_numpy(dtype=np.float64)
    X_sparse_meta = np.hstack([tfidf.toarray(), meta])  # dense: fine at 5004 dims / ~18k rows
    return X_sparse_meta, tfidf


def make_vectorizer() -> TfidfVectorizer:
    # analyzer="word" with a no-op tokenizer/preprocessor because the text
    # is already lowercased, cleaned, and stopword-filtered by
    # clean_text_to_string() above -- this keeps sklearn's TF-IDF math
    # (raw counts * idf, then L2 norm) as the only thing left for it to do,
    # matching tfidfVector() in model.js exactly.
    return TfidfVectorizer(
        max_features=MAX_FEATURES,
        ngram_range=(1, 2),
        tokenizer=str.split,
        preprocessor=lambda x: x,
        token_pattern=None,
        lowercase=False,
        norm="l2",
        use_idf=True,
        smooth_idf=True,
        sublinear_tf=False,
    )


# ------------------------------------------------------------- algorithms --
# Every candidate is trained with class-balanced weighting (fraud is ~5% of
# the data) and a fixed random_state for reproducibility. Tree-based models
# are depth/leaf-capped -- otherwise an unbounded tree/forest on 5000
# sparse dimensions can both overfit and blow up the exported JSON size.

def build_candidates():
    return {
        "logistic_regression": LogisticRegression(
            class_weight="balanced", max_iter=2000, random_state=42
        ),
        "naive_bayes": MultinomialNB(),  # TF-IDF values are non-negative, so this is valid
        "svm": LinearSVC(class_weight="balanced", max_iter=10000, random_state=42),
        "decision_tree": DecisionTreeClassifier(
            class_weight="balanced", max_depth=25, min_samples_leaf=5, random_state=42
        ),
        "random_forest": RandomForestClassifier(
            n_estimators=100, class_weight="balanced", max_depth=25,
            min_samples_leaf=5, random_state=42, n_jobs=-1
        ),
    }


def decision_scores(name, clf, X):
    """Return a 0..1 "probability of fraud" score for any of the five
    algorithm types, so they can all be compared on the same footing."""
    if hasattr(clf, "predict_proba"):
        return clf.predict_proba(X)[:, 1]
    # LinearSVC has no predict_proba -- use its raw margin through a sigmoid,
    # same transform the JS runtime applies at inference time.
    margin = clf.decision_function(X)
    return 1 / (1 + np.exp(-margin))


# ------------------------------------------------------------------- main --

def main():
    t0 = time.time()
    print(f"Loading {CSV_PATH} ...")
    df = load_dataset(CSV_PATH)
    print(f"Loaded {len(df)} postings, {df['fraudulent'].sum()} fraudulent "
          f"({100 * df['fraudulent'].mean():.2f}%).")

    train_df, test_df = train_test_split(
        df, test_size=0.2, random_state=42, stratify=df["fraudulent"]
    )

    print("\nFitting a shared TF-IDF vectorizer on the training split...")
    eval_vectorizer = make_vectorizer()
    X_train, _ = build_feature_matrix(eval_vectorizer, train_df, fit=True)
    X_test, _ = build_feature_matrix(eval_vectorizer, test_df, fit=False)
    y_train = train_df["fraudulent"].to_numpy()
    y_test = test_df["fraudulent"].to_numpy()

    candidates = build_candidates()
    results = {}

    print("\n=== Benchmarking algorithms (held-out 20% split) ===")
    for name, clf in candidates.items():
        t_start = time.time()
        clf.fit(X_train, y_train)
        y_pred = clf.predict(X_test)
        fraud_f1 = f1_score(y_test, y_pred, pos_label=1)
        macro_f1 = f1_score(y_test, y_pred, average="macro")
        elapsed = time.time() - t_start
        results[name] = {"clf": clf, "fraud_f1": fraud_f1, "macro_f1": macro_f1}
        print(f"\n--- {name} ({elapsed:.1f}s) ---")
        print(classification_report(y_test, y_pred, target_names=["genuine", "fraudulent"], digits=3))
        print("Confusion matrix (rows=actual, cols=predicted):")
        print(confusion_matrix(y_test, y_pred))

    print("\n=== Summary (sorted by fraud-class F1) ===")
    ranked = sorted(results.items(), key=lambda kv: kv[1]["fraud_f1"], reverse=True)
    for name, r in ranked:
        print(f"  {name:<20} fraud F1 = {r['fraud_f1']:.3f}   macro F1 = {r['macro_f1']:.3f}")

    best_name = ranked[0][0]
    print(f"\nWinner: {best_name}")

    print(f"\nRefitting {best_name} on the FULL dataset for the shipped model...")
    final_vectorizer = make_vectorizer()
    X_full, _ = build_feature_matrix(final_vectorizer, df, fit=True)
    y_full = df["fraudulent"].to_numpy()

    final_clf = build_candidates()[best_name]
    final_clf.fit(X_full, y_full)

    vocab = {gram: int(idx) for gram, idx in final_vectorizer.vocabulary_.items()}
    idf = final_vectorizer.idf_.tolist()

    model_data = {
        "algorithm": best_name,
        "vocab": vocab,
        "idf": idf,
        "meta_order": META_ORDER,
        "stopwords": sorted(STOPWORDS),
    }

    if best_name in ("logistic_regression", "svm"):
        model_data["coef"] = final_clf.coef_[0].tolist()
        model_data["intercept"] = float(final_clf.intercept_[0])

    elif best_name == "naive_bayes":
        # log P(fraud|x) - log P(genuine|x) reduces to a linear function of
        # x for Multinomial NB, so it fits the same coef+intercept schema
        # as the other linear models -- no new JS code path needed.
        log_prob = final_clf.feature_log_prob_  # shape (2, 5004): [genuine, fraud]
        coef = (log_prob[1] - log_prob[0]).tolist()
        intercept = float(final_clf.class_log_prior_[1] - final_clf.class_log_prior_[0])
        model_data["coef"] = coef
        model_data["intercept"] = intercept

    elif best_name == "decision_tree":
        model_data["tree"] = export_tree(final_clf.tree_)

    elif best_name == "random_forest":
        model_data["trees"] = [export_tree(est.tree_) for est in final_clf.estimators_]

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(model_data, f)

    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"\nWrote {OUTPUT_PATH}  ({size_kb:.0f} KB)")
    print(f"  algorithm  : {best_name}")
    print(f"  vocab size : {len(vocab)}")
    print(f"  total time : {time.time() - t0:.1f}s")


def export_tree(tree):
    """Flatten an sklearn Tree object into plain JSON arrays the JS side can
    replicate node-by-node. `value` is turned into a [genuine, fraud]
    probability pair per leaf (and per internal node, unused but harmless)
    so JS never has to know sklearn's internal class-count normalization."""
    values = tree.value.reshape(tree.value.shape[0], -1)  # (n_nodes, n_classes)
    totals = values.sum(axis=1, keepdims=True)
    probs = np.divide(values, totals, out=np.zeros_like(values), where=totals != 0)
    return {
        "feature": tree.feature.tolist(),
        "threshold": tree.threshold.tolist(),
        "left": tree.children_left.tolist(),
        "right": tree.children_right.tolist(),
        "value": probs.tolist(),  # [[p_genuine, p_fraud], ...] per node
    }


if __name__ == "__main__":
    main()
