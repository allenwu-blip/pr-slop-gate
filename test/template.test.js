import { describe, it, expect } from "vitest";
import { renderComment } from "../src/template.js";

describe("renderComment (polite, faceless, no persona)", () => {
  const base = {
    prNumber: 4242,
    score: 0.91,
    label: "possible-ai-slop",
    repo: "acme/widget",
    reasons: ["AI boilerplate phrasing", "sprawling diff across 37 files"],
    feedbackLabel: "pr-slop-gate-feedback",
  };

  it("produces a courteous comment for a flagged-but-not-closed PR", () => {
    const txt = renderComment(
      { decision: "comment", shouldClose: false },
      base,
    );
    expect(txt).toMatch(/thank/i);
    expect(txt).toMatch(/automated/i);
    // No first person / persona / signature.
    expect(txt).not.toMatch(/\bI\b|\bme\b|\bmy\b/);
    expect(txt).not.toMatch(/regards|sincerely|—\s*\w+ bot/i);
  });

  it("includes a clear, non-accusatory framing and a path to appeal", () => {
    const txt = renderComment(
      { decision: "comment", shouldClose: false },
      base,
    );
    expect(txt).toMatch(/maintainer/i);
    expect(txt).toMatch(/false positive|mistake|in error/i);
    // Appeal route references the feedback label so misfires are reportable.
    expect(txt).toMatch(/pr-slop-gate-feedback/);
  });

  it("uses softer wording when the PR is being auto-closed", () => {
    const closed = renderComment(
      { decision: "close", shouldClose: true },
      base,
    );
    expect(closed).toMatch(/clos/i);
    expect(closed).toMatch(/reopen|comment to/i);
    expect(closed).not.toMatch(/\bspam\b/i); // never call a human "spam"
  });

  it("surfaces the reasons so the decision is transparent", () => {
    const txt = renderComment(
      { decision: "comment", shouldClose: false },
      base,
    );
    expect(txt).toMatch(/AI boilerplate phrasing/);
    expect(txt).toMatch(/sprawling diff/);
  });

  it("does not leak the numeric score as a verdict but may show it as a signal", () => {
    const txt = renderComment(
      { decision: "comment", shouldClose: false },
      base,
    );
    // It's fine to mention an automated signal; it must not assert certainty.
    expect(txt).not.toMatch(/definitely|certainly|proven/i);
  });

  it("is deterministic for the same inputs", () => {
    const a = renderComment({ decision: "comment", shouldClose: false }, base);
    const b = renderComment({ decision: "comment", shouldClose: false }, base);
    expect(a).toBe(b);
  });
});
