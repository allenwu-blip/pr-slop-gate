# Reporting a misfire

`pr-slop-gate` will sometimes get it wrong — a legitimate PR flagged (false
positive) or obvious slop missed (false negative). Reporting misfires is the
single most useful thing you can do to make it better.

## The one-line, zero-friction way

**Add the `pr-slop-gate-feedback` label** to the affected pull request or
issue. That's it. (Maintainers adopting the Action: create that label once;
the Action references it in every comment it posts so contributors know the
appeal path.)

## The structured way

Open a **"Slop-gate misfire report"** issue
(`.github/ISSUE_TEMPLATE/slop-gate-misfire.yml`). It asks for the misfire type,
the PR link, and what happened in your own words.

## The verbatim guarantee

Whatever you write is **captured and read exactly as written** — no
summarization, no paraphrasing, no "cleaning up". Tuning a slop detector on
second-hand paraphrases corrupts the signal, so the raw text is the artifact.
This mirrors the same verbatim-at-capture contract implemented in
[`src/feedback.js`](src/feedback.js) (and tested in
`test/feedback.test.js`): append-only, order-preserving, and a single corrupt
record never drops the rest.

## What helps most

- The PR link and the comment the Action posted.
- Your blunt opinion on *why* it was wrong.
- Your config if non-default (thresholds, weights, whether the LLM grader was
  enabled, version).
