import { describe, it, expect } from "vitest";
import {
  BUILTIN_PACKS,
  listPolicyPacks,
  resolvePolicyPack,
  composePolicyWithPack,
} from "../src/policypack.js";
import { resolvePolicy } from "../src/policy.js";
import { resolveConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/decide.js";

describe("policy packs — built-in catalog", () => {
  it("lists the documented built-in packs", () => {
    const names = listPolicyPacks();
    expect(names).toContain("oss-default");
    expect(names).toContain("oss-strict");
    expect(names).toContain("oss-lenient");
    expect(names).toContain("docs-heavy");
  });

  it("NO built-in pack enables auto-close (that stays an explicit choice)", () => {
    for (const p of Object.values(BUILTIN_PACKS)) {
      expect(p.autoClose).toBeUndefined();
    }
  });

  it("oss-strict lowers thresholds + amplifies body signals; oss-lenient raises them", () => {
    const strict = resolvePolicyPack("oss-strict");
    const lenient = resolvePolicyPack("oss-lenient");
    expect(strict.overlay.thresholds.label).toBeLessThan(
      DEFAULT_CONFIG.labelThreshold,
    );
    expect(strict.overlay.ruleWeights.templateBody).toBeGreaterThan(1);
    expect(lenient.overlay.thresholds.label).toBeGreaterThan(
      DEFAULT_CONFIG.labelThreshold,
    );
    expect(lenient.found).toBe(true);
    expect(strict.paidTier).toBe(false);
  });
});

describe("resolvePolicyPack — unknown name is the PAID TIER seam", () => {
  it("empty name → no pack, no warning, not paid-tier", () => {
    expect(resolvePolicyPack("")).toMatchObject({
      found: false,
      paidTier: false,
      warnings: [],
    });
    expect(resolvePolicyPack(undefined).found).toBe(false);
  });

  it("unknown pack degrades safely: not found, overlay empty, warns, paidTier:true", () => {
    const r = resolvePolicyPack("acme-private-pack-v2");
    expect(r.found).toBe(false);
    expect(r.overlay).toEqual({});
    expect(r.paidTier).toBe(true);
    expect(r.warnings[0]).toMatch(/not a built-in pack/i);
    expect(r.warnings[0]).toMatch(/hosted-tier feature/i);
    expect(r.warnings[0]).toMatch(/no behavior change/i);
  });
});

describe("composePolicyWithPack — precedence: defaults < pack < repo policy keys", () => {
  it("pack fills keys the repo policy left unset; repo keys win on conflict", () => {
    const repoPolicy = resolvePolicy(
      "thresholds:\n  label: 0.7\nexempt-paths:\n  - custom/**",
    );
    const composed = composePolicyWithPack(
      repoPolicy,
      resolvePolicyPack("oss-strict"),
    );
    // repo set label=0.7 explicitly → wins over pack's 0.42
    expect(composed.thresholds.label).toBe(0.7);
    // repo did NOT set comment → pack's value applies
    expect(composed.thresholds.comment).toBe(
      BUILTIN_PACKS["oss-strict"].thresholds.comment,
    );
    // exempt-paths union
    expect(composed.exemptPaths).toContain("custom/**");
    expect(composed.appliedPack).toBe("oss-strict");
  });

  it("carries pack warnings (incl. the paid-tier marker) onto the policy", () => {
    const composed = composePolicyWithPack(
      resolvePolicy("thresholds:\n  label: 0.5"),
      resolvePolicyPack("nonexistent-pack"),
    );
    expect(composed.packPaidTier).toBe(true);
    expect(composed.warnings.some((w) => /not a built-in pack/i.test(w))).toBe(
      true,
    );
  });
});

describe("end-to-end: policy-pack via .pr-slop-gate.yml flows into resolveConfig", () => {
  it("a repo selecting `policy-pack: oss-strict` gets the strict tuning", () => {
    const c = resolveConfig(
      {},
      { policyText: "version: 1\npolicy-pack: oss-strict" },
    );
    expect(c.labelThreshold).toBe(BUILTIN_PACKS["oss-strict"].thresholds.label);
    expect(c.commentThreshold).toBe(
      BUILTIN_PACKS["oss-strict"].thresholds.comment,
    );
    expect(c.ruleWeights.templateBody).toBeGreaterThan(1);
  });

  it("explicit repo keys + Action inputs still override a selected pack", () => {
    const c = resolveConfig(
      { "label-threshold": "0.9" },
      {
        policyText:
          "policy-pack: oss-strict\nthresholds:\n  comment: 0.6",
      },
    );
    expect(c.labelThreshold).toBe(0.9); // Action input wins over everything
    expect(c.commentThreshold).toBe(0.6); // repo key wins over pack
  });

  it("an unknown pack name does NOT change behavior and surfaces the paid-tier warning", () => {
    const c = resolveConfig(
      {},
      { policyText: "policy-pack: some-managed-pack" },
    );
    expect(c.labelThreshold).toBe(DEFAULT_CONFIG.labelThreshold); // unchanged
    expect(c.commentThreshold).toBe(DEFAULT_CONFIG.commentThreshold);
    expect(c.policyWarnings.some((w) => /not a built-in pack/i.test(w))).toBe(
      true,
    );
  });

  it("docs-heavy pack contributes exempt paths consumed by heuristics via config", () => {
    const c = resolveConfig({}, { policyText: "policy-pack: docs-heavy" });
    expect(c.exemptPaths).toContain("docs/**");
    expect(c.exemptPaths).toContain("*.md");
  });
});
