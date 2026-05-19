import { describe, it, expect } from "vitest";
import { resolveConfig, parseList } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/decide.js";

describe("parseList", () => {
  it("splits on commas and newlines, trims, drops blanks", () => {
    expect(parseList(" a, b\n c ,,\n")).toEqual(["a", "b", "c"]);
  });
  it("returns [] for empty/undefined", () => {
    expect(parseList("")).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe("resolveConfig (Action inputs -> config, with safe defaults)", () => {
  it("returns DEFAULT_CONFIG when no overrides are given", () => {
    const c = resolveConfig({});
    expect(c.labelThreshold).toBe(DEFAULT_CONFIG.labelThreshold);
    expect(c.autoClose).toBe(false);
    expect(c.weights).toEqual(DEFAULT_CONFIG.weights);
  });

  it("applies numeric threshold + weight overrides", () => {
    const c = resolveConfig({
      "label-threshold": "0.4",
      "comment-threshold": "0.6",
      "close-threshold": "0.9",
      "heuristic-weight": "0.7",
      "grader-weight": "0.3",
      "auto-close": "true",
    });
    expect(c.labelThreshold).toBe(0.4);
    expect(c.commentThreshold).toBe(0.6);
    expect(c.closeThreshold).toBe(0.9);
    expect(c.weights).toEqual({ heuristic: 0.7, grader: 0.3 });
    expect(c.autoClose).toBe(true);
  });

  it("ignores garbage numeric inputs and keeps the default", () => {
    const c = resolveConfig({ "label-threshold": "not-a-number" });
    expect(c.labelThreshold).toBe(DEFAULT_CONFIG.labelThreshold);
  });

  it("REGRESSION: empty-string inputs (the GitHub Actions unset case) must NOT collapse thresholds/weights to 0", () => {
    // GitHub exposes unset inputs as "" — Number("") is 0, which would have
    // made every threshold 0 and flagged every PR. Must fall back to defaults.
    const c = resolveConfig({
      "label-threshold": "",
      "comment-threshold": "",
      "close-threshold": "",
      "heuristic-weight": "",
      "grader-weight": "",
      label: "",
      "feedback-label": "",
    });
    expect(c.labelThreshold).toBe(DEFAULT_CONFIG.labelThreshold);
    expect(c.commentThreshold).toBe(DEFAULT_CONFIG.commentThreshold);
    expect(c.closeThreshold).toBe(DEFAULT_CONFIG.closeThreshold);
    expect(c.weights).toEqual(DEFAULT_CONFIG.weights);
    expect(c.label).toBe(DEFAULT_CONFIG.label);
    expect(c.feedbackLabel).toBe(DEFAULT_CONFIG.feedbackLabel);
  });

  it("REGRESSION: whitespace-only numeric input falls back to default", () => {
    expect(resolveConfig({ "label-threshold": "   " }).labelThreshold).toBe(
      DEFAULT_CONFIG.labelThreshold,
    );
  });

  it("forces grader-weight to 0 when grading is disabled (no key path)", () => {
    const c = resolveConfig({ "disable-grader": "true" });
    expect(c.weights.grader).toBe(0);
  });

  it("treats auto-close as false unless explicitly 'true'", () => {
    expect(resolveConfig({ "auto-close": "false" }).autoClose).toBe(false);
    expect(resolveConfig({ "auto-close": "" }).autoClose).toBe(false);
    expect(resolveConfig({ "auto-close": "TRUE" }).autoClose).toBe(true);
  });

  it("clamps thresholds/weights into [0,1]", () => {
    const c = resolveConfig({
      "label-threshold": "-2",
      "heuristic-weight": "9",
    });
    expect(c.labelThreshold).toBeGreaterThanOrEqual(0);
    expect(c.weights.heuristic).toBeLessThanOrEqual(1);
  });
});
