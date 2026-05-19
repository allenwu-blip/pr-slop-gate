/**
 * analytics.js — structured analytics surface. PURE, no I/O, no network.
 *
 * This is the *product surface* a hosted tier would build a dashboard on. The
 * free Action emits a per-PR analytics record (and can write a JSON line to a
 * log a self-hoster controls); an org-level aggregate report is computed from
 * a list of those records. NOTHING here touches money, accounts, billing, a
 * Merchant-of-Record, or the network — the only thing a paid tier adds is
 * *hosting + retention + a UI* on top of this exact data. That boundary is
 * called out explicitly where it lands (see `// PAID TIER` markers below and
 * in policypack.js).
 *
 * Keeping this in the OSS Action (rather than a separate private repo) is
 * deliberate: the data contract is auditable, a self-hoster gets real value,
 * and the hosted tier is a convenience layer, not a capability gate.
 */

const SCHEMA_VERSION = 1;

/**
 * Build the canonical, serializable analytics record for ONE triage result.
 * Deterministic: same triage result → byte-identical JSON. No timestamps are
 * invented here (the caller passes `at` if it wants one) so the record stays
 * pure and testable.
 *
 * @param {object} result - the object returned by triage().
 * @param {{repo?:string, at?:string, dryRun?:boolean, graderMode?:string}} [meta]
 * @returns {object}
 */
export function buildPrAnalytics(result, meta = {}) {
  const r = result || {};
  const signals = r.signals && typeof r.signals === "object" ? r.signals : {};
  const firedSignals = Object.entries(signals)
    .filter(([, v]) => Number(v) >= 0.3)
    .map(([k]) => k)
    .sort();
  return {
    schema: SCHEMA_VERSION,
    product: "pr-slop-gate",
    repo: typeof meta.repo === "string" ? meta.repo : "",
    at: typeof meta.at === "string" ? meta.at : null,
    pr: Number.isFinite(r.number) ? r.number : null,
    author: typeof r.author === "string" ? r.author : "",
    score: round4(r.score),
    heuristicScore: round4(r.heuristicScore),
    graderScore: round4(r.graderScore),
    graderUsed: !!r.graderUsed,
    graderMode:
      typeof meta.graderMode === "string"
        ? meta.graderMode
        : r.graderUsed
          ? "llm"
          : "heuristic-only",
    decision: typeof r.decision === "string" ? r.decision : "allow",
    exemptedBy: r.exemptedBy || null,
    dryRun: !!meta.dryRun,
    firedSignals,
    signals: roundMap(signals),
    provenance: Array.isArray(r.provenance)
      ? r.provenance.map((p) => ({
          signal: p.signal,
          value: round4(p.value),
          why: String(p.why || ""),
        }))
      : [],
  };
}

/**
 * Aggregate many per-PR analytics records into an org/repo-level report — the
 * exact JSON a hosted dashboard would render. Pure; tolerant of partial or
 * malformed records (a bad row is skipped, never throws).
 *
 * @param {object[]} records - buildPrAnalytics() outputs (any order).
 * @param {{since?:string, until?:string, label?:string}} [opts]
 * @returns {object}
 */
export function aggregateReport(records, opts = {}) {
  const rows = Array.isArray(records) ? records : [];
  const decisions = { allow: 0, label: 0, comment: 0, close: 0 };
  const signalCounts = {};
  const repos = new Set();
  const exemptByTrust = { exempted: 0, scored: 0 };
  let total = 0;
  let flagged = 0;
  let scoreSum = 0;
  let scoreN = 0;
  let dryRun = 0;
  let graderUsed = 0;

  for (const rec of rows) {
    if (!rec || typeof rec !== "object") continue;
    total++;
    if (rec.repo) repos.add(rec.repo);
    const d = decisions[rec.decision] !== undefined ? rec.decision : null;
    if (d) decisions[d]++;
    if (d && d !== "allow") flagged++;
    if (rec.exemptedBy) exemptByTrust.exempted++;
    else exemptByTrust.scored++;
    if (Number.isFinite(rec.score)) {
      scoreSum += rec.score;
      scoreN++;
    }
    if (rec.dryRun) dryRun++;
    if (rec.graderUsed) graderUsed++;
    for (const s of Array.isArray(rec.firedSignals) ? rec.firedSignals : []) {
      signalCounts[s] = (signalCounts[s] || 0) + 1;
    }
  }

  const topSignals = Object.entries(signalCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([signal, count]) => ({ signal, count }));

  return {
    schema: SCHEMA_VERSION,
    product: "pr-slop-gate",
    window: {
      since: opts.since || null,
      until: opts.until || null,
      label: opts.label || null,
    },
    repos: [...repos].sort(),
    totals: {
      prsAnalyzed: total,
      flagged,
      flaggedPct: total ? round4(flagged / total) : 0,
      meanScore: scoreN ? round4(scoreSum / scoreN) : 0,
      dryRun,
      graderUsed,
      trustedExempt: exemptByTrust.exempted,
      scoredOnMerit: exemptByTrust.scored,
    },
    decisions,
    topSignals,
  };
}

/**
 * Render the aggregate report as a short, faceless plaintext digest (the kind
 * a maintainer could paste into a weekly update). Deterministic; no persona.
 *
 * @param {ReturnType<typeof aggregateReport>} report
 * @returns {string}
 */
export function formatReport(report) {
  const r = report || {};
  const t = r.totals || {};
  const lines = [
    "pr-slop-gate — aggregate triage report",
    `repos: ${(r.repos || []).join(", ") || "(none)"}`,
    `PRs analyzed: ${t.prsAnalyzed || 0}  |  flagged: ${t.flagged || 0} (${pct(t.flaggedPct)})  |  mean score: ${t.meanScore ?? 0}`,
    `decisions: allow=${r.decisions?.allow || 0} label=${r.decisions?.label || 0} comment=${r.decisions?.comment || 0} close=${r.decisions?.close || 0}`,
    `trusted-exempt: ${t.trustedExempt || 0}  |  scored on merit: ${t.scoredOnMerit || 0}  |  dry-run: ${t.dryRun || 0}`,
  ];
  const top = (r.topSignals || []).slice(0, 6);
  if (top.length) {
    lines.push("top signals:");
    for (const s of top) lines.push(`  - ${s.signal}: ${s.count}`);
  }
  lines.push(
    "",
    "Note: counts/scores are an automated triage signal, not a verdict.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// PAID TIER (operator wires later) — DELIBERATELY NOT IMPLEMENTED HERE.
//
// A hosted tier would (a) persist the per-PR records emitted above into a
// retained store, (b) serve `aggregateReport()` over an authenticated org
// dashboard, and (c) gate premium "policy packs" (see policypack.js). None of
// that — storage, auth, accounts, billing, Merchant-of-Record, or any network
// call — lives in this OSS Action. This stub exists ONLY to mark the exact
// seam an operator integrates against; it intentionally performs no I/O and
// returns a clear, inert descriptor.
// ---------------------------------------------------------------------------
/**
 * @returns {{hosted:false, reason:string, integrationPoints:string[]}}
 */
export function hostedExportStub() {
  return {
    hosted: false,
    reason:
      "Hosted analytics/retention is a separate operator-run tier and is intentionally not part of this OSS Action. The Action emits the per-PR analytics records and computes the aggregate locally; an operator wires storage + UI + billing externally.",
    integrationPoints: [
      "buildPrAnalytics(result, meta) — per-PR record to persist",
      "aggregateReport(records) — server-side rollup over retained records",
      "policypack.resolvePolicyPack(name) — premium packs gate (see policypack.js)",
    ],
  };
}

function round4(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e4) / 1e4;
}
function roundMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[k] = round4(v);
  return out;
}
function pct(x) {
  const n = Number(x);
  return Number.isFinite(n) ? `${Math.round(n * 1000) / 10}%` : "0%";
}
