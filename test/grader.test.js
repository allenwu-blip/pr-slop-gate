import { describe, it, expect } from "vitest";
import { FakeGrader } from "../src/grader.js";

describe("FakeGrader (used in all tests — no network, no API key)", () => {
  it("returns a deterministic score + reasons matching the Grader interface", async () => {
    const g = new FakeGrader({ score: 0.8, reasons: ["looks templated"] });
    const out = await g.grade(
      { number: 1, title: "x", body: "y", diff: "" },
      { contributing: "Be nice." },
    );
    expect(out.score).toBe(0.8);
    expect(out.reasons).toEqual(["looks templated"]);
  });

  it("can vary score by predicate so tests can simulate the LLM judgment", async () => {
    const g = new FakeGrader({
      scoreFor: (pr) => (/as an ai language model/i.test(pr.body) ? 0.95 : 0.1),
    });
    expect(
      (await g.grade({ body: "As an AI language model I improved..." }, {}))
        .score,
    ).toBe(0.95);
    expect((await g.grade({ body: "Fixes #311, real repro." }, {})).score).toBe(
      0.1,
    );
  });

  it("never performs I/O (resolves synchronously-ish, no fetch)", async () => {
    const g = new FakeGrader({ score: 0 });
    const out = await g.grade({}, {});
    expect(out).toEqual({ score: 0, reasons: [] });
  });
});

describe("AnthropicGrader (real adapter — interface shape only, NOT called in CI)", () => {
  it("is exported and constructs without throwing, but is not invoked here", async () => {
    const { AnthropicGrader } = await import("../src/grader.js");
    expect(typeof AnthropicGrader).toBe("function");
    const g = new AnthropicGrader({ apiKey: "not-used-in-ci" });
    expect(typeof g.grade).toBe("function");
    // We intentionally do NOT call g.grade() — it would require a real key
    // and network. The contract is verified via FakeGrader above.
  });

  it("throws a clear error if grade() is called without an API key", async () => {
    const { AnthropicGrader } = await import("../src/grader.js");
    const g = new AnthropicGrader({ apiKey: "" });
    await expect(g.grade({ title: "x" }, {})).rejects.toThrow(
      /ANTHROPIC_API_KEY/i,
    );
  });
});
