/**
 * grader.js — the LLM-grader interface, a deterministic FakeGrader for tests,
 * and a thin real adapter (AnthropicGrader) that calls Anthropic Claude.
 *
 * Grader contract:
 *   grade(pr, { contributing }) -> Promise<{ score: number, reasons: string[] }>
 *   - score in [0,1]: probability the PR is low-effort AI slop relative to the
 *     repo's CONTRIBUTING rules.
 *   - reasons: short human-readable bullet strings (shown in the comment).
 *
 * CI ONLY EVER USES FakeGrader. The real adapter requires the operator's
 * ANTHROPIC_API_KEY and is never exercised in tests (no network in CI).
 * It uses Anthropic Claude exclusively — never OpenAI, and never a hardcoded
 * key (key comes from the constructor, wired from env by the runner).
 */

const clamp01 = (x) =>
  !Number.isFinite(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x;

/**
 * Deterministic, network-free grader for tests and for local heuristic-only
 * runs. Configure with a fixed `score`/`reasons`, or a `scoreFor(pr)` /
 * `reasonsFor(pr)` predicate to simulate the LLM's judgment in tests.
 */
export class FakeGrader {
  constructor(opts = {}) {
    this._score = typeof opts.score === "number" ? opts.score : 0;
    this._reasons = Array.isArray(opts.reasons) ? opts.reasons : [];
    this._scoreFor = typeof opts.scoreFor === "function" ? opts.scoreFor : null;
    this._reasonsFor =
      typeof opts.reasonsFor === "function" ? opts.reasonsFor : null;
  }

  async grade(pr, _ctx = {}) {
    const score = clamp01(
      this._scoreFor ? this._scoreFor(pr) : this._score,
    );
    const reasons = this._reasonsFor
      ? this._reasonsFor(pr)
      : this._reasons.slice();
    return { score, reasons };
  }
}

/**
 * Builds the grading prompt. Pure + exported so it can be unit-tested and
 * reviewed without making any API call.
 *
 * @param {import('./parse.js').NormalizedPR} pr
 * @param {string} contributing - the repo's CONTRIBUTING text (may be "").
 */
export function buildGradingPrompt(pr, contributing) {
  const rules =
    contributing && contributing.trim()
      ? contributing.trim().slice(0, 6000)
      : "(No CONTRIBUTING file found. Grade against general OSS norms: a PR should be focused, address a real need, and not be low-effort AI filler.)";
  const diff = (pr.diff || "").slice(0, 12000);
  return [
    "You are triaging a GitHub pull request for an open-source maintainer.",
    "Decide how likely this PR is low-effort, AI-generated 'slop' that wastes",
    "maintainer time, JUDGED AGAINST THIS REPO'S CONTRIBUTING RULES.",
    "Be conservative: a short but genuine fix is NOT slop. A new contributor is",
    "NOT inherently slop. Penalize generic filler, unrequested sweeping",
    "rewrites, fabricated changes, and ignoring the contributing rules.",
    "",
    "=== CONTRIBUTING RULES ===",
    rules,
    "",
    "=== PULL REQUEST ===",
    `Title: ${pr.title}`,
    `Author: ${pr.author} (type: ${pr.authorType})`,
    `Files changed: ${pr.changedFiles}; +${pr.additions}/-${pr.deletions}; commits: ${pr.commits}`,
    "Body:",
    pr.body || "(empty)",
    "",
    "=== DIFF (truncated) ===",
    diff || "(diff unavailable)",
    "",
    'Respond with ONLY a compact JSON object: {"score": <0..1 float>, "reasons": ["short reason", ...]}.',
    "score = probability this is low-effort AI slop relative to the rules.",
  ].join("\n");
}

/**
 * Real adapter — calls the Anthropic Messages API. NOT used in CI.
 *
 * Limitation (documented in README): requires the operator's ANTHROPIC_API_KEY.
 * Without it the Action runs heuristic-only. This adapter is deliberately thin
 * and is not covered by automated tests because that would require a live key
 * and network; the grading *contract* is covered via FakeGrader.
 */
export class AnthropicGrader {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || "";
    this.model = opts.model || "claude-sonnet-4-5";
    this.maxTokens = opts.maxTokens || 1024;
    this.baseURL = opts.baseURL || "https://api.anthropic.com";
    this._fetch = opts.fetch || globalThis.fetch;
  }

  async grade(pr, ctx = {}) {
    if (!this.apiKey) {
      throw new Error(
        "pr-slop-gate: ANTHROPIC_API_KEY is not set — cannot run the LLM grader. " +
          "Set the `anthropic-api-key` input (or disable grading to run heuristic-only).",
      );
    }
    if (typeof this._fetch !== "function") {
      throw new Error(
        "pr-slop-gate: global fetch unavailable (Node 20+ required for the LLM grader).",
      );
    }
    const prompt = buildGradingPrompt(pr, ctx.contributing || "");
    const res = await this._fetch(`${this.baseURL}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `pr-slop-gate: Anthropic API error ${res.status}: ${detail.slice(0, 300)}`,
      );
    }
    const data = await res.json();
    const text =
      (data &&
        Array.isArray(data.content) &&
        data.content.find((b) => b.type === "text")?.text) ||
      "";
    return parseGraderResponse(text);
  }
}

/**
 * Parse the model's JSON reply defensively. Exported + pure so it is unit-test
 * friendly without any network. Falls back to a neutral score on garbage so a
 * flaky model never hard-fails the Action.
 */
export function parseGraderResponse(text) {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return { score: 0, reasons: [] };
  try {
    const obj = JSON.parse(match[0]);
    return {
      score: clamp01(Number(obj.score)),
      reasons: Array.isArray(obj.reasons)
        ? obj.reasons.map(String).slice(0, 8)
        : [],
    };
  } catch {
    return { score: 0, reasons: [] };
  }
}
