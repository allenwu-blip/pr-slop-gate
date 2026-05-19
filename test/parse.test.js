import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePullRequestEvent } from "../src/parse.js";

function fx(name) {
  const p = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("parsePullRequestEvent", () => {
  it("normalizes a GitHub pull_request event (dict input) into a stable pr object", () => {
    const pr = parsePullRequestEvent(fx("legit.json"));
    expect(pr.number).toBe(318);
    expect(pr.title).toMatch(/race condition/i);
    expect(pr.author).toBe("maria-contrib");
    expect(pr.additions).toBe(41);
    expect(pr.deletions).toBe(12);
    expect(pr.changedFiles).toBe(2);
    expect(pr.commits).toBe(3);
    expect(pr.draft).toBe(false);
    expect(pr.baseRepo).toBe("acme/widget");
    expect(Array.isArray(pr.files)).toBe(true);
    expect(pr.files[0]).toHaveProperty("filename");
    expect(typeof pr.diff).toBe("string");
  });

  it("is pure and does no network/file I/O when given a dict", () => {
    // Calling twice yields deep-equal results (no hidden state / fetch).
    const a = parsePullRequestEvent(fx("clearly-slop.json"));
    const b = parsePullRequestEvent(fx("clearly-slop.json"));
    expect(a).toEqual(b);
  });

  it("throws a clear error if the payload is not a pull_request event", () => {
    expect(() => parsePullRequestEvent({ issue: {} })).toThrow(
      /not a pull_request event/i,
    );
  });

  it("defaults missing optional fields safely", () => {
    const pr = parsePullRequestEvent({
      pull_request: {
        number: 1,
        title: "x",
        user: { login: "a" },
        base: { ref: "main" },
        head: { ref: "f" },
      },
      repository: { full_name: "o/r" },
    });
    expect(pr.body).toBe("");
    expect(pr.additions).toBe(0);
    expect(pr.files).toEqual([]);
    expect(pr.labels).toEqual([]);
  });
});
