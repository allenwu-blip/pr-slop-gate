/**
 * policypack.js — named "policy packs": opinionated, ready-made tuning bundles
 * a repo can opt into by name instead of hand-writing `.pr-slop-gate.yml`.
 * PURE, no I/O, no network.
 *
 * The free Action ships a small set of BUILT-IN packs (below) that resolve
 * fully offline. A repo selects one via `.pr-slop-gate.yml`:
 *
 *     policy-pack: oss-strict
 *
 * The selected pack is applied as the *base* layer; any explicit keys in the
 * same `.pr-slop-gate.yml` still override the pack, and Action inputs still
 * override those. (Precedence: defaults < pack < repo policy keys < inputs.)
 *
 * ── PAID TIER boundary ──────────────────────────────────────────────────────
 * Anything that is NOT a built-in pack name (a custom/org pack, a remotely
 * managed pack, a versioned pack registry) is the hosted tier's job. This
 * module DELIBERATELY does not fetch, authenticate, or load external packs.
 * An unknown pack name degrades safely to "no pack" + a clear warning and a
 * machine-readable `paidTier:true` marker so an operator can wire resolution
 * later WITHOUT changing the free Action's behavior. No money/accounts/network.
 */

/**
 * Built-in packs. Each value is the SAME normalized shape `policy.js` produces
 * for the keys a pack is allowed to set, so it composes via plain object merge.
 * Conservative by construction — even "strict" never enables auto-close (that
 * stays an explicit, deliberate maintainer choice) and never punishes new
 * contributors (handled by the exemption layer, not by packs).
 */
export const BUILTIN_PACKS = Object.freeze({
  // Balanced defaults made explicit — good for most OSS repos.
  "oss-default": {
    thresholds: { label: 0.5, comment: 0.65, close: 0.85 },
    ruleWeights: {},
    description: "Balanced OSS defaults (same as built-in behavior).",
  },
  // Tighter triage for repos drowning in drive-by AI PRs. Lower label/comment
  // bands + slightly amplified body/scaffold/commit signals. Still no auto-close.
  "oss-strict": {
    thresholds: { label: 0.42, comment: 0.55, close: 0.85 },
    ruleWeights: {
      aiBoilerplate: 1.3,
      templateBody: 1.4,
      commitQuality: 1.3,
      lowEffortBody: 1.2,
      intentMismatch: 1.3,
    },
    description:
      "Aggressive triage for repos hit hard by AI slop. Lower thresholds, amplified body/scaffold/commit signals. auto-close still OFF.",
  },
  // For repos that want a very low false-positive rate (e.g. high first-time
  // contributor volume). Higher thresholds + de-emphasized structural signals.
  "oss-lenient": {
    thresholds: { label: 0.62, comment: 0.78, close: 0.92 },
    ruleWeights: { sprawl: 0.7, churn: 0.7, title: 0.5, massRename: 0.7 },
    description:
      "Minimizes false positives for high first-time-contributor repos. Higher thresholds, softened structural signals.",
  },
  // Docs/content-heavy repos: don't treat large doc churn as slop, keep the
  // AI-boilerplate + intent-mismatch tells which still matter for content.
  "docs-heavy": {
    thresholds: { label: 0.55, comment: 0.7, close: 0.88 },
    ruleWeights: { sprawl: 0.5, churn: 0.4, massRename: 0.5 },
    exemptPaths: ["docs/**", "*.md", "*.mdx", "*.rst"],
    description:
      "For documentation/content repos: tolerates large doc churn, keeps boilerplate/intent signals, exempts common doc paths.",
  },
});

/** @returns {string[]} sorted built-in pack names (for docs / error messages). */
export function listPolicyPacks() {
  return Object.keys(BUILTIN_PACKS).sort();
}

/**
 * Resolve a pack NAME into a partial policy overlay.
 *
 * @param {string} name
 * @returns {{
 *   found: boolean,
 *   name: string,
 *   overlay: { thresholds?:object, ruleWeights?:object, exemptPaths?:string[] },
 *   warnings: string[],
 *   paidTier: boolean
 * }}
 */
export function resolvePolicyPack(name) {
  const key = String(name == null ? "" : name).trim();
  if (key === "") {
    return { found: false, name: "", overlay: {}, warnings: [], paidTier: false };
  }
  const pack = BUILTIN_PACKS[key];
  if (pack) {
    return {
      found: true,
      name: key,
      overlay: {
        ...(pack.thresholds ? { thresholds: { ...pack.thresholds } } : {}),
        ...(pack.ruleWeights ? { ruleWeights: { ...pack.ruleWeights } } : {}),
        ...(pack.exemptPaths ? { exemptPaths: pack.exemptPaths.slice() } : {}),
      },
      warnings: [],
      paidTier: false,
    };
  }
  // Unknown pack name. This is the hosted-tier seam: a custom/managed/remote
  // pack would resolve HERE. The free Action does NOT fetch it — it degrades
  // to no-pack and flags it so behavior is unchanged and the operator has a
  // single, obvious integration point.
  return {
    found: false,
    name: key,
    overlay: {},
    warnings: [
      `policy: policy-pack "${key}" is not a built-in pack. Built-in packs: ${listPolicyPacks().join(
        ", ",
      )}. Custom/managed packs are a hosted-tier feature and are not resolved by the free Action; ignoring (no behavior change).`,
    ],
    // Machine-readable marker for an operator's hosted layer. The free Action
    // never acts on this beyond surfacing the warning above.
    paidTier: true,
  };
}

/**
 * Apply a resolved pack overlay UNDER an existing normalized policy object:
 * the pack supplies values only where the repo policy did NOT explicitly set
 * them (repo policy keys win over the pack; pack wins over built-in defaults).
 * Pure; returns a new object.
 *
 * @param {object} policy - a resolvePolicy() result.
 * @param {ReturnType<typeof resolvePolicyPack>} packResolution
 */
export function composePolicyWithPack(policy, packResolution) {
  const p = policy || {};
  const ov = (packResolution && packResolution.overlay) || {};
  const warnings = [
    ...(Array.isArray(p.warnings) ? p.warnings : []),
    ...((packResolution && packResolution.warnings) || []),
  ];
  // thresholds / ruleWeights: pack fills only keys the repo policy left unset.
  const thresholds = { ...(ov.thresholds || {}), ...(p.thresholds || {}) };
  const ruleWeights = { ...(ov.ruleWeights || {}), ...(p.ruleWeights || {}) };
  // exemptPaths: union (both the pack's and the repo's apply).
  const exemptPaths = [
    ...new Set([
      ...((ov.exemptPaths || [])),
      ...((Array.isArray(p.exemptPaths) ? p.exemptPaths : [])),
    ]),
  ];
  return {
    ...p,
    thresholds,
    ruleWeights,
    exemptPaths,
    warnings,
    appliedPack: packResolution && packResolution.found ? packResolution.name : "",
    packPaidTier: !!(packResolution && packResolution.paidTier),
  };
}
