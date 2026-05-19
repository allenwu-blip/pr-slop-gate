import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFeedback, loadFeedback } from "../src/feedback.js";

let dir;
let sink;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "psg-fb-"));
  sink = join(dir, "feedback.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("captureFeedback / loadFeedback (verbatim collector)", () => {
  it("stores text EXACTLY as given — no strip, no normalization", () => {
    const messy = "  This PR was NOT slop!!!\n\tIt fixes a real bug.  \n";
    captureFeedback(sink, { source: "issue-42", text: messy });
    const back = loadFeedback(sink);
    expect(back["issue-42"][0].text).toBe(messy); // byte-for-byte
  });

  it("preserves order and groups by source", () => {
    captureFeedback(sink, { source: "label", text: "first" });
    captureFeedback(sink, { source: "label", text: "second" });
    captureFeedback(sink, { source: "issue", text: "other" });
    const back = loadFeedback(sink);
    expect(back["label"].map((r) => r.text)).toEqual(["first", "second"]);
    expect(back["issue"][0].text).toBe("other");
  });

  it("tags every record with product + timestamp + passthrough extra", () => {
    captureFeedback(sink, {
      source: "issue-7",
      text: "false negative",
      extra: { pr: 7, kind: "fn" },
    });
    const r = loadFeedback(sink)["issue-7"][0];
    expect(r.product).toBe("pr-slop-gate");
    expect(r.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(r.extra).toEqual({ pr: 7, kind: "fn" });
  });

  it("a single corrupt line never aborts the read", () => {
    captureFeedback(sink, { source: "a", text: "ok-1" });
    writeFileSync(sink, "{not json\n", { flag: "a" });
    captureFeedback(sink, { source: "a", text: "ok-2" });
    const back = loadFeedback(sink);
    expect(back["a"].map((r) => r.text)).toEqual(["ok-1", "ok-2"]);
  });

  it("returns {} when the sink does not exist", () => {
    expect(loadFeedback(join(dir, "nope.jsonl"))).toEqual({});
  });
});
