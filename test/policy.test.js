import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  resolvePolicy,
  makeExemptMatcher,
  EMPTY_POLICY,
  KNOWN_SIGNALS,
} from "../src/policy.js";
import { resolveConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/decide.js";

const FULL = `
version: 1
thresholds:
  label: 0.45
  comment: 0.6
  close: 0.9
weights:
  heuristic: 0.7
  grader: 0.3
rules:
  sprawl: 1.5
  churn: 0.0
allowlist:
  - dependabot[bot]
  - renovate[bot]
trusted-authors:
  - core-dev
exempt-paths:
  - "docs/**"
  - "*.md"
auto-close: true
routing:
  label: needs-human-review
policy-pack: oss-strict
`;

describe("resolvePolicy (.pr-slop-gate.yml → normalized policy)", () => {
  it("returns the EMPTY_POLICY when absent / blank", () => {
    expect(resolvePolicy("")).toBe(EMPTY_POLICY);
    expect(resolvePolicy("   \n  ").present).toBe(false);
    expect(resolvePolicy(undefined)).toBe(EMPTY_POLICY);
  });

  it("parses a full valid policy file", () => {
    const p = resolvePolicy(FULL);
    expect(p.present).toBe(true);
    expect(p.thresholds).toEqual({ label: 0.45, comment: 0.6, close: 0.9 });
    expect(p.weights).toEqual({ heuristic: 0.7, grader: 0.3 });
    expect(p.ruleWeights).toEqual({ sprawl: 1.5, churn: 0 });
    expect(p.allowlist).toEqual(["dependabot[bot]", "renovate[bot]"]);
    expect(p.trustedAuthors).toEqual(["core-dev"]);
    expect(p.exemptPaths).toEqual(["docs/**", "*.md"]);
    expect(p.autoClose).toBe(true);
    expect(p.routing).toEqual({ label: "needs-human-review" });
    expect(p.policyPack).toBe("oss-strict");
    expect(p.warnings).toEqual([]);
  });

  it("warns + ignores unknown top-level keys and unknown rules (typo safety)", () => {
    const p = resolvePolicy("threshold: 0.5\nrules:\n  notARule: 1");
    expect(p.warnings.some((w) => /unknown key `threshold`/.test(w))).toBe(true);
    expect(p.warnings.some((w) => /unknown rule `notARule`/.test(w))).toBe(true);
    expect(p.thresholds).toEqual({});
  });

  it("clamps/rejects out-of-range numerics and keeps defaults (never tightens silently)", () => {
    const p = resolvePolicy(
      "thresholds:\n  label: 5\n  comment: -1\nweights:\n  grader: 9\nrules:\n  sprawl: 99",
    );
    expect(p.thresholds.label).toBeUndefined(); // rejected → caller uses default
    expect(p.thresholds.comment).toBeUndefined();
    expect(p.weights.grader).toBeUndefined();
    expect(p.ruleWeights.sprawl).toBeUndefined();
    expect(p.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("repairs misordered thresholds so policy can't be more aggressive than intended", () => {
    const p = resolvePolicy("thresholds:\n  label: 0.9\n  comment: 0.5\n  close: 0.4");
    // label was > comment, comment was > close → both raised, monotonic
    expect(p.thresholds.label).toBeLessThanOrEqual(p.thresholds.comment);
    expect(p.thresholds.comment).toBeLessThanOrEqual(p.thresholds.close);
    expect(p.warnings.some((w) => /raising/.test(w))).toBe(true);
  });

  it("rejects a non-mapping top level without throwing", () => {
    const p = resolvePolicy("- just\n- a\n- list");
    expect(p.present).toBe(true);
    expect(p.warnings.some((w) => /top level must be a mapping/.test(w))).toBe(
      true,
    );
    expect(p).toMatchObject({ thresholds: {}, allowlist: [] });
  });

  it("warns on unsupported version but still parses", () => {
    const p = resolvePolicy("version: 2\nthresholds:\n  label: 0.5");
    expect(p.warnings.some((w) => /unsupported version/.test(w))).toBe(true);
    expect(p.thresholds.label).toBe(0.5);
  });

  it("coerces wrong-typed list/bool/string fields safely", () => {
    const p = resolvePolicy(
      'allowlist: not-a-list\nauto-close: maybe\npolicy-pack: 12',
    );
    expect(p.allowlist).toEqual([]);
    expect(p.autoClose).toBeUndefined();
    expect(p.policyPack).toBe("");
    expect(p.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("KNOWN_SIGNALS covers the documented rule names", () => {
    expect(KNOWN_SIGNALS).toContain("aiBoilerplate");
    expect(KNOWN_SIGNALS).toContain("templateBody");
    expect(KNOWN_SIGNALS).toContain("intentMismatch");
    expect(KNOWN_SIGNALS).toContain("massRename");
  });
});

describe("makeExemptMatcher (path-exemption glob subset)", () => {
  it("matches prefix (dir/**, dir/), suffix (*.ext), and exact", () => {
    const m = makeExemptMatcher(["docs/**", "vendor/", "*.md", "CHANGELOG.txt"]);
    expect(m("docs/guide/intro.md")).toBe(true);
    expect(m("vendor/lib.js")).toBe(true);
    expect(m("README.md")).toBe(true);
    expect(m("CHANGELOG.txt")).toBe(true);
    expect(m("src/index.js")).toBe(false);
  });

  it("returns a no-op matcher for an empty list", () => {
    const m = makeExemptMatcher([]);
    expect(m("anything")).toBe(false);
  });
});

describe("resolveConfig layering: defaults < repo policy < Action inputs", () => {
  it("with no policy + no inputs → exactly DEFAULT_CONFIG values", () => {
    const c = resolveConfig({});
    expect(c.labelThreshold).toBe(DEFAULT_CONFIG.labelThreshold);
    expect(c.weights).toEqual(DEFAULT_CONFIG.weights);
    expect(c.autoClose).toBe(false);
  });

  it("repo policy overrides built-in defaults (and composes the named pack under explicit keys)", () => {
    const c = resolveConfig({}, { policyText: FULL });
    expect(c.labelThreshold).toBe(0.45); // FULL set thresholds explicitly → win over pack
    expect(c.commentThreshold).toBe(0.6);
    expect(c.weights).toEqual({ heuristic: 0.7, grader: 0.3 });
    expect(c.autoClose).toBe(true);
    expect(c.label).toBe("needs-human-review"); // routing.label
    // FULL declares `policy-pack: oss-strict`. The repo's explicit rule
    // weights (sprawl/churn) WIN; the pack fills the rest it didn't set.
    expect(c.ruleWeights.sprawl).toBe(1.5); // repo key beats pack
    expect(c.ruleWeights.churn).toBe(0); // repo key beats pack
    expect(c.ruleWeights.templateBody).toBe(1.4); // from oss-strict pack
    expect(c.exemptPaths).toEqual(expect.arrayContaining(["docs/**", "*.md"]));
    expect(c.policyPack).toBe("oss-strict");
  });

  it("an explicit Action input wins over the repo policy", () => {
    const c = resolveConfig(
      { "label-threshold": "0.8", "auto-close": "false" },
      { policyText: FULL },
    );
    expect(c.labelThreshold).toBe(0.8); // input beats policy's 0.45
    expect(c.autoClose).toBe(false); // input beats policy's true
    expect(c.commentThreshold).toBe(0.6); // untouched input → policy value kept
  });

  it("surfaces policy warnings on the resolved config (for the run log)", () => {
    const c = resolveConfig({}, { policyText: "bogusKey: 1" });
    expect(c.policyPresent).toBe(true);
    expect(c.policyWarnings.some((w) => /unknown key/.test(w))).toBe(true);
  });

  it("the shipped examples/.pr-slop-gate.yml parses with ZERO warnings (no doc rot)", () => {
    const p = fileURLToPath(
      new URL("../examples/.pr-slop-gate.yml", import.meta.url),
    );
    const policy = resolvePolicy(readFileSync(p, "utf8"));
    expect(policy.warnings).toEqual([]);
    expect(policy.present).toBe(true);
    // sanity: the documented keys actually took effect
    expect(policy.thresholds).toEqual({ label: 0.5, comment: 0.65, close: 0.85 });
    expect(policy.allowlist).toContain("dependabot[bot]");
    expect(policy.exemptPaths).toContain("docs/**");
  });

  it("a malformed policy never throws and never changes the safe defaults", () => {
    const c = resolveConfig({}, { policyText: "::::\n\t\tbad: [" });
    expect(c.labelThreshold).toBe(DEFAULT_CONFIG.labelThreshold);
    expect(c.autoClose).toBe(false);
  });
});
