#!/usr/bin/env node
/**
 * run.js — the GitHub Action runner (Node 20+, zero runtime deps).
 *
 * Responsibilities (all the impure stuff lives here, NOT in the library):
 *   1. Read the pull_request event from GITHUB_EVENT_PATH.
 *   2. Optionally enrich it with the file list / diff / CONTRIBUTING /
 *      prior-merged authors via the GitHub REST API.
 *   3. Run the pure `triage()` with either the real AnthropicGrader (if a key
 *      is provided) or a heuristic-only FakeGrader.
 *   4. Apply label / comment / close (unless `dry-run`).
 *   5. Emit GitHub Action outputs.
 *
 * This file intentionally has no automated test (it is I/O glue requiring a
 * live token + network). Every unit of logic it depends on IS tested via the
 * pure modules + FakeGrader.
 */

import { readFileSync, appendFileSync } from "node:fs";
import { triage, safeTriage } from "./triage.js";
import { FakeGrader, AnthropicGrader } from "./grader.js";
import { resolveConfig, parseList } from "./config.js";
import { safeParseEvent } from "./safe.js";
import { getPolicyFile } from "./github.js";
import { buildPrAnalytics } from "./analytics.js";
import {
  listPullFiles,
  getPullDiff,
  derivePriorMergedAuthors,
  getContributing,
  addLabels,
  createComment,
  closePull,
} from "./github.js";

function input(name, def = "") {
  // GitHub Actions exposes inputs as INPUT_<UPPER, spaces→_>.
  const key = `INPUT_${name.toUpperCase().replace(/[ -]/g, "_")}`;
  const v = process.env[key];
  return v === undefined || v === "" ? def : v;
}

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) appendFileSync(f, `${name}=${String(value).replace(/\n/g, " ")}\n`);
  console.log(`pr-slop-gate: ${name}=${value}`);
}

function info(msg) {
  console.log(`pr-slop-gate: ${msg}`);
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    info("GITHUB_EVENT_PATH not set — this Action must run on pull_request. Exiting cleanly.");
    return;
  }
  let eventText = "";
  try {
    eventText = readFileSync(eventPath, "utf8");
  } catch (e) {
    info(`could not read GITHUB_EVENT_PATH (${e.message}); exiting cleanly.`);
    return;
  }
  const { event, error: parseErr } = safeParseEvent(eventText);
  if (parseErr || !event) {
    info(`${parseErr || "event JSON unusable"} — exiting cleanly (host CI unaffected).`);
    return;
  }
  if (!event.pull_request) {
    info("Event is not a pull_request — nothing to do.");
    return;
  }

  const token = input("github-token");
  const anthropicKey = input("anthropic-api-key"); // never logged
  const dryRun = String(input("dry-run", "false")).toLowerCase() === "true";

  const rawInputs = {
    label: input("label"),
    "feedback-label": input("feedback-label"),
    "label-threshold": input("label-threshold"),
    "comment-threshold": input("comment-threshold"),
    "close-threshold": input("close-threshold"),
    "heuristic-weight": input("heuristic-weight"),
    "grader-weight": input("grader-weight"),
    "auto-close": input("auto-close"),
    "disable-grader": input("disable-grader"),
  };

  const [owner, repo] = (event.repository?.full_name || "/").split("/");
  const number = event.pull_request.number;

  // Load the repo's optional `.pr-slop-gate.yml` policy (best-effort; absent /
  // unreadable → built-in defaults). Path overridable via `config-path`.
  let policyText = "";
  if (token && owner && repo) {
    const policyPath = input("config-path", ".pr-slop-gate.yml");
    policyText = await getPolicyFile(token, owner, repo, policyPath).catch(
      () => "",
    );
  }
  const config = resolveConfig(rawInputs, { policyText });
  if (Array.isArray(config.policyWarnings) && config.policyWarnings.length) {
    for (const w of config.policyWarnings.slice(0, 20)) info(w);
  }
  if (config.policyPresent) {
    info(
      `loaded repo policy (.pr-slop-gate.yml)${
        config.policyPack ? ` pack=${config.policyPack}` : ""
      }`,
    );
  }

  // --- enrich (best-effort; degrade gracefully if token is limited) ---
  if (token && owner && repo && number) {
    try {
      event._files = await listPullFiles(token, owner, repo, number);
    } catch (e) {
      info(`could not list PR files (${e.message}); scoring on metadata only`);
    }
    try {
      event._diff = await getPullDiff(token, owner, repo, number);
    } catch {
      /* diff optional */
    }
  }

  let contributing = "";
  if (token && owner && repo) {
    contributing = await getContributing(token, owner, repo).catch(() => "");
  }

  // Trusted set = explicit allowlist + explicit prior-merged input +
  // (optionally) authors auto-derived from merged PRs.
  let priorMergedAuthors = parseList(input("prior-merged-authors"));
  const allowlist = parseList(input("allowlist"));
  if (
    String(input("auto-derive-prior-authors", "true")).toLowerCase() ===
      "true" &&
    token &&
    owner &&
    repo
  ) {
    try {
      const derived = await derivePriorMergedAuthors(token, owner, repo);
      priorMergedAuthors = [...new Set([...priorMergedAuthors, ...derived])];
    } catch (e) {
      info(`could not derive prior-merged authors (${e.message}); using inputs only`);
    }
  }

  // --- grader selection ---
  // Real Anthropic grader ONLY if a key is present and grading is enabled.
  // Otherwise heuristic-only via a zero-weight FakeGrader (documented).
  let grader;
  if (config.weights.grader > 0 && anthropicKey) {
    grader = new AnthropicGrader({
      apiKey: anthropicKey,
      model: input("anthropic-model", "claude-sonnet-4-5"),
    });
    info("LLM grader: Anthropic Claude (enabled)");
  } else {
    grader = new FakeGrader({ score: 0 });
    config.weights = { heuristic: 1, grader: 0 };
    info(
      anthropicKey
        ? "LLM grader disabled by config — running heuristic-only"
        : "no ANTHROPIC_API_KEY provided — running heuristic-only (see README Limitations)",
    );
  }

  // --- triage ---
  // First try with the configured grader. If THAT throws (grader/network
  // hiccup) fall back to a heuristic-only run. The final fallback uses
  // safeTriage so even a pathological payload cannot break the host CI — it
  // degrades to an inert `allow` + diagnostic, never a non-zero exit.
  let result;
  try {
    result = await triage(event, {
      config,
      grader,
      contributing,
      priorMergedAuthors,
      allowlist,
    });
  } catch (e) {
    info(`grader path failed (${e.message}); falling back to heuristic-only`);
    result = await safeTriage(event, {
      config: { ...config, weights: { heuristic: 1, grader: 0 } },
      grader: new FakeGrader({ score: 0 }),
      contributing,
      priorMergedAuthors,
      allowlist,
    });
  }
  if (result && result.degraded) {
    info(`degraded run: ${result.error}`);
  }
  if (result && result.sanitation && result.sanitation.truncated) {
    info(
      `payload sanitized (oversized/binary input bounded): ${JSON.stringify(
        result.sanitation,
      )}`,
    );
  }

  info(
    `PR #${result.number} by ${result.author}: score=${result.score.toFixed(3)} ` +
      `decision=${result.decision}` +
      (result.exemptedBy ? ` (exempt: ${result.exemptedBy})` : ""),
  );

  setOutput("score", result.score.toFixed(4));
  setOutput("decision", result.decision);
  setOutput("label", result.label || "");

  // Structured per-PR analytics — the product surface a hosted tier (or a
  // self-hoster) builds reporting on. Emitted as a one-line JSON Action output
  // and, if `analytics-log` is set, appended to that JSONL file. NO network,
  // NO billing — see analytics.js / README "Hosted tier".
  const analytics = buildPrAnalytics(result, {
    repo: `${owner}/${repo}`,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    dryRun,
    graderMode: result.graderUsed ? "llm" : "heuristic-only",
  });
  setOutput("analytics", JSON.stringify(analytics));
  const analyticsLog = input("analytics-log");
  if (analyticsLog) {
    try {
      appendFileSync(analyticsLog, JSON.stringify(analytics) + "\n", "utf8");
      info(`analytics record appended to ${analyticsLog}`);
    } catch (e) {
      info(`could not write analytics-log (non-fatal): ${e.message}`);
    }
  }

  if (dryRun) {
    info("dry-run=true — not applying any label/comment/close");
    if (result.comment) info(`would comment:\n${result.comment}`);
    return;
  }
  if (!token) {
    info("no github-token — cannot apply actions (dry-run behavior)");
    return;
  }

  try {
    if (result.label) {
      await addLabels(token, owner, repo, number, [result.label]);
      info(`labelled #${number} '${result.label}'`);
    }
    if (result.shouldComment && result.comment) {
      await createComment(token, owner, repo, number, result.comment);
      info(`commented on #${number}`);
    }
    if (result.shouldClose) {
      await closePull(token, owner, repo, number);
      info(`closed #${number}`);
    }
  } catch (e) {
    // Never hard-fail the workflow on an apply error — surface and exit 0.
    info(`apply step error (non-fatal): ${e.message}`);
  }
}

main().catch((e) => {
  // Defensive top-level: log, do not crash the maintainer's pipeline.
  console.log(`pr-slop-gate: unexpected error (non-fatal): ${e.message}`);
});
