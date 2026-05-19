# LAUNCH — pr-slop-gate

**DRAFT — operator reviews and posts. Public technical claims are yours to send.**
All claims below are drawn from the reviewed README only. Do not add benchmarks,
accuracy numbers, or volume figures not already cited there before posting.

---

## Show HN title

```
Show HN: pr-slop-gate – GitHub Action that scores PRs for AI slop, exempts trusted contributors
```

## Show HN body

```
pr-slop-gate is a spam filter for AI-generated pull requests. It targets the
current wave of low-effort, machine-written PRs hitting open-source maintainers.

How it works: when a PR is opened, it runs a set of rule-based quality checks
(AI boilerplate phrasing, sprawling diffs, no-effort descriptions, vague
titles) and — optionally — asks an AI model to grade the PR against your own
CONTRIBUTING rules. It labels, comments politely, and optionally closes, but
only above limits you configure.

The false-positive safety is the design priority. Any author who
already had a PR merged into the repo is automatically trusted and the decision
is downgraded to allow. A small, well-formed first contribution should score
low on merit without needing that exemption — that's validated in the test suite
with a genuine first-timer fixture. auto-close is off by default; you start in
dry-run, watch the logs for a cycle, and flip it off when you trust it.

Heuristics-only mode requires zero config and no API key. The LLM grader
(optional, Anthropic-only) is opt-in via your own key. No shared/hosted key.

Action runs on ubuntu-latest, Node 20, 57 tests green from a clean install.
Never hard-fails your CI — grader/network errors degrade to heuristic-only
and exit 0. MIT license.

GitHub: [link]
Quick start (copy into .github/workflows/): [link to examples/]
```

---

## One-paragraph repo description

```
pr-slop-gate is a GitHub Action that scores pull requests for AI-generated slop
using deterministic diff-quality heuristics and an optional LLM grade against your
own CONTRIBUTING rules. It auto-labels, posts a polite templated comment, and
(optionally) closes flagged PRs — while automatically exempting trusted contributors
so genuine first-timers are not caught. Heuristic-only mode needs zero configuration
and no API key; the LLM grader is opt-in and requires your own Anthropic key.
auto-close is off by default. MIT license.
```

---

## What it is / honest limitations blurb
(For the Marketplace listing description, a pinned comment, or a README TL;DR)

```
pr-slop-gate flags low-effort, AI-generated PRs using diff-quality heuristics
(no API key required) plus an optional LLM grade against your repo's own rules.
No accuracy numbers are claimed — there is no published labeled corpus; treat
scores as a triage signal and tune thresholds for your repo. The LLM grader
requires your own Anthropic key; without it the Action runs heuristic-only and
still works. Start with dry-run: true and read the logs before enabling comments
or close.
```

---

## Notes for operator before posting

- Replace `[link]` placeholders with the real repo and examples URLs once the
  repo is public.
- The Show HN body is written in faceless/product voice. If you prefer a
  personal voice as the person posting, prefix with "I built" or similar.
- Do not add benchmark numbers, precision/recall figures, or detection-rate
  claims — the README explicitly does not claim any, and adding them here would
  be an unsubstantiated assertion.
- The external volume figures (4M/month → 17M/month) are in the README with
  source links. You may reference them in discussion replies with the same
  attribution, not as claims this tool measures.
- Screenshots: the README notes they are intentionally omitted until available
  from a real install. Add them before the Marketplace listing if possible — a
  real Action-log screenshot and a sample comment screenshot are the two most
  useful visuals.
