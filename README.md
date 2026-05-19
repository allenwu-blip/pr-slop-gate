# pr-slop-gate

**A spam filter for AI-generated pull requests, for open-source maintainers.**

Think of it as the spam filter your inbox has — but for the low-effort,
machine-written code submissions ("pull requests", or PRs) now flooding
open-source projects. When someone opens a PR, pr-slop-gate looks at it, scores
how likely it is to be throwaway AI output, and — only above limits you set —
quietly labels it, posts a polite comment, or (if you opt in) closes it. People
who've contributed real work before are skipped entirely, so first-time
contributors with honest patches don't get caught in the net.

It runs as a GitHub Action (a script GitHub runs automatically on each PR). You
tune it with one optional settings file checked into your repo
(`.pr-slop-gate.yml`).

> The basic version needs **zero setup and no paid API key**. There's an
> optional second opinion from an AI model — that one is off by default and
> needs your own Anthropic key (see **Limitations**).

## Why this exists

Open-source maintainers are drowning in PRs that an AI wrote in seconds and
nobody really checked. Public reporting puts the volume at roughly **4 million
a month in Sep 2025, rising to ~17 million a month by Mar 2026, with only
about 1 in 10 being genuine** (these are figures from the sources below —
pr-slop-gate does not measure this itself):

- Maintainer write-up on the AI-PR wave:
  https://www.danilchenko.dev/posts/2026-04-11-github-ai-agents-pull-requests/
- GitHub considering a "kill switch", no committed native fix, points
  maintainers to third-party tooling:
  https://www.theregister.com/2026/02/03/github_kill_switch_pull_requests_ai/

The existing tools on the GitHub Marketplace are old fixed-keyword spam lists
that don't look for AI-written code at all — e.g. the Spamtoberfest checker is
a fixed-pattern spam list:
https://github.com/marketplace/actions/spamtoberfest-pull-request-spam-checker

`pr-slop-gate` goes after the actual 2026 problem: low-effort,
machine-generated PRs, judged against *your* project's contribution rules,
with protection for genuine newcomers built in.

## Quick start

Create `.github/workflows/pr-slop-gate.yml` (full example:
[`examples/pr-slop-gate.yml`](examples/pr-slop-gate.yml)):

```yaml
name: PR Slop Gate
on:
  pull_request_target:
    types: [opened, reopened, synchronize, edited]
permissions:
  pull-requests: write
  contents: read
jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: allenwu-blip/pr-slop-gate@v0     # pin to a tag/SHA once published
        with:
          dry-run: "true"                 # START SAFE — observe, then flip off
          # anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}  # optional LLM grader
```

**Recommended rollout:** ship with `dry-run: "true"` first. The Action logs
the score + decision + the comment it *would* post, but changes nothing. After
a review cycle you trust, set `dry-run: "false"`. Consider `auto-close: "true"`
only later — it is **off by default** on purpose.

Also create a label named **`pr-slop-gate-feedback`** once (used as the
one-click misfire-report channel; see [FEEDBACK.md](FEEDBACK.md)).

## Repo policy file — `.pr-slop-gate.yml`

Drop a `.pr-slop-gate.yml` in your repo root (or `.github/`) to tune the gate
per-repo without editing the workflow. **Every key is optional**; with no file
the conservative built-in defaults apply. Full annotated sample:
[`examples/.pr-slop-gate.yml`](examples/.pr-slop-gate.yml).

```yaml
version: 1
policy-pack: oss-strict        # optional named preset (see below)
thresholds: { label: 0.5, comment: 0.65, close: 0.85 }
weights:    { heuristic: 0.6, grader: 0.4 }
rules:      { churn: 0 }       # per-signal multiplier 0..2 (0 disables)
allowlist:  [ dependabot[bot] ]
exempt-paths: [ "docs/**", "*.md" ]
auto-close: false
```

- Parsed by a **tiny, dependency-free YAML subset parser** (no anchors/tags/
  flow-collections — auditable and bounded by design).
- **A bad value never tightens the gate.** Invalid/unknown keys are ignored
  with a warning in the Action log; misordered thresholds are auto-repaired so
  the gate is never *more* aggressive than you wrote.
- **Precedence:** built-in defaults `<` policy-pack `<` keys you set `<` Action
  inputs (an explicit per-workflow input always wins).

### Policy packs

Opinionated presets you opt into by name via `policy-pack:`:

| Pack | For |
|---|---|
| `oss-default` | Balanced defaults made explicit. |
| `oss-strict` | Repos hit hard by drive-by AI PRs (lower bands, amplified body/scaffold/commit signals). **Still never auto-closes.** |
| `oss-lenient` | High first-time-contributor volume; minimises false positives. |
| `docs-heavy` | Docs/content repos; tolerates large doc churn, exempts doc paths. |

An **unknown** pack name is ignored with a clear warning and changes nothing —
custom/managed pack resolution is a hosted-tier concern, not in the free
Action.

## How scoring works

```
score = heuristic-weight * heuristicScore  +  grader-weight * graderScore   (clamped 0..1)
```

**The rule-based score (no network, same answer every time).** Nine
independent, separately tested signals. Each one, if it fires, carries a
plain-English *why-it-fired* note that shows up in the posted comment:

| Signal | Fires on |
|---|---|
| `aiBoilerplate` | AI-assistant boilerplate / generic filler phrasing |
| `sprawl` | sprawling diff across many unrelated files / very large |
| `churn` | no-op or whitespace-only churn (adds≈deletes / reflow-only) |
| `lowEffortBody` | missing/low-effort description, no linked issue or specifics |
| `title` | vague generic title (e.g. just "Update") |
| `templateBody` | a section scaffold (Summary/Changes/Testing) left **hollow** |
| `commitQuality` | every commit message is uninformative ("update", "wip") |
| `intentMismatch` | body promises a concrete code fix the diff does **not** contain |
| `massRename` | many pure file renames/moves with little/no content change |

None key off *"is the author new"* — newness is never a penalty. Weights are
deliberately timid so **no single signal can condemn a PR** (anti-cry-wolf); a
small, capped *corroboration* bonus applies only when ≥3 independent signals
fire together. A genuinely filled-in PR template, a focused first-time fix, and
a well-described change all score **0** on the bundled fixtures.

**The AI second opinion (optional).** This sends the PR plus your project's
contribution guide (your `CONTRIBUTING` file) to an LLM (a large language
model — the kind of AI behind chat assistants), specifically Anthropic Claude,
and asks it how likely the PR is throwaway, with reasons. If you don't supply a
key, this part is switched off entirely and the Action runs on the rule-based
score alone — still works, just less sharp on the deliberately-subtle fakes.

**Decision thresholds:** `allow` → `label` → `label + comment` →
`label + comment + close` (close only if `auto-close: true`).

## False-positive safety (the important part)

A blocklist that punishes new contributors is worse than nothing. This Action:

- **Exempts trusted contributors entirely.** Trusted = already had a PR merged
  into this repo (auto-derived) **or** in your `allowlist` / `trusted-authors`.
  Any decision for a trusted author is downgraded to `allow`.
- **Does not penalize being new.** The heuristics are tuned so a small,
  well-formed first contribution scores low *on merit* (verified by a genuine
  first-time-contributor fixture and a properly-filled-template fixture, both
  scoring 0).
- **Is non-destructive by default.** `auto-close` is off; no built-in pack
  enables it; the default action on a flagged PR is a label + a courteous,
  non-accusatory comment that tells both sides how to appeal.
- **Never hard-fails your CI.** Malformed event JSON, multi-megabyte diffs,
  binary blobs, invalid UTF-8, or millions of files are all bounded and
  degrade to a safe `allow` + a diagnostic; grader/network/apply errors
  fall back to heuristic-only or a no-op. The Action always exits 0.

## Analytics output (self-host the data; hosting is a separate tier)

Every run emits a stable one-line JSON **`analytics`** output (score, fired
signals, decision, provenance). Set `analytics-log` to append a JSONL record
per PR. `src/analytics.js` also provides `aggregateReport()` / `formatReport()`
to roll many records into an org-level digest.

This is the *product surface*; a hosted tier only adds **storage + retention +
a UI + premium policy packs** on top of this exact data. **No billing,
accounts, Merchant-of-Record, or network calls live in this OSS Action** — the
hosted-tier seam is marked explicitly in `src/analytics.js`
(`hostedExportStub`) and `src/policypack.js`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `github-token` | `${{ github.token }}` | Read PR files / label / comment / close. |
| `anthropic-api-key` | `""` | Optional. Enables the LLM grader. **Anthropic only — OpenAI is not supported.** Pass via a secret. |
| `anthropic-model` | `claude-sonnet-4-5` | Model id for the grader. |
| `disable-grader` | `false` | Force heuristic-only even if a key is set. |
| `config-path` | `.pr-slop-gate.yml` | Path to the repo policy file (a `.github/` fallback is also tried). |
| `allowlist` | `""` | Comma/newline logins always exempt (merged with policy). |
| `prior-merged-authors` | `""` | Extra logins to treat as trusted. |
| `auto-derive-prior-authors` | `true` | Auto-derive trusted authors from merged PRs. |
| `label` | `possible-ai-slop` | Label applied to flagged PRs. |
| `feedback-label` | `pr-slop-gate-feedback` | Misfire-report label referenced in comments. |
| `label-threshold` | `0.5` | Score ≥ this → label. |
| `comment-threshold` | `0.65` | Score ≥ this → label + comment. |
| `close-threshold` | `0.85` | Score ≥ this → label + comment + close (needs `auto-close`). |
| `heuristic-weight` | `0.6` | Weight of heuristics in the blend. |
| `grader-weight` | `0.4` | Weight of the LLM grader (forced `0` with no key). |
| `auto-close` | `false` | Auto-close PRs at/above `close-threshold`. |
| `analytics-log` | `""` | Optional path to append per-PR analytics JSONL. |
| `dry-run` | `false` | Compute + log only; change nothing. **Use for first rollout.** |

Action inputs override any `.pr-slop-gate.yml` value.

## Outputs

| Output | Description |
|---|---|
| `score` | Blended score in `[0,1]` (4 dp). |
| `decision` | `allow` \| `label` \| `comment` \| `close`. |
| `label` | Label applied (empty if none). |
| `analytics` | One-line JSON per-PR analytics record (stable schema). |

## Screenshots

_Placeholder — screenshots of a flagged PR comment and the Action log will be
added from a real install before the Marketplace listing. They are
intentionally omitted now rather than mocked up, so nothing here is
misleading._

## Limitations (read this)

- **The AI second opinion needs *your own* Anthropic API key.** There is no
  shared or hosted key. Without one, the Action runs on the rule-based score
  only — fully working, but less sharp on borderline or deliberately-subtle
  PRs (for example, a fake "fixes the failing test" whose actual code change is
  only whitespace is exactly the kind of case the AI part catches best; the
  rules give it a real but cautious nudge that stays below the line). This is
  by design; the run log states which mode ran.
- **The real Anthropic connection is not exercised in our automated tests.**
  Testing it for real would need a live key and network access. The grading
  *behavior* is covered by tests using a stand-in fake; the real connector
  (`src/grader.js` `AnthropicGrader`) is a thin, documented HTTP call to the
  Anthropic Messages API.
- **No accuracy number or benchmark is claimed.** The signals are checked
  against hand-written example PRs (clear slop / legit / genuine first-timer /
  filled-in template / empty scaffold / rename / mismatched intent), **not** a
  large labeled dataset. Treat the score as a triage hint, not a verdict —
  exactly how the posted comment frames it. Start in `dry-run` and tune the
  thresholds (or pick a policy pack) for your repo.
- **The YAML policy parser is a deliberate subset.** It supports scalars,
  nested maps, scalar lists, quoted strings and comments — *not* anchors,
  tags, flow collections, multi-line block scalars, or lists-of-maps. The
  policy schema never needs them; unsupported syntax is warned about and
  ignored, never fatal.
- **`pull_request_target` caveat.** It gives the token write access for forks
  (needed to label/comment). It does **not** check out untrusted PR code —
  this Action only reads PR *metadata/diff* via the API, never executes it.
- **Heuristics are English-leaning.** Boilerplate/template detection is tuned
  for English PR text today.
- **No hosted dashboard / retention / billing in this Action.** The analytics
  *data + local aggregation* are here; hosting, retention, accounts, billing
  (Merchant-of-Record), and premium/managed policy packs are a separate
  operator-run tier and intentionally out of scope. The seam is marked in code.

## Development

```bash
npm ci
npm test        # vitest — no network, no API key required
```

The scoring/policy core (`src/parse.js`, `heuristics.js`, `decide.js`,
`template.js`, `triage.js`, `config.js`, `policy.js`, `yaml.js`,
`policypack.js`, `analytics.js`, `safe.js`, `feedback.js`) is pure and
dependency-free. All network I/O is isolated in `src/run.js` + `src/github.js`
(the Action runner), which are not unit-tested because they are live-API glue;
every piece of logic they call is tested independently. The suite asserts its
own no-network/no-key guarantee and includes adversarial-input hardening tests.

## Feedback

Misfires are the most useful signal — see [FEEDBACK.md](FEEDBACK.md). Reports
are stored and read **verbatim** (no summarization).

## License

MIT — see [LICENSE](LICENSE).
