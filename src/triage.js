/**
 * triage.js — the orchestrator. Pure given an injected grader: it performs NO
 * network or file I/O itself. The runner injects either a real AnthropicGrader
 * (operator's key) or a FakeGrader (tests / heuristic-only).
 */

import { parsePullRequestEvent } from "./parse.js";
import { scoreHeuristics } from "./heuristics.js";
import { combineScores, decide, isTrusted, DEFAULT_CONFIG } from "./decide.js";
import { renderComment } from "./template.js";
import { sanitizePr, safeAllowResult } from "./safe.js";

/**
 * @param {object} event - parsed GitHub pull_request event payload (a dict).
 * @param {{
 *   config?: object,
 *   grader: { grade: (pr:object, ctx:object)=>Promise<{score:number,reasons:string[]}> },
 *   contributing?: string,
 *   priorMergedAuthors?: string[],
 *   allowlist?: string[],
 * }} opts
 * @returns {Promise<{
 *   number:number, author:string, score:number, heuristicScore:number,
 *   graderScore:number, graderUsed:boolean, decision:string, label:string|null,
 *   shouldComment:boolean, shouldClose:boolean, exemptedBy:string|null,
 *   comment:string|null, reasons:string[], signals:Record<string,number>
 * }>}
 */
export async function triage(event, opts) {
  const config = { ...DEFAULT_CONFIG, ...(opts.config || {}) };
  // parse → SANITIZE (cap huge diffs, drop binary/non-UTF8 patches, bound file
  // count) so scoring is deterministic and bounded on hostile/giant payloads.
  const parsed = parsePullRequestEvent(event);
  const { pr, sanitation } = sanitizePr(parsed);

  const h = scoreHeuristics(pr, {
    exemptPaths: config.exemptPaths || [],
    ruleWeights: config.ruleWeights || {},
  });

  const graderWeight =
    config.weights?.grader ?? DEFAULT_CONFIG.weights.grader;
  const graderEnabled = graderWeight > 0 && !!opts.grader;

  let graderScore = 0;
  let graderReasons = [];
  if (graderEnabled) {
    const g = await opts.grader.grade(pr, {
      contributing: opts.contributing || "",
    });
    graderScore = g.score;
    graderReasons = Array.isArray(g.reasons) ? g.reasons : [];
  }

  const score = combineScores({
    heuristicScore: h.score,
    graderScore,
    weights: config.weights,
  });

  const trusted = isTrusted(pr.author, {
    priorMergedAuthors: opts.priorMergedAuthors || [],
    allowlist: opts.allowlist || [],
  });

  const d = decide({ score, author: pr.author, config, trusted });

  // Human-readable reasons: top heuristic signals (with provenance) + grader
  // bullets. Provenance text comes straight from the scorer so the comment
  // explains exactly *why* each signal fired.
  const heuristicReasons = (h.provenance || []).map((p) => p.why);
  const reasons = d.exemptedBy
    ? []
    : [...heuristicReasons, ...graderReasons].slice(0, 8);

  const comment = d.shouldComment
    ? renderComment(d, {
        prNumber: pr.number,
        score,
        label: config.label,
        repo: pr.baseRepo,
        reasons,
        feedbackLabel: config.feedbackLabel,
      })
    : null;

  return {
    number: pr.number,
    author: pr.author,
    score,
    heuristicScore: h.score,
    graderScore,
    graderUsed: graderEnabled,
    decision: d.decision,
    label: d.label,
    shouldComment: d.shouldComment,
    shouldClose: d.shouldClose,
    exemptedBy: d.exemptedBy,
    comment,
    reasons,
    signals: h.signals,
    provenance: h.provenance || [],
    sanitation,
  };
}

/**
 * safeTriage — the never-throws entrypoint the runner should use. Guarantees
 * pr-slop-gate cannot break the host CI: ANY error (bad event shape, grader
 * blow-up, unexpected exception) is caught and converted into a deterministic,
 * inert `allow` result carrying a diagnostic. It never rejects.
 *
 * Same signature/return as `triage`, plus `error`/`degraded` on the failure
 * path (so the runner can log it and still exit 0).
 *
 * @param {object} event
 * @param {object} opts
 * @returns {Promise<object>}
 */
export async function safeTriage(event, opts = {}) {
  try {
    return await triage(event, opts);
  } catch (e) {
    const num =
      event && event.pull_request && Number(event.pull_request.number);
    const author =
      (event &&
        event.pull_request &&
        event.pull_request.user &&
        event.pull_request.user.login) ||
      "";
    return safeAllowResult(
      `triage failed, defaulting to allow (host CI unaffected): ${
        e && e.message ? e.message : e
      }`,
      { number: Number.isFinite(num) ? num : 0, author },
    );
  }
}
