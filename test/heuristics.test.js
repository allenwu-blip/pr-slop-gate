import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePullRequestEvent } from "../src/parse.js";
import { scoreHeuristics } from "../src/heuristics.js";

function pr(name) {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return parsePullRequestEvent(JSON.parse(readFileSync(p, "utf8")));
}

describe("scoreHeuristics", () => {
  it("returns a score in [0,1] plus a breakdown of signals", () => {
    const r = scoreHeuristics(pr("legit.json"));
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.signals).toBeTypeOf("object");
    expect(Object.keys(r.signals).length).toBeGreaterThan(0);
  });

  it("scores a clearly-slop AI PR substantially higher than a focused legit PR", () => {
    const slop = scoreHeuristics(pr("clearly-slop.json")).score;
    const legit = scoreHeuristics(pr("legit.json")).score;
    expect(slop).toBeGreaterThan(legit);
    expect(slop - legit).toBeGreaterThan(0.3);
  });

  it("does NOT penalize a small genuine first-time contribution", () => {
    // Being new is not a heuristic signal; a tiny well-formed typo fix
    // must score low so the exemption layer is not even needed.
    const ft = scoreHeuristics(pr("first-time-legit.json")).score;
    expect(ft).toBeLessThan(0.3);
  });

  it("flags AI boilerplate phrasing in the PR body", () => {
    const r = scoreHeuristics(pr("clearly-slop.json"));
    expect(r.signals.aiBoilerplate).toBeGreaterThan(0);
  });

  it("flags massive sprawling diffs across many unrelated files", () => {
    const r = scoreHeuristics(pr("clearly-slop.json"));
    expect(r.signals.sprawl).toBeGreaterThan(0);
  });

  it("flags whitespace/no-op churn (added vs removed lines nearly identical, trailing-space patches)", () => {
    const r = scoreHeuristics(pr("clearly-slop.json"));
    expect(r.signals.churn).toBeGreaterThan(0);
  });

  it("rewards a linked issue / substantive body (lower score)", () => {
    const r = scoreHeuristics(pr("legit.json"));
    // legit references #311 and explains a repro → low body-quality risk
    expect(r.signals.lowEffortBody).toBe(0);
  });

  it("is deterministic and pure (same input → same output, no I/O)", () => {
    const a = scoreHeuristics(pr("clearly-slop.json"));
    const b = scoreHeuristics(pr("clearly-slop.json"));
    expect(a).toEqual(b);
  });

  it("handles an empty/degenerate PR without throwing", () => {
    const r = scoreHeuristics({
      number: 1,
      title: "",
      body: "",
      author: "x",
      additions: 0,
      deletions: 0,
      changedFiles: 0,
      commits: 0,
      files: [],
      diff: "",
      labels: [],
    });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});
