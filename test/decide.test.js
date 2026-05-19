import { describe, it, expect } from "vitest";
import {
  combineScores,
  isTrusted,
  decide,
  DEFAULT_CONFIG,
} from "../src/decide.js";

describe("combineScores", () => {
  it("weights heuristic + grader scores and clamps to [0,1]", () => {
    expect(
      combineScores({
        heuristicScore: 0.5,
        graderScore: 0.5,
        weights: { heuristic: 0.5, grader: 0.5 },
      }),
    ).toBeCloseTo(0.5);
    expect(
      combineScores({
        heuristicScore: 1,
        graderScore: 1,
        weights: { heuristic: 0.7, grader: 0.7 },
      }),
    ).toBe(1);
  });

  it("falls back to heuristic-only when grader weight is 0 (no LLM key)", () => {
    expect(
      combineScores({
        heuristicScore: 0.42,
        graderScore: 0,
        weights: { heuristic: 1, grader: 0 },
      }),
    ).toBeCloseTo(0.42);
  });
});

describe("isTrusted", () => {
  it("exempts an author who already had a PR merged (prior-merged list)", () => {
    expect(
      isTrusted("maria-contrib", {
        priorMergedAuthors: ["maria-contrib"],
        allowlist: [],
      }),
    ).toBe(true);
  });

  it("exempts an explicitly allowlisted login (case-insensitive)", () => {
    expect(
      isTrusted("Renovate[bot]", {
        priorMergedAuthors: [],
        allowlist: ["renovate[bot]"],
      }),
    ).toBe(true);
  });

  it("does NOT exempt a brand-new contributor with no prior merges", () => {
    expect(
      isTrusted("first-timer-jess", {
        priorMergedAuthors: ["maria-contrib"],
        allowlist: [],
      }),
    ).toBe(false);
  });

  it("handles empty/undefined lists safely", () => {
    expect(isTrusted("x", {})).toBe(false);
  });
});

describe("decide", () => {
  const cfg = DEFAULT_CONFIG;

  it("returns allow + no label below the label threshold", () => {
    const d = decide({ score: 0.1, author: "x", config: cfg, trusted: false });
    expect(d.decision).toBe("allow");
    expect(d.label).toBe(null);
    expect(d.shouldComment).toBe(false);
    expect(d.shouldClose).toBe(false);
  });

  it("labels only between label and comment thresholds", () => {
    const d = decide({
      score: cfg.labelThreshold + 0.001,
      author: "x",
      config: cfg,
      trusted: false,
    });
    expect(d.decision).toBe("label");
    expect(d.label).toBe(cfg.label);
    expect(d.shouldComment).toBe(false);
    expect(d.shouldClose).toBe(false);
  });

  it("labels + comments between comment and close thresholds", () => {
    const d = decide({
      score: cfg.commentThreshold + 0.001,
      author: "x",
      config: cfg,
      trusted: false,
    });
    expect(d.decision).toBe("comment");
    expect(d.label).toBe(cfg.label);
    expect(d.shouldComment).toBe(true);
    expect(d.shouldClose).toBe(false);
  });

  it("labels + comments + closes at/above the close threshold (when autoClose on)", () => {
    const d = decide({
      score: 0.99,
      author: "x",
      config: { ...cfg, autoClose: true },
      trusted: false,
    });
    expect(d.decision).toBe("close");
    expect(d.shouldComment).toBe(true);
    expect(d.shouldClose).toBe(true);
  });

  it("never closes when autoClose is disabled (default) — comments instead", () => {
    const d = decide({
      score: 0.99,
      author: "x",
      config: { ...cfg, autoClose: false },
      trusted: false,
    });
    expect(d.shouldClose).toBe(false);
    expect(d.decision).toBe("comment");
  });

  it("downgrades ANY decision to allow for a trusted contributor (false-positive safety)", () => {
    const d = decide({
      score: 0.99,
      author: "maria-contrib",
      config: { ...cfg, autoClose: true },
      trusted: true,
    });
    expect(d.decision).toBe("allow");
    expect(d.label).toBe(null);
    expect(d.shouldClose).toBe(false);
    expect(d.exemptedBy).toBe("trusted-contributor");
  });
});
