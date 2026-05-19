/**
 * config.js — pure resolution of Action inputs (+ optional repo
 * `.pr-slop-gate.yml` policy) into a validated config object. No I/O. Bad
 * inputs degrade to safe defaults (never throws on user typos).
 *
 * Layering precedence (lowest → highest):
 *   built-in DEFAULT_CONFIG  <  repo .pr-slop-gate.yml policy  <  Action inputs
 *
 * Rationale: the built-in defaults are conservative; a repo policy file is a
 * deliberate maintainer choice committed to the repo; an explicit Action input
 * is the *most* intentional signal (set per-workflow, often to override the
 * committed policy for a one-off), so it wins last.
 */

import { DEFAULT_CONFIG } from "./decide.js";
import { resolvePolicy, EMPTY_POLICY } from "./policy.js";
import { resolvePolicyPack, composePolicyWithPack } from "./policypack.js";

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Split a comma/newline-delimited input into a clean string list. */
export function parseList(s) {
  if (!s || typeof s !== "string") return [];
  return s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function numOr(v, fallback) {
  // Treat unset / empty / whitespace as "use the default". Note Number("")
  // is 0 (not NaN), so an explicit blank input must NOT collapse to 0.
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? clamp01(n) : fallback;
}

function boolTrue(v) {
  return String(v).trim().toLowerCase() === "true";
}

/**
 * Build the "base" config = DEFAULT_CONFIG with the repo policy layered on top.
 * Pure. Policy values are already validated/clamped by resolvePolicy().
 *
 * @param {ReturnType<typeof resolvePolicy>} policy
 */
function applyPolicy(policy) {
  const p = policy || EMPTY_POLICY;
  const base = {
    ...DEFAULT_CONFIG,
    weights: { ...DEFAULT_CONFIG.weights },
  };
  if (p.thresholds?.label !== undefined) base.labelThreshold = p.thresholds.label;
  if (p.thresholds?.comment !== undefined) base.commentThreshold = p.thresholds.comment;
  if (p.thresholds?.close !== undefined) base.closeThreshold = p.thresholds.close;
  if (p.weights?.heuristic !== undefined) base.weights.heuristic = p.weights.heuristic;
  if (p.weights?.grader !== undefined) base.weights.grader = p.weights.grader;
  if (typeof p.autoClose === "boolean") base.autoClose = p.autoClose;
  if (p.routing?.label) base.label = p.routing.label;
  // Per-signal rule weight multipliers (default 1.0; consumed by heuristics.js).
  base.ruleWeights = { ...(p.ruleWeights || {}) };
  base.exemptPaths = Array.isArray(p.exemptPaths) ? p.exemptPaths.slice() : [];
  base.policyPack = p.policyPack || "";
  base.policyWarnings = Array.isArray(p.warnings) ? p.warnings.slice() : [];
  base.policyPresent = !!p.present;
  return base;
}

/**
 * @param {Record<string,string>} inputs - raw Action inputs (kebab-case keys).
 * @param {object} [opts]
 * @param {string} [opts.policyText] - raw `.pr-slop-gate.yml` contents (optional).
 * @returns {object} a config compatible with decide()/triage().
 */
export function resolveConfig(inputs = {}, opts = {}) {
  const i = inputs || {};
  const rawPolicy =
    opts && typeof opts.policyText === "string"
      ? resolvePolicy(opts.policyText)
      : EMPTY_POLICY;
  // If the repo selected a named policy pack, compose it UNDER the repo's
  // explicit keys (defaults < pack < repo policy keys < Action inputs). An
  // unknown pack name degrades safely + warns (see policypack.js PAID TIER).
  const policy =
    rawPolicy.policyPack && rawPolicy.policyPack.trim()
      ? composePolicyWithPack(rawPolicy, resolvePolicyPack(rawPolicy.policyPack))
      : rawPolicy;
  // base = defaults + repo policy; Action inputs override this below.
  const base = applyPolicy(policy);

  const disableGrader = boolTrue(i["disable-grader"]);
  const hWeight = numOr(i["heuristic-weight"], base.weights.heuristic);
  const gWeightRaw = numOr(i["grader-weight"], base.weights.grader);

  return {
    ...base,
    label: (i["label"] || base.label).trim(),
    feedbackLabel: (i["feedback-label"] || base.feedbackLabel).trim(),
    labelThreshold: numOr(i["label-threshold"], base.labelThreshold),
    commentThreshold: numOr(i["comment-threshold"], base.commentThreshold),
    closeThreshold: numOr(i["close-threshold"], base.closeThreshold),
    autoClose: i["auto-close"] !== undefined && String(i["auto-close"]).trim() !== ""
      ? boolTrue(i["auto-close"])
      : base.autoClose,
    weights: {
      heuristic: hWeight,
      grader: disableGrader ? 0 : gWeightRaw,
    },
  };
}
