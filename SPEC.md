# pr-slop-gate — MVP spec

AI-aware pull-request triage GitHub Action for OSS maintainers.

## Problem (evidence-grounded, see README)
AI-generated PRs scaled 4M (Sep 2025) → 17M/mo (Mar 2026), ~1 in 10 legitimate.
Existing marketplace actions are stale heuristic blocklists with zero AI-slop
coverage. GitHub has no committed native fix and tells maintainers to use
third-party tools.

## What it does (MVP)
On a `pull_request` event the Action:
1. Reads the PR diff + metadata from the GitHub event JSON (path or dict — no
   live network required for the scoring core or for tests).
2. Computes a **slop score** in `[0,1]` from two signals:
   - `heuristicScore` — pure diff-quality heuristics (no network, deterministic).
   - `graderScore` — an LLM grade against the repo's CONTRIBUTING rules, via a
     `Grader` interface. CI uses a **FakeGrader**. The real adapter calls
     Anthropic Claude with `ANTHROPIC_API_KEY` (never OpenAI, never hardcoded);
     it is a thin documented adapter, not exercised in CI.
   - Combined: `score = wH*heuristic + wG*grader` (weights configurable;
     grader weight 0 if grading disabled → heuristic-only still works).
3. Decides an **action** from configurable thresholds:
   - `score >= closeThreshold` → label + comment + (optional) auto-close
   - `score >= commentThreshold` → label + comment
   - `score >= labelThreshold` → label only
   - else → no-op (`allow`)
4. **Trusted-contributor exemption** (false-positive safety): if the PR author
   is in `priorMergedAuthors` (maintainer-supplied list of logins who already
   had a PR merged) OR in the explicit `allowlist` input, the decision is
   downgraded to `allow` regardless of score. This is the "skip first-time
   false positives the smart way" rule: a brand-new contributor is NOT
   auto-exempt, but a previously-merged author or an allowlisted login is.
5. Emits a **polite, faceless, templated** comment (no persona) and outputs
   machine-readable results (`score`, `decision`, `label`) for the workflow.

## Depth added beyond MVP (v0.1, all TDD'd, pure, no network)
1. **Repo policy file `.pr-slop-gate.yml`** — `src/yaml.js` (tiny safe YAML
   *subset* parser, zero deps, bounded, never throws) + `src/policy.js`
   (validate → normalize; bad values warn + fall back, never tighten the gate;
   misordered thresholds auto-repaired). Layered in `config.js`:
   defaults < pack < repo-policy keys < Action inputs. Keys: thresholds,
   weights, per-signal `rules` multipliers [0..2], allowlist, trusted-authors,
   exempt-paths (glob subset), auto-close, routing, policy-pack.
2. **Richer detection** — `heuristics.js` extended from 5 → 9 pure signals:
   added `templateBody` (hollow AI scaffold), `commitQuality` (uninformative
   commits), `intentMismatch` (body claims a code fix the diff lacks),
   `massRename` (no-op rename churn). Each emits a why-it-fired provenance
   string surfaced in the comment. Conservative: timid weights + a capped
   corroboration bonus only when ≥3 independent signals fire; genuine
   first-timer / filled-template / focused-fix fixtures score 0.
3. **Paid-tier product surface (scaffold only, NO money/accounts/network)** —
   `src/analytics.js`: per-PR structured record + `aggregateReport()` /
   `formatReport()` org rollup; `src/policypack.js`: named built-in packs +
   unknown-pack = explicit hosted-tier seam. Boundaries marked
   `// PAID TIER (operator wires later)` (`hostedExportStub`, policypack).
4. **Hardening** — `src/safe.js`: `safeParseEvent` (never-throw JSON),
   `looksBinary`, `sanitizePr` (cap diff/body/file-count, drop binary/non-UTF8
   patches, deterministic), `safeAllowResult`; `triage` sanitizes before
   scoring; `safeTriage` converts ANY throw into an inert `allow`; `run.js`
   always exits 0.

## Non-goals (stated honestly in README "Limitations")
- No hosted dashboard / retention / billing (operator wires MoR separately).
  The analytics *data + local aggregation* are in-product; hosting is not.
- The real LLM grader requires the operator's `ANTHROPIC_API_KEY`; without it
  the Action runs heuristic-only (documented, not hidden).
- The YAML parser is a deliberate subset (no anchors/tags/flow/block-scalars/
  lists-of-maps); unsupported syntax warns + is ignored, never fatal.
- Auto-derivation of `priorMergedAuthors` from the GitHub API is provided as an
  optional live helper in the runner, but the scoring/decision core takes the
  list as data so it is fully testable offline.

## Public library API (testable, pure where possible)
- `scoreHeuristics(pr, { exemptPaths, ruleWeights }) -> { score, signals,
  provenance }` — pure, deterministic, 9 signals + corroboration bonus.
- `interface Grader { grade(pr, { contributing }) -> Promise<{score, reasons}> }`
- `FakeGrader` — deterministic, configurable, used in all tests.
- `AnthropicGrader` — real adapter (env key), documented, not in CI.
- `combineScores({ heuristicScore, graderScore, weights })  -> number`
- `decide({ score, author, config, trusted }) -> { decision, label, ... }`
- `isTrusted(author, { priorMergedAuthors, allowlist }) -> boolean`
- `renderComment(decision, ctx) -> string` — polite templated text.
- `triage(pr, opts) -> Result` / `safeTriage(pr, opts)` — orchestrator, pure
  given an injected grader (no network); safeTriage never throws.
- `parse(text) -> { value, errors }` (yaml.js) — safe YAML-subset parser.
- `resolvePolicy(text) -> Policy` / `makeExemptMatcher(patterns)` (policy.js).
- `resolveConfig(inputs, { policyText }) -> config` (config.js) — layered.
- `BUILTIN_PACKS` / `resolvePolicyPack(name)` / `composePolicyWithPack`
  (policypack.js) — named packs; unknown = explicit paid-tier seam.
- `buildPrAnalytics(result, meta)` / `aggregateReport(records)` /
  `formatReport(report)` / `hostedExportStub()` (analytics.js).
- `safeParseEvent(text)` / `looksBinary(s)` / `sanitizePr(pr)` /
  `safeAllowResult(reason, extra)` (safe.js) — hardening.

## Action interface (`action.yml`, Node20)
Inputs: `github-token`, `anthropic-api-key` (optional), `config-path`,
`allowlist`, `prior-merged-authors`, `auto-derive-prior-authors`,
thresholds + weights overrides, `analytics-log`, `dry-run`.
Outputs: `score`, `decision`, `label`, `analytics`.
Runner: reads `GITHUB_EVENT_PATH`, builds the `pr` object, runs `triage`,
then (unless `dry-run`) applies label/comment/close via the GitHub REST API
using `github-token`. All network calls are in the runner only and guarded;
the library never does I/O.

## Feedback hook (verbatim collector — mirrors the operation pattern)
- A documented `pr-slop-gate-feedback` issue label.
- `.github/ISSUE_TEMPLATE/slop-gate-misfire.yml` structured template.
- `FEEDBACK.md` documenting the one-line low-friction misfire report and the
  verbatim-capture guarantee (no transformation, mirroring `foundry/collect`).

## Test plan (TDD, no network, no key)
Fixtures (GitHub `pull_request` event shape): `clearly-slop`, `legit`,
`first-time-legit`, plus deepening fixtures `template-scaffold-slop`,
`intent-mismatch-slop`, `mass-rename-slop`, `filled-template-legit`. Tests
cover: heuristic scorer ordering + the 4 new signals + provenance +
corroboration + conservatism (legit fixtures must score 0), combine math,
decision thresholds, trusted exemption, templated comment content, end-to-end
triage with FakeGrader, the YAML-subset parser, policy validation +
layering precedence + threshold repair + the shipped example parsing with
zero warnings, policy packs + the unknown-pack paid-tier seam, analytics
record/aggregate/format determinism, and adversarial hardening (malformed
JSON, huge diffs, binary/non-UTF8 patches, bogus events — triage/safeTriage
never throw). `npm test` (vitest). Zero deps that require network. The suite
asserts its own no-network/no-key guarantee.
