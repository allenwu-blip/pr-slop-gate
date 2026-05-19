import { describe, it, expect } from "vitest";
import {
  buildPrAnalytics,
  aggregateReport,
  formatReport,
  hostedExportStub,
} from "../src/analytics.js";

const RESULT_A = {
  number: 4242,
  author: "casual-driveby-9281",
  score: 0.855123,
  heuristicScore: 0.855123,
  graderScore: 0,
  graderUsed: false,
  decision: "close",
  exemptedBy: null,
  signals: { aiBoilerplate: 1, sprawl: 1, churn: 1, lowEffortBody: 0.4, title: 0.3 },
  provenance: [{ signal: "aiBoilerplate", value: 1, why: "AI boilerplate" }],
};
const RESULT_B = {
  number: 318,
  author: "maria-contrib",
  score: 0,
  heuristicScore: 0,
  graderScore: 0,
  graderUsed: true,
  decision: "allow",
  exemptedBy: null,
  signals: {},
  provenance: [],
};
const RESULT_C = {
  number: 99,
  author: "trusted-bot",
  score: 0.9,
  decision: "allow",
  exemptedBy: "trusted-contributor",
  signals: { aiBoilerplate: 0.9 },
  provenance: [],
};

describe("buildPrAnalytics (per-PR structured record)", () => {
  it("produces a canonical, serializable, deterministic record", () => {
    const a = buildPrAnalytics(RESULT_A, { repo: "acme/widget", dryRun: true });
    const b = buildPrAnalytics(RESULT_A, { repo: "acme/widget", dryRun: true });
    expect(a).toEqual(b); // deterministic
    expect(() => JSON.stringify(a)).not.toThrow();
    expect(a.schema).toBe(1);
    expect(a.pr).toBe(4242);
    expect(a.repo).toBe("acme/widget");
    expect(a.score).toBe(0.8551); // rounded to 4dp
    expect(a.decision).toBe("close");
    expect(a.dryRun).toBe(true);
    expect(a.graderMode).toBe("heuristic-only");
    expect(a.firedSignals).toEqual(
      ["aiBoilerplate", "churn", "lowEffortBody", "sprawl", "title"].sort(),
    );
  });

  it("does not invent a timestamp (pure) but passes one through if given", () => {
    expect(buildPrAnalytics(RESULT_A).at).toBe(null);
    expect(buildPrAnalytics(RESULT_A, { at: "2026-05-18T00:00:00Z" }).at).toBe(
      "2026-05-18T00:00:00Z",
    );
  });

  it("tolerates a malformed/empty result without throwing", () => {
    expect(() => buildPrAnalytics(null)).not.toThrow();
    const r = buildPrAnalytics({});
    expect(r.decision).toBe("allow");
    expect(r.firedSignals).toEqual([]);
  });
});

describe("aggregateReport (org/repo rollup — the hosted dashboard's data)", () => {
  it("rolls up decisions, flagged %, mean score, top signals, trust split", () => {
    const recs = [RESULT_A, RESULT_B, RESULT_C].map((r) =>
      buildPrAnalytics(r, { repo: "acme/widget" }),
    );
    const rep = aggregateReport(recs, { since: "2026-05-01" });
    expect(rep.totals.prsAnalyzed).toBe(3);
    expect(rep.totals.flagged).toBe(1); // only RESULT_A is a non-allow decision
    expect(rep.totals.flaggedPct).toBeCloseTo(1 / 3, 4);
    expect(rep.decisions).toEqual({ allow: 2, label: 0, comment: 0, close: 1 });
    expect(rep.totals.trustedExempt).toBe(1); // RESULT_C
    expect(rep.totals.scoredOnMerit).toBe(2);
    expect(rep.repos).toEqual(["acme/widget"]);
    // aiBoilerplate fires in RESULT_A AND RESULT_C (raw signal is recorded even
    // when the decision was downgraded by the trusted exemption — analytics
    // shows what the scorer saw, not just what was acted on).
    expect(rep.topSignals[0]).toEqual({ signal: "aiBoilerplate", count: 2 });
    expect(rep.window.since).toBe("2026-05-01");
  });

  it("is deterministic and skips malformed rows instead of throwing", () => {
    const recs = [
      buildPrAnalytics(RESULT_A),
      null,
      "garbage",
      { not: "a record" },
    ];
    const r1 = aggregateReport(recs);
    const r2 = aggregateReport(recs);
    expect(r1).toEqual(r2);
    expect(r1.totals.prsAnalyzed).toBe(2); // null skipped; the two objects counted
  });

  it("returns a sane zeroed report for no input", () => {
    const r = aggregateReport([]);
    expect(r.totals.prsAnalyzed).toBe(0);
    expect(r.totals.flaggedPct).toBe(0);
    expect(r.topSignals).toEqual([]);
  });
});

describe("formatReport (faceless plaintext digest)", () => {
  it("renders a deterministic, persona-free summary", () => {
    const rep = aggregateReport(
      [RESULT_A, RESULT_B].map((r) => buildPrAnalytics(r, { repo: "acme/widget" })),
    );
    const txt = formatReport(rep);
    expect(formatReport(rep)).toBe(txt); // deterministic
    expect(txt).toMatch(/pr-slop-gate — aggregate triage report/);
    expect(txt).toMatch(/PRs analyzed: 2/);
    expect(txt).toMatch(/not a verdict/i);
    expect(txt).not.toMatch(/\bI\b|\bwe\b|regards/i); // faceless
  });
});

describe("hostedExportStub (PAID TIER boundary marker — no money/network)", () => {
  it("is inert: returns hosted:false + the integration points, performs no I/O", () => {
    const s = hostedExportStub();
    expect(s.hosted).toBe(false);
    expect(s.reason).toMatch(/operator-run tier|not part of this OSS/i);
    expect(Array.isArray(s.integrationPoints)).toBe(true);
    expect(s.integrationPoints.join(" ")).toMatch(/buildPrAnalytics/);
  });
});
