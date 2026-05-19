/**
 * template.js — polite, faceless, professional comment text. No persona, no
 * first person ("I/me/my"), no signature/sign-off. Deterministic.
 *
 * Tone goals:
 *  - thank the contributor (assume good faith — many flagged PRs are humans)
 *  - state plainly this is an AUTOMATED triage signal, not a verdict
 *  - never call a person "spam"
 *  - always give a clear, low-friction appeal path (the feedback label)
 *  - surface the concrete reasons so the decision is transparent
 */

function reasonsBlock(reasons) {
  const list = Array.isArray(reasons) ? reasons.filter(Boolean) : [];
  if (!list.length) return "";
  return (
    "\n\nAutomated signals that triggered this:\n" +
    list.map((r) => `- ${r}`).join("\n")
  );
}

/**
 * @param {{decision:string, shouldClose:boolean}} d
 * @param {{prNumber:number, score:number, label:string, repo:string, reasons:string[], feedbackLabel:string}} ctx
 * @returns {string}
 */
export function renderComment(d, ctx) {
  const feedbackLabel = ctx.feedbackLabel || "pr-slop-gate-feedback";
  const appeal =
    `\n\nIf this was flagged in error, a maintainer can remove the ` +
    `\`${ctx.label || "possible-ai-slop"}\` label, and either side can open a ` +
    `quick report by adding the \`${feedbackLabel}\` label or filing a ` +
    `"slop-gate misfire" issue. False positives help tune the gate, so please ` +
    `do report them — that feedback is read exactly as written.`;

  const transparency = reasonsBlock(ctx.reasons);

  if (d.shouldClose) {
    return (
      `Thanks for the contribution. This pull request has been ` +
      `**automatically closed** by an AI-slop triage check because it strongly ` +
      `resembles low-effort or machine-generated content for this repository. ` +
      `This is an automated heuristic, not a final judgment about the ` +
      `contributor.` +
      transparency +
      `\n\nIf this is a genuine change, please reopen it (or comment to ask a ` +
      `maintainer to) with a short note describing the problem it solves and ` +
      `how it was tested.` +
      appeal
    ).trim();
  }

  // label-only never posts a comment (handled by the caller); this covers the
  // "comment" decision.
  return (
    `Thanks for opening this pull request. An automated AI-slop triage check ` +
    `has flagged it for **maintainer review** because some signals resemble ` +
    `low-effort or machine-generated content relative to this project's ` +
    `contributing guidelines. This is only an automated signal — a maintainer ` +
    `makes the final call.` +
    transparency +
    `\n\nTo help a maintainer review quickly, please make sure the description ` +
    `explains the concrete problem this solves, links any related issue, and ` +
    `notes how the change was tested.` +
    appeal
  ).trim();
}
