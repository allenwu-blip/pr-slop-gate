import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePullRequestEvent } from "../src/parse.js";
import { scoreHeuristics } from "../src/heuristics.js";

function pr(name) {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return parsePullRequestEvent(JSON.parse(readFileSync(p, "utf8")));
}

describe("richer detection — templateBody (hollow AI scaffold)", () => {
  it("fires when the body is section headers with empty/filler sections", () => {
    const r = scoreHeuristics(pr("template-scaffold-slop.json"));
    expect(r.signals.templateBody).toBeGreaterThan(0);
  });

  it("does NOT fire when the same template is genuinely filled in", () => {
    const r = scoreHeuristics(pr("filled-template-legit.json"));
    expect(r.signals.templateBody).toBe(0);
  });

  it("does NOT fire on a free-text body with no scaffold headers", () => {
    const r = scoreHeuristics(pr("legit.json"));
    expect(r.signals.templateBody).toBe(0);
  });

  it("does NOT fire on an empty body (that is lowEffortBody's job, not this)", () => {
    const r = scoreHeuristics({
      title: "x",
      body: "",
      files: [],
      commitMessages: [],
    });
    expect(r.signals.templateBody).toBe(0);
  });
});

describe("richer detection — commitQuality", () => {
  it("fires when every commit on a non-trivial diff is uninformative", () => {
    const r = scoreHeuristics(pr("template-scaffold-slop.json")); // commits: wip, Update
    expect(r.signals.commitQuality).toBeGreaterThan(0);
  });

  it("does NOT fire when commit messages are descriptive", () => {
    const r = scoreHeuristics(pr("filled-template-legit.json"));
    expect(r.signals.commitQuality).toBe(0);
  });

  it("does NOT fire on a tiny focused change even with a terse commit", () => {
    const r = scoreHeuristics(pr("first-time-legit.json")); // no _commits → unknown
    expect(r.signals.commitQuality).toBe(0);
  });

  it("never penalizes when commit messages are unavailable", () => {
    const r = scoreHeuristics({
      title: "Big change",
      body: "x",
      additions: 999,
      deletions: 999,
      changedFiles: 40,
      files: [],
      commitMessages: [],
    });
    expect(r.signals.commitQuality).toBe(0);
  });
});

describe("richer detection — intentMismatch", () => {
  it("fires when the body promises a code fix but the diff is whitespace-only", () => {
    const r = scoreHeuristics(pr("intent-mismatch-slop.json"));
    expect(r.signals.intentMismatch).toBeGreaterThan(0);
  });

  it("does NOT fire when the body's claim matches a real code change", () => {
    const r = scoreHeuristics(pr("legit.json")); // says fixes #311, has real code diff
    expect(r.signals.intentMismatch).toBe(0);
  });

  it("does NOT fire when the body scopes itself to docs/typo", () => {
    const r = scoreHeuristics(pr("first-time-legit.json")); // 'typo ... string-only change'
    expect(r.signals.intentMismatch).toBe(0);
  });

  it("respects repo exempt-paths: a code claim whose only changes are exempt files does not auto-clear into a false negative on legit docs", () => {
    // sanity: with docs/** exempt, a docs-only PR that *says* it's docs work
    // still scores 0 (no concrete code claim contradiction).
    const r = scoreHeuristics(pr("intent-mismatch-slop.json"), {
      exemptPaths: ["src/**"], // pretend all src is exempt
    });
    // Every changed file is now exempt → no real code anywhere → still flags
    // the contradiction (body promised a real fix, nothing real changed).
    expect(r.signals.intentMismatch).toBeGreaterThan(0);
  });
});

describe("richer detection — massRename", () => {
  it("fires on many pure renames with little/no content change", () => {
    const r = scoreHeuristics(pr("mass-rename-slop.json"));
    expect(r.signals.massRename).toBeGreaterThan(0);
  });

  it("does NOT fire on a normal small modified-files PR", () => {
    const r = scoreHeuristics(pr("legit.json"));
    expect(r.signals.massRename).toBe(0);
  });
});

describe("provenance + conservatism (no cry-wolf)", () => {
  it("attaches human-readable provenance for every fired signal", () => {
    const r = scoreHeuristics(pr("template-scaffold-slop.json"));
    expect(Array.isArray(r.provenance)).toBe(true);
    expect(r.provenance.length).toBeGreaterThan(0);
    for (const p of r.provenance) {
      expect(p).toHaveProperty("signal");
      expect(p).toHaveProperty("value");
      expect(typeof p.why).toBe("string");
      expect(p.why.length).toBeGreaterThan(0);
      expect(p.value).toBeGreaterThanOrEqual(0.3);
    }
    // sorted strongest-first
    const vals = r.provenance.map((p) => p.value);
    expect(vals).toEqual([...vals].sort((a, b) => b - a));
  });

  it("the genuine filled-template PR stays well below the label threshold", () => {
    const r = scoreHeuristics(pr("filled-template-legit.json"));
    expect(r.score).toBeLessThan(0.3);
    expect(r.provenance).toEqual([]);
  });

  it("a small genuine first-timer still scores low with the new signals active", () => {
    const r = scoreHeuristics(pr("first-time-legit.json"));
    expect(r.score).toBeLessThan(0.3);
  });

  it("a clearly-slop PR scores substantially higher than every legit fixture", () => {
    const slop = scoreHeuristics(pr("clearly-slop.json")).score;
    for (const legit of [
      "legit.json",
      "first-time-legit.json",
      "filled-template-legit.json",
    ]) {
      expect(slop - scoreHeuristics(pr(legit)).score).toBeGreaterThan(0.3);
    }
  });

  it("a strongly multi-signal scaffold PR clears the label threshold on heuristics alone", () => {
    // 5 independent tells fire → corroboration lifts it over 0.5 without any
    // single signal being able to do that itself.
    expect(scoreHeuristics(pr("template-scaffold-slop.json")).score).toBeGreaterThanOrEqual(
      0.5,
    );
  });

  it("subtler slop (mass-rename / intent-mismatch) gets a real but conservative heuristic signal (grader territory — see triage tests)", () => {
    // Honest: these are deliberately subtle. Heuristics-alone must NOT
    // over-condemn them, but must still register a non-trivial signal that,
    // combined with the LLM grader, crosses the line.
    const mr = scoreHeuristics(pr("mass-rename-slop.json")).score;
    const im = scoreHeuristics(pr("intent-mismatch-slop.json")).score;
    expect(mr).toBeGreaterThan(0.05);
    expect(mr).toBeLessThan(0.5); // not condemned on heuristics alone
    expect(im).toBeGreaterThan(0.05);
    expect(im).toBeLessThan(0.5);
  });

  it("corroboration bonus is structurally incapable of lifting a zero-signal legit PR", () => {
    for (const f of [
      "legit.json",
      "first-time-legit.json",
      "filled-template-legit.json",
    ]) {
      expect(scoreHeuristics(pr(f)).score).toBe(0);
    }
  });

  it("per-signal rule weight of 0 disables a signal; 2 amplifies it (clamped)", () => {
    const base = scoreHeuristics(pr("mass-rename-slop.json"));
    const off = scoreHeuristics(pr("mass-rename-slop.json"), {
      ruleWeights: { massRename: 0 },
    });
    const amp = scoreHeuristics(pr("mass-rename-slop.json"), {
      ruleWeights: { massRename: 2 },
    });
    expect(off.score).toBeLessThan(base.score);
    expect(amp.score).toBeGreaterThanOrEqual(base.score);
  });
});
