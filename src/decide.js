/**
 * decide.js — pure scoring-combination, trusted-contributor exemption, and
 * threshold → action decision logic. No I/O.
 */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Default configuration. Deliberately conservative + non-destructive:
 * autoClose is OFF by default so the Action never closes a human's PR until a
 * maintainer opts in.
 */
export const DEFAULT_CONFIG = Object.freeze({
  label: "possible-ai-slop",
  feedbackLabel: "pr-slop-gate-feedback",
  labelThreshold: 0.5,
  commentThreshold: 0.65,
  closeThreshold: 0.85,
  autoClose: false,
  weights: Object.freeze({ heuristic: 0.6, grader: 0.4 }),
});

/**
 * Weighted blend of the heuristic and grader scores, clamped to [0,1].
 * If grader weight is 0 the result is heuristic-only (the no-API-key path).
 *
 * @param {{heuristicScore:number, graderScore:number, weights:{heuristic:number,grader:number}}} a
 * @returns {number}
 */
export function combineScores({ heuristicScore, graderScore, weights }) {
  const wH = weights?.heuristic ?? DEFAULT_CONFIG.weights.heuristic;
  const wG = weights?.grader ?? DEFAULT_CONFIG.weights.grader;
  const h = clamp01(Number(heuristicScore) || 0);
  const g = clamp01(Number(graderScore) || 0);
  return clamp01(wH * h + wG * g);
}

/**
 * Trusted-contributor exemption — the false-positive safety valve.
 *
 * An author is trusted iff they appear in `priorMergedAuthors` (logins who
 * already had a PR merged into this repo) OR in the explicit `allowlist`
 * input. Matching is case-insensitive. A brand-new contributor is NOT trusted
 * (they must pass on the score's merit — which the heuristics are tuned to let
 * genuine small first PRs do).
 *
 * @param {string} author
 * @param {{priorMergedAuthors?:string[], allowlist?:string[]}} lists
 * @returns {boolean}
 */
export function isTrusted(author, lists = {}) {
  if (!author) return false;
  const a = author.toLowerCase();
  const prior = (lists.priorMergedAuthors || []).map((x) =>
    String(x).toLowerCase(),
  );
  const allow = (lists.allowlist || []).map((x) => String(x).toLowerCase());
  return prior.includes(a) || allow.includes(a);
}

/**
 * Map a combined score → an action, applying the trusted exemption first.
 *
 * Decisions: "allow" | "label" | "comment" | "close".
 * - allow:   nothing happens.
 * - label:   apply the slop label only.
 * - comment: apply label + post the polite templated comment.
 * - close:   apply label + comment + close the PR (only if config.autoClose).
 *
 * @param {{score:number, author:string, config:object, trusted:boolean}} a
 */
export function decide({ score, author, config, trusted }) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

  if (trusted) {
    return {
      decision: "allow",
      label: null,
      shouldComment: false,
      shouldClose: false,
      exemptedBy: "trusted-contributor",
      score,
    };
  }

  let decision = "allow";
  if (score >= cfg.closeThreshold) decision = "close";
  else if (score >= cfg.commentThreshold) decision = "comment";
  else if (score >= cfg.labelThreshold) decision = "label";

  // autoClose is a hard gate: never close unless the maintainer enabled it.
  if (decision === "close" && !cfg.autoClose) decision = "comment";

  return {
    decision,
    label: decision === "allow" ? null : cfg.label,
    shouldComment: decision === "comment" || decision === "close",
    shouldClose: decision === "close",
    exemptedBy: null,
    score,
  };
}
