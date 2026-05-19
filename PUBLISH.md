# PUBLISH — pr-slop-gate (Allen-only owner gates)

Built & independently reviewed: real Node20 GitHub Action, 57 tests green, heuristic mode needs zero key/config, degrades safely (never breaks a maintainer's CI), non-destructive default (`auto-close:false`). **AI never does the steps below — they are identity/money/publish, only you.**

## Gate 1 — Publish the free Action (drives stars/adoption; $0 cost)
1. Create a **public GitHub repo** under your account/org (e.g. `<owner>/pr-slop-gate`).
2. In `products/pr-slop-gate/package.json`: set `"private": false`.
3. Replace the `<OWNER>` placeholder in `README.md` + `examples/` with your real GitHub owner handle.
4. Push the `products/pr-slop-gate/` contents to that repo root; tag a release (`v0` + a SHA-pinned tag); enable **GitHub Marketplace** listing for the Action.
5. Create a label **`pr-slop-gate-feedback`** in that repo (the feedback hook + issue template reference it — this is the primary channel where real user reports come in, stored word-for-word, for this bet).
6. (Optional, only if you want the AI second-opinion grader live) add repo/org secret `ANTHROPIC_API_KEY`. Without it the Action runs on the rule-based score only, by design — still fully functional.

→ After this, a real maintainer can `uses: <owner>/pr-slop-gate@v0`. **This is the real signal start** — installs/stars/feedback begin flowing to the kill-threshold (`<5 stranger orgs installing within first review cycle` → else default-KILL at your next RATIFY).

## Gate 2 — payment account (only if/when monetizing; the revenue gate)
The free Action collects $0 by design. A paid hosted tier (org dashboard / higher-rate grading / analytics) needs a **merchant-of-record account in your name** (MoR — a service like Paddle / Lemon Squeezy / Polar that sells on your behalf and handles tax). No payment code exists in the product yet — that's a deliberate later layer. **Until this account exists, no bet in the whole operation can collect a cent** (no money-making kill-threshold can even be scored). This is *the* binding constraint on getting to revenue fast — independent of how many products get built.

## Budget note (spec §8 / DR-3)
The free Action = no hosting/domain cost. A paid hosted tier or any deploy = real spend; single >¥500 or per-bet cumulative >¥2k must be ratified by you before spend.

## What stays automated (not you)
Building #2…#10, their tests/reviews, build-logs, feedback collection, the RATIFY packets, kill-threshold tracking — all AI, feedback-paced. You: the gates above + reading raw RATIFY + pressing KILL/SCALE.
