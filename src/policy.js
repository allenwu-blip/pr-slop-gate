/**
 * policy.js — the repo-level `.pr-slop-gate.yml` policy: parse → validate →
 * normalize into a strict object. PURE, no I/O (the runner reads the file and
 * passes the text in; tests pass strings directly).
 *
 * Design rules:
 *  - A bad/garbage/absent policy NEVER throws and NEVER tightens the gate. It
 *    degrades to the conservative built-in defaults and returns warnings so a
 *    maintainer can see exactly what was ignored (surfaced in the Action log).
 *  - Unknown keys are warned about (typo protection) but ignored.
 *  - Every numeric is clamped to its sane range; out-of-range → default + warn.
 *
 * Schema (all keys optional):
 *
 *   version: 1
 *   thresholds:
 *     label:   0.5
 *     comment: 0.65
 *     close:   0.85
 *   weights:
 *     heuristic: 0.6
 *     grader:    0.4
 *   rules:                # per-signal weight multipliers in [0,2]
 *     aiBoilerplate: 1.0
 *     sprawl:        1.0
 *     churn:         1.0
 *     lowEffortBody: 1.0
 *     title:         1.0
 *     templateBody:  1.0
 *     commitQuality: 1.0
 *     intentMismatch: 1.0
 *     massRename:    1.0
 *   allowlist:            # logins always exempt
 *     - dependabot[bot]
 *   trusted-authors:      # extra prior-merged logins
 *     - core-dev
 *   exempt-paths:         # glob-ish path prefixes/suffixes excluded from churn/sprawl/intent
 *     - "docs/**"
 *     - "*.md"
 *   auto-close: false
 *   routing:              # per-decision label overrides (hosted tier extends this)
 *     label:   possible-ai-slop
 *     close:   possible-ai-slop
 *   policy-pack: ""       # named pack (PAID TIER surface — see policypack.js)
 */

import { parse } from "./yaml.js";

const clamp = (x, lo, hi, d) => {
  const n = Number(x);
  if (!Number.isFinite(n)) return d;
  return n < lo ? lo : n > hi ? hi : n;
};

export const KNOWN_SIGNALS = Object.freeze([
  "aiBoilerplate",
  "sprawl",
  "churn",
  "lowEffortBody",
  "title",
  "templateBody",
  "commitQuality",
  "intentMismatch",
  "massRename",
]);

const TOP_LEVEL_KEYS = new Set([
  "version",
  "thresholds",
  "weights",
  "rules",
  "allowlist",
  "trusted-authors",
  "exempt-paths",
  "auto-close",
  "routing",
  "policy-pack",
]);

/**
 * The empty policy = "no repo override". Distinct from DEFAULT_CONFIG: this
 * only carries what the repo file explicitly set, so config layering can tell
 * "unset" from "set to the default value".
 */
export const EMPTY_POLICY = Object.freeze({
  thresholds: Object.freeze({}),
  weights: Object.freeze({}),
  ruleWeights: Object.freeze({}),
  allowlist: Object.freeze([]),
  trustedAuthors: Object.freeze([]),
  exemptPaths: Object.freeze([]),
  autoClose: undefined,
  routing: Object.freeze({}),
  policyPack: "",
  warnings: Object.freeze([]),
  present: false,
});

function strList(v, warnings, where) {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    warnings.push(`policy: \`${where}\` must be a list; ignored`);
    return [];
  }
  const out = [];
  for (const x of v) {
    if (typeof x === "string" && x.trim()) out.push(x.trim());
    else if (typeof x === "number" || typeof x === "boolean") out.push(String(x));
    else warnings.push(`policy: \`${where}\` has a non-string entry; skipped`);
  }
  return out;
}

/**
 * Parse + validate `.pr-slop-gate.yml` text into a normalized policy.
 * @param {string} text - raw file contents ("" / missing → empty policy).
 * @returns {typeof EMPTY_POLICY}
 */
export function resolvePolicy(text) {
  if (!text || typeof text !== "string" || text.trim() === "") {
    return EMPTY_POLICY;
  }
  const { value: doc, errors } = parse(text);
  const warnings = errors.map(
    (e) => `policy: line ${e.line}: ${e.message}`,
  );

  if (doc == null || typeof doc !== "object" || Array.isArray(doc)) {
    warnings.push("policy: top level must be a mapping; file ignored");
    return { ...EMPTY_POLICY, warnings, present: true };
  }

  for (const k of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      warnings.push(`policy: unknown key \`${k}\` ignored`);
    }
  }

  if (doc.version !== undefined && Number(doc.version) !== 1) {
    warnings.push(
      `policy: unsupported version \`${doc.version}\` (expected 1); parsed best-effort`,
    );
  }

  const thresholds = {};
  const th = doc.thresholds && typeof doc.thresholds === "object" ? doc.thresholds : {};
  for (const key of ["label", "comment", "close"]) {
    if (th[key] !== undefined) {
      const n = Number(th[key]);
      if (Number.isFinite(n) && n >= 0 && n <= 1) thresholds[key] = n;
      else warnings.push(`policy: thresholds.${key} must be 0..1; using default`);
    }
  }
  // Keep thresholds monotonic (label ≤ comment ≤ close). A misordered policy
  // must never make the gate MORE aggressive than its own stated intent, so we
  // pull each lower band UP toward the next one. Process close → comment →
  // label in one backward pass so the result is monotonic regardless of how
  // scrambled the input order was (a naive forward pass can re-break it).
  if (
    thresholds.comment !== undefined &&
    thresholds.close !== undefined &&
    thresholds.comment > thresholds.close
  ) {
    warnings.push("policy: thresholds.comment > thresholds.close; raising comment to close");
    thresholds.comment = thresholds.close;
  }
  if (thresholds.label !== undefined) {
    const ceiling =
      thresholds.comment !== undefined
        ? thresholds.comment
        : thresholds.close; // if comment unset, label still must not exceed close
    if (ceiling !== undefined && thresholds.label > ceiling) {
      warnings.push(
        "policy: thresholds.label exceeds a higher band; raising label to keep label ≤ comment ≤ close",
      );
      thresholds.label = ceiling;
    }
  }

  const weights = {};
  const w = doc.weights && typeof doc.weights === "object" ? doc.weights : {};
  for (const key of ["heuristic", "grader"]) {
    if (w[key] !== undefined) {
      const n = Number(w[key]);
      if (Number.isFinite(n) && n >= 0 && n <= 1) weights[key] = n;
      else warnings.push(`policy: weights.${key} must be 0..1; using default`);
    }
  }

  const ruleWeights = {};
  const r = doc.rules && typeof doc.rules === "object" ? doc.rules : {};
  for (const [k, v] of Object.entries(r)) {
    if (!KNOWN_SIGNALS.includes(k)) {
      warnings.push(`policy: unknown rule \`${k}\` ignored`);
      continue;
    }
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 2) ruleWeights[k] = n;
    else warnings.push(`policy: rules.${k} must be 0..2; using default 1.0`);
  }

  const routing = {};
  const rt = doc.routing && typeof doc.routing === "object" ? doc.routing : {};
  for (const key of ["label", "comment", "close"]) {
    if (typeof rt[key] === "string" && rt[key].trim()) {
      routing[key] = rt[key].trim();
    } else if (rt[key] !== undefined) {
      warnings.push(`policy: routing.${key} must be a non-empty string; ignored`);
    }
  }

  let autoClose;
  if (doc["auto-close"] !== undefined) {
    if (typeof doc["auto-close"] === "boolean") autoClose = doc["auto-close"];
    else warnings.push("policy: `auto-close` must be true/false; ignored");
  }

  let policyPack = "";
  if (doc["policy-pack"] !== undefined) {
    if (typeof doc["policy-pack"] === "string") policyPack = doc["policy-pack"].trim();
    else warnings.push("policy: `policy-pack` must be a string; ignored");
  }

  return {
    thresholds,
    weights,
    ruleWeights,
    allowlist: strList(doc.allowlist, warnings, "allowlist"),
    trustedAuthors: strList(doc["trusted-authors"], warnings, "trusted-authors"),
    exemptPaths: strList(doc["exempt-paths"], warnings, "exempt-paths"),
    autoClose,
    routing,
    policyPack,
    warnings,
    present: true,
  };
}

/**
 * Compile a list of policy `exempt-paths` patterns into a fast predicate.
 * Supported, intentionally minimal, glob subset:
 *   - prefix match:  "docs/"  or  "docs/(star)(star)"  -> path starts "docs/"
 *   - suffix match:  "*.md"   or  "(star)(star)/*.md"   -> path ends ".md"
 *   - exact:         "CHANGELOG.md"
 * Anything else is treated as a substring contains() (safe, never throws).
 * (Glob tokens spelled out above to avoid a literal star-slash in this
 * comment, which some bundlers mis-tokenize as a comment terminator.)
 *
 * @param {string[]} patterns
 * @returns {(filename:string)=>boolean}
 */
export function makeExemptMatcher(patterns) {
  const pats = Array.isArray(patterns) ? patterns.filter(Boolean) : [];
  if (!pats.length) return () => false;
  const compiled = pats.map((raw) => {
    const p = String(raw).trim();
    if (p.endsWith("/**")) return { kind: "prefix", v: p.slice(0, -2) };
    if (p.endsWith("/")) return { kind: "prefix", v: p };
    if (p.startsWith("**/*")) return { kind: "suffix", v: p.slice(4) };
    if (p.startsWith("*.")) return { kind: "suffix", v: p.slice(1) };
    if (!p.includes("*")) return { kind: "exactOrPrefix", v: p };
    return { kind: "contains", v: p.replace(/\*/g, "") };
  });
  return (filename) => {
    const f = String(filename || "");
    for (const c of compiled) {
      if (c.kind === "prefix" && f.startsWith(c.v)) return true;
      if (c.kind === "suffix" && f.endsWith(c.v)) return true;
      if (c.kind === "exactOrPrefix" && (f === c.v || f.startsWith(c.v.endsWith("/") ? c.v : c.v + "/")))
        return true;
      if (c.kind === "contains" && c.v && f.includes(c.v)) return true;
    }
    return false;
  };
}
