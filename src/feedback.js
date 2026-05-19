/**
 * feedback.js — verbatim misfire-feedback collector.
 *
 * Mirrors the operation's reusable feedback pattern (foundry/collect): a
 * maintainer's report of a false positive / false negative is stored EXACTLY
 * as written — no strip, no normalize, no summarization, no transformation.
 * That raw-at-capture guarantee is the whole point: tuning a slop gate on
 * paraphrased complaints corrupts the signal.
 *
 * This is intentionally tiny and dependency-free. The free Action's primary
 * feedback channel is the `pr-slop-gate-feedback` label + the issue template
 * (see FEEDBACK.md); this module is the same contract in code for local logs
 * and the future hosted tier.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * Append one verbatim feedback record as a single JSON line.
 * `text` is written EXACTLY as given (no .trim(), no normalization).
 *
 * @param {string} sink - path to the .jsonl feedback log.
 * @param {{source:string, text:string, extra?:object}} rec
 */
export function captureFeedback(sink, { source, text, extra }) {
  const record = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    product: "pr-slop-gate",
    source,
    text, // verbatim — do not transform
    extra: extra || {},
  };
  appendFileSync(sink, JSON.stringify(record) + "\n", "utf8");
}

/**
 * Read back grouped-by-source records, preserving order and exact text. A
 * single corrupt line is skipped — it never aborts the read (same resilience
 * as the operation's collector).
 *
 * @param {string} sink
 * @returns {Record<string, Array<object>>}
 */
export function loadFeedback(sink) {
  /** @type {Record<string, Array<object>>} */
  const out = {};
  if (!existsSync(sink)) return out;
  const raw = readFileSync(sink, "utf8");
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip one corrupt record; never abort
    }
    const key = rec.source || "unknown";
    (out[key] ||= []).push(rec);
  }
  return out;
}
