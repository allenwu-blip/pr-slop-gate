import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { triage } from "../src/triage.js";
import { FakeGrader } from "../src/grader.js";
import { DEFAULT_CONFIG } from "../src/decide.js";

function event(name) {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("triage (orchestrator — pure given an injected grader, NO network)", () => {
  it("flags + recommends closing a clearly AI-slop PR from a driveby account", async () => {
    const grader = new FakeGrader({ score: 0.9, reasons: ["templated body"] });
    const r = await triage(event("clearly-slop.json"), {
      config: { ...DEFAULT_CONFIG, autoClose: true },
      grader,
      contributing: "Please link an issue and keep PRs focused.",
      priorMergedAuthors: [],
      allowlist: [],
    });
    expect(r.score).toBeGreaterThan(DEFAULT_CONFIG.commentThreshold);
    expect(["comment", "close"]).toContain(r.decision);
    expect(r.label).toBe(DEFAULT_CONFIG.label);
    expect(r.comment).toMatch(/thank/i);
    expect(r.exemptedBy).toBe(null);
  });

  it("allows a focused, well-described legit PR (no label, no comment)", async () => {
    const grader = new FakeGrader({ score: 0.05, reasons: [] });
    const r = await triage(event("legit.json"), {
      config: DEFAULT_CONFIG,
      grader,
      contributing: "Please link an issue and keep PRs focused.",
      priorMergedAuthors: [],
      allowlist: [],
    });
    expect(r.decision).toBe("allow");
    expect(r.label).toBe(null);
    expect(r.comment).toBe(null);
  });

  it("allows a genuine first-time contributor on heuristics alone (low score, no exemption needed)", async () => {
    const grader = new FakeGrader({ score: 0.1, reasons: [] });
    const r = await triage(event("first-time-legit.json"), {
      config: DEFAULT_CONFIG,
      grader,
      contributing: "Please link an issue and keep PRs focused.",
      priorMergedAuthors: [], // jess is NOT exempt — must pass on merit
      allowlist: [],
    });
    expect(r.decision).toBe("allow");
    expect(r.exemptedBy).toBe(null); // proves it passed on score, not exemption
  });

  it("exempts a previously-merged author even if the score is high (false-positive safety)", async () => {
    const grader = new FakeGrader({ score: 0.99, reasons: ["x"] });
    const r = await triage(event("clearly-slop.json"), {
      config: { ...DEFAULT_CONFIG, autoClose: true },
      grader,
      contributing: "rules",
      priorMergedAuthors: ["casual-driveby-9281"], // pretend they're trusted
      allowlist: [],
    });
    expect(r.decision).toBe("allow");
    expect(r.exemptedBy).toBe("trusted-contributor");
    expect(r.label).toBe(null);
  });

  it("works heuristic-only when grader weight is 0 (no Anthropic key configured)", async () => {
    const grader = new FakeGrader({ score: 1 }); // should be ignored
    const r = await triage(event("clearly-slop.json"), {
      config: { ...DEFAULT_CONFIG, weights: { heuristic: 1, grader: 0 } },
      grader,
      contributing: "rules",
      priorMergedAuthors: [],
      allowlist: [],
    });
    // Heuristics alone still catch the obvious slop fixture.
    expect(r.score).toBeGreaterThan(DEFAULT_CONFIG.labelThreshold);
    expect(r.graderUsed).toBe(false);
  });

  it("returns a structured, serializable result for the Action outputs", async () => {
    const grader = new FakeGrader({ score: 0.5 });
    const r = await triage(event("legit.json"), {
      config: DEFAULT_CONFIG,
      grader,
      contributing: "rules",
    });
    expect(r).toMatchObject({
      score: expect.any(Number),
      decision: expect.any(String),
    });
    expect(Array.isArray(r.provenance)).toBe(true);
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it("catches deliberately-subtle slop when the LLM grader corroborates (the documented heuristic+grader design)", async () => {
    // intent-mismatch is sub-threshold on heuristics alone (by design). A
    // maintainer fighting subtle fabrications raises grader-weight; with the
    // grader leaning in, the contradiction crosses the label line. (Honest:
    // at the *default* 60/40 blend a single near-zero-heuristic PR with a
    // strong grade lands ~0.39 — documented as grader territory.)
    const grader = new FakeGrader({
      scoreFor: (p) => (/fix(es)? the failing/i.test(p.title) ? 0.9 : 0.1),
      reasonsFor: () => ["body claims a fix the diff does not contain"],
    });
    const r = await triage(event("intent-mismatch-slop.json"), {
      config: { ...DEFAULT_CONFIG, weights: { heuristic: 0.4, grader: 0.6 } },
      grader,
      contributing: "Link an issue; describe the real change.",
      priorMergedAuthors: [],
      allowlist: [],
    });
    expect(r.score).toBeGreaterThanOrEqual(DEFAULT_CONFIG.labelThreshold);
    expect(["label", "comment", "close"]).toContain(r.decision);
    expect(r.reasons.join(" ")).toMatch(/diff does not contain|no real code/i);
  });

  it("surfaces rich per-signal provenance text in the posted comment", async () => {
    const grader = new FakeGrader({ score: 0 });
    // Lower the comment threshold so the strongly-multi-signal scaffold PR
    // actually posts a comment (label-only is silent by design), letting us
    // assert the provenance text reaches the contributor.
    const r = await triage(event("template-scaffold-slop.json"), {
      config: {
        ...DEFAULT_CONFIG,
        commentThreshold: 0.5,
        weights: { heuristic: 1, grader: 0 },
      },
      grader,
      contributing: "rules",
    });
    expect(r.decision).toBe("comment");
    expect(typeof r.comment).toBe("string");
    expect(r.comment).toMatch(/scaffold|hollow|uninformative|filler/i);
    expect(r.provenance.length).toBeGreaterThan(0);
  });

  it("honors policy exempt-paths passed via config (docs-only churn not punished as code mismatch)", async () => {
    const grader = new FakeGrader({ score: 0 });
    // A PR that says it fixes a bug but only touches docs/, with docs/**
    // exempt — intentMismatch should NOT fire (the body+diff are consistent
    // once docs are excluded AND the built-in docs floor applies).
    const ev = {
      action: "opened",
      pull_request: {
        number: 9,
        title: "Fix the broken setup instructions",
        body: "Fixes the broken setup steps in the guide.",
        user: { login: "doc-fixer" },
        additions: 10,
        deletions: 4,
        changed_files: 1,
        commits: 1,
        base: { ref: "main" },
        head: { ref: "doc" },
        labels: [],
      },
      repository: { full_name: "acme/widget" },
      _files: [
        {
          filename: "docs/setup.md",
          status: "modified",
          additions: 10,
          deletions: 4,
          patch: "@@ -1 +1 @@\n-run npm star\n+run npm start\n",
        },
      ],
    };
    const r = await triage(ev, {
      config: { ...DEFAULT_CONFIG, exemptPaths: ["docs/**"], weights: { heuristic: 1, grader: 0 } },
      grader,
      contributing: "",
    });
    expect(r.signals.intentMismatch).toBe(0);
    expect(r.decision).toBe("allow");
  });

  it("applies per-signal rule-weight multipliers from config (0 disables a signal end-to-end)", async () => {
    const grader = new FakeGrader({ score: 0 });
    const withRule = await triage(event("mass-rename-slop.json"), {
      config: { ...DEFAULT_CONFIG, weights: { heuristic: 1, grader: 0 } },
      grader,
      contributing: "",
    });
    const disabled = await triage(event("mass-rename-slop.json"), {
      config: {
        ...DEFAULT_CONFIG,
        weights: { heuristic: 1, grader: 0 },
        ruleWeights: { massRename: 0, aiBoilerplate: 0 },
      },
      grader,
      contributing: "",
    });
    expect(disabled.score).toBeLessThan(withRule.score);
  });
});
