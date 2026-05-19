/**
 * heuristics.js — pure, deterministic, network-free diff-quality scoring.
 *
 * Returns a slop-likelihood score in [0,1] plus a per-signal breakdown so the
 * decision is transparent and the comment can explain itself. NONE of these
 * signals key off "is the author new" — newness is handled (or not) by the
 * exemption layer, never penalized here. That keeps genuine first-time
 * contributors safe on merit.
 *
 * Each signal is a number in [0,1]; the final score is a capped weighted sum.
 * Weights are intentionally conservative: a single weak signal should not flag
 * a PR; it takes either one strong tell or several mild ones.
 */

// Phrases that very strongly indicate an LLM authored the PR body verbatim.
const STRONG_AI_PHRASES = [
  /\bas an ai language model\b/i,
  /\bas a large language model\b/i,
  /\bi('?m| am) an ai\b/i,
  /\bi cannot (?:provide|assist|browse)\b/i,
  /\bhere('?s| is) (?:the|an) (?:updated|improved|enhanced) (?:code|version)\b/i,
  /\blet me know if you (?:need|want) any (?:further|other|more) (?:changes|help|assistance)\b/i,
];

// Generic low-information filler typical of slop bodies/titles.
const FILLER_PHRASES = [
  /\bimprove(?:s|d)? (?:the )?code quality\b/i,
  /\bfollow(?:s|ing)? best practices\b/i,
  /\benhance(?:s|d)? (?:the )?codebase\b/i,
  /\bfor better (?:performance|maintainability|readability)\b/i,
  /\boptimi[sz]e(?:s|d)? (?:the )?(?:performance|code)\b/i,
  /\bvarious (?:improvements|enhancements|changes)\b/i,
  /\bsignificantly improve(?:s|d)?\b/i,
];

// Linked-issue references → real intent, lowers low-effort-body signal.
const ISSUE_LINK = /(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#\d+|#\d{1,7}\b/i;

// Section headers an AI commonly emits as an empty scaffold it never fills in.
const TEMPLATE_HEADERS =
  /^\s{0,3}#{1,4}\s*(summary|overview|description|changes?(?:\s+made)?|what(?:'s| has)?\s+changed|motivation|why|testing|how\s+(?:was\s+this\s+)?tested|test\s+plan|checklist|notes?)\s*:?\s*$/i;

// Low-information section bodies (the AI filled the scaffold with filler).
const SECTION_FILLER =
  /^(?:n\/?a|none|todo|tbd|see (?:above|below|title|code)|self[- ]explanatory|this (?:pr|change|commit) (?:improves|enhances|updates|fixes) the code(?:base)?\.?|various (?:changes|improvements)\.?|minor (?:changes|tweaks|fixes)\.?|update[sd]?\.?)$/i;

// Commit subjects that carry no information about WHAT changed or WHY.
const LOW_INFO_COMMIT =
  /^(?:update(?:\s+\w+(?:\.\w+)?)?|updates?|changes?|fix(?:es|ed)?|wip|misc|stuff|edit(?:s|ed)?|patch|commit|temp|test|asdf+|\.+|minor(?:\s+(?:changes|fixes|tweaks))?|cleanup|refactor|improvements?|tweaks?|amend)$/i;

// Phrases in a body that assert a concrete, verifiable action was taken.
const CONCRETE_INTENT =
  /\b(?:fix(?:e[sd])?|resolv(?:e[sd]?|ing)|patch(?:e[sd])?|add(?:e?[sd])?|implement(?:e?[sd])?|introduc(?:e[sd]?|ing)|correct(?:e?[sd])?)\b\s+(?:a |an |the |this |that |some )?\w*\s*(?:bug|crash|error|race|leak|regression|test|failing test|null|exception|deadlock|vulnerab|typo|endpoint|function|method|feature|handler|validation|edge case)/i;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Does this file path look like docs / generated / non-code (so churn there
 * is far less suspicious)? Used by intentMismatch as a built-in floor in
 * ADDITION to any repo-configured exempt-paths. */
function isLowSignalPath(name) {
  return /(?:\.md|\.mdx|\.rst|\.txt|\.lock|\.snap|\.min\.js|\.map)$|(?:^|\/)(?:docs?|examples?|fixtures?|vendor|third[_-]?party|generated|dist|build)\//i.test(
    name || "",
  );
}

function aiBoilerplateSignal(pr) {
  const text = `${pr.title}\n${pr.body}`;
  if (STRONG_AI_PHRASES.some((re) => re.test(text))) return 1;
  const hits = FILLER_PHRASES.filter((re) => re.test(text)).length;
  if (hits >= 3) return 0.9;
  if (hits === 2) return 0.6;
  if (hits === 1) return 0.3;
  return 0;
}

function sprawlSignal(pr) {
  // A focused PR touches few files. AI slop frequently rewrites the world.
  const f = pr.changedFiles || pr.files.length || 0;
  const total = (pr.additions || 0) + (pr.deletions || 0);
  let s = 0;
  if (f >= 30) s += 0.6;
  else if (f >= 15) s += 0.35;
  else if (f >= 8) s += 0.15;
  if (total >= 2000) s += 0.4;
  else if (total >= 800) s += 0.2;
  // Touching lockfiles/generated alongside a "quality" PR is a classic tell.
  const touchesLock = pr.files.some((x) =>
    /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock)$/.test(
      x.filename || "",
    ),
  );
  if (touchesLock && f >= 8) s += 0.15;
  return clamp01(s);
}

function churnSignal(pr) {
  // No-op churn: additions ≈ deletions across many files, and/or patches that
  // only add trailing whitespace / reflow with no semantic change.
  const add = pr.additions || 0;
  const del = pr.deletions || 0;
  let s = 0;
  const total = add + del;
  if (total > 200) {
    const ratio = Math.min(add, del) / Math.max(add, del || 1);
    if (ratio > 0.9) s += 0.5; // churn that nets ~zero
    else if (ratio > 0.75) s += 0.25;
  }
  // Whitespace-only patch detection across provided file patches.
  const patches = pr.files.map((x) => x.patch || "").filter(Boolean);
  if (patches.length) {
    const wsOnly = patches.filter(isWhitespaceOnlyPatch).length;
    const frac = wsOnly / patches.length;
    if (frac >= 0.5) s += 0.5;
    else if (frac >= 0.25) s += 0.25;
  }
  return clamp01(s);
}

/**
 * True if every +/- line pair in the patch differs only by trailing/leading
 * whitespace (i.e. the change is cosmetic no-op churn).
 */
function isWhitespaceOnlyPatch(patch) {
  const added = [];
  const removed = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---"))
      removed.push(line.slice(1));
  }
  if (!added.length && !removed.length) return false;
  const norm = (s) => s.replace(/\s+/g, "");
  const a = added.map(norm).sort();
  const r = removed.map(norm).sort();
  if (a.length !== r.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== r[i]) return false;
  return true;
}

function lowEffortBodySignal(pr) {
  const body = (pr.body || "").trim();
  if (ISSUE_LINK.test(`${pr.title}\n${body}`)) return 0; // shows real intent
  if (body.length === 0) return 0.7;
  if (body.length < 40) return 0.4;
  // Body that is all filler and no specifics.
  if (FILLER_PHRASES.some((re) => re.test(body)) && body.length < 400)
    return 0.4;
  return 0;
}

function titleSignal(pr) {
  const t = (pr.title || "").trim();
  if (!t) return 0.4;
  if (/^update(?:\s+\w+(?:\.\w+)?)?$/i.test(t)) return 0.3; // "Update README.md"
  if (/\b(improve|enhance|optimize)\b.*\b(codebase|performance|quality)\b/i.test(t))
    return 0.3;
  return 0;
}

/**
 * templateBody — the PR body is an AI scaffold: it is mostly section HEADERS
 * (## Summary / ## Changes / ## Testing / ## Checklist) whose contents are
 * empty or pure filler. A genuine, filled-in template scores 0 here — it only
 * fires when the structure exists but the substance does not. Conservative:
 * needs ≥2 hollow sections AND a low real-content ratio.
 */
function templateBodySignal(pr) {
  const body = (pr.body || "").replace(/\r/g, "");
  if (!body.trim()) return 0; // emptiness is lowEffortBody's job, not this one
  const lines = body.split("\n");
  const headerIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (TEMPLATE_HEADERS.test(lines[i])) headerIdx.push(i);
  }
  if (headerIdx.length < 2) return 0; // not a templated body at all
  let hollow = 0;
  for (let h = 0; h < headerIdx.length; h++) {
    const start = headerIdx[h] + 1;
    const end = h + 1 < headerIdx.length ? headerIdx[h + 1] : lines.length;
    const sectionLines = lines
      .slice(start, end)
      .map((l) => l.replace(/^[-*]\s*\[[ xX]\]\s*/, "").trim())
      .filter(Boolean);
    const text = sectionLines.join(" ").trim();
    if (
      text === "" ||
      sectionLines.every((l) => SECTION_FILLER.test(l)) ||
      text.length < 12
    ) {
      hollow++;
    }
  }
  const ratio = hollow / headerIdx.length;
  if (hollow >= 2 && ratio >= 0.6) return 0.7;
  if (hollow >= 2 && ratio >= 0.4) return 0.4;
  if (hollow >= 3) return 0.4;
  return 0;
}

/**
 * commitQuality — the PR's commits carry no information ("Update", "fix",
 * "wip", "."). Conservative: a tiny diff or a single commit on a small change
 * is exempt (people legitimately push "fix typo"); only fires when EVERY
 * commit is low-info AND the change is non-trivial.
 */
function commitQualitySignal(pr) {
  const msgs = Array.isArray(pr.commitMessages) ? pr.commitMessages : [];
  if (!msgs.length) return 0; // unknown → never penalize
  const total = (pr.additions || 0) + (pr.deletions || 0);
  const files = pr.changedFiles || pr.files.length || 0;
  // Small, focused changes get a pass regardless of commit prose.
  if (total < 60 && files <= 2) return 0;
  const lowInfo = msgs.filter((m) => LOW_INFO_COMMIT.test(m)).length;
  const frac = lowInfo / msgs.length;
  if (frac === 1 && (total >= 400 || files >= 8)) return 0.6;
  if (frac === 1) return 0.4;
  if (frac >= 0.75 && msgs.length >= 4) return 0.3;
  return 0;
}

/**
 * intentMismatch — the body asserts a concrete action ("fixes the failing
 * test", "adds X endpoint", "resolves a race") but the actual diff is entirely
 * docs / whitespace / no-op (no real code touched). Classic fabricated-PR
 * tell. Honors repo `exempt-paths` AND a built-in low-signal-path floor so a
 * genuine docs PR that *says* it's a docs change never trips it.
 */
function intentMismatchSignal(pr, isExempt) {
  const text = `${pr.title}\n${pr.body || ""}`;
  if (!CONCRETE_INTENT.test(text)) return 0; // no concrete claim → nothing to contradict
  const files = pr.files || [];
  if (!files.length) return 0; // can't see the diff → don't guess
  // A claim that explicitly scopes itself to docs/tests is self-consistent.
  if (/\b(doc(?:s|umentation)?|readme|comment|typo|changelog)\b/i.test(text)) {
    return 0;
  }
  const codeTouched = files.filter((f) => {
    const name = f.filename || "";
    if (isExempt(name) || isLowSignalPath(name)) return false;
    const patch = f.patch || "";
    // a real code change has a non-whitespace +/- somewhere
    return patch && !isWhitespaceOnlyPatch(patch);
  });
  if (codeTouched.length === 0) {
    // Body promises a code-level fix; diff has zero real code changes.
    return 0.6;
  }
  return 0;
}

/**
 * massRename — many pure file renames / moves with little/no content change.
 * "Reorganize project structure" is a favorite low-value AI churn pattern.
 * Conservative: needs a real cluster of renames, scaled by how content-free
 * they are.
 */
function massRenameSignal(pr) {
  const files = pr.files || [];
  if (files.length < 6) return 0;
  const renames = files.filter(
    (f) => f && (f.status === "renamed" || f.status === "moved"),
  );
  if (renames.length < 5) return 0;
  const renameFrac = renames.length / files.length;
  const contentless = renames.filter(
    (f) => (f.additions || 0) + (f.deletions || 0) <= 2,
  ).length;
  const contentlessFrac = contentless / renames.length;
  let s = 0;
  if (renameFrac >= 0.8 && renames.length >= 10) s += 0.5;
  else if (renameFrac >= 0.6) s += 0.3;
  else if (renameFrac >= 0.4) s += 0.15;
  if (contentlessFrac >= 0.9) s += 0.2;
  return clamp01(s);
}

const SIGNAL_WHY = {
  aiBoilerplate:
    "title/body contains AI-assistant boilerplate or generic filler phrasing",
  sprawl: "diff sprawls across many unrelated files / is very large",
  churn: "large no-op or whitespace-only churn (adds≈deletes / reflow-only)",
  lowEffortBody:
    "missing or low-effort description with no linked issue or specifics",
  title: "vague generic title (e.g. just \"Update\")",
  templateBody:
    "PR body is a section scaffold (Summary/Changes/Testing) left hollow",
  commitQuality:
    "every commit message is uninformative (\"update\", \"fix\", \"wip\")",
  intentMismatch:
    "body promises a concrete code fix but the diff has no real code change",
  massRename: "many pure file renames/moves with little or no content change",
};

/**
 * @param {import('./parse.js').NormalizedPR} pr
 * @param {{exemptPaths?:string[]|((f:string)=>boolean), ruleWeights?:Record<string,number>}} [opts]
 * @returns {{score:number, signals:Record<string,number>, provenance:Array<{signal:string,value:number,why:string}>}}
 *
 * Backward compatible: callers passing only `pr` get the original behavior
 * plus the new signals; the structural blend stays conservative.
 */
export function scoreHeuristics(pr, opts = {}) {
  const isExempt =
    typeof opts.exemptPaths === "function"
      ? opts.exemptPaths
      : (() => {
          // local minimal matcher mirroring policy.makeExemptMatcher's subset,
          // kept here so heuristics.js stays importable standalone.
          const pats = Array.isArray(opts.exemptPaths)
            ? opts.exemptPaths.filter(Boolean)
            : [];
          if (!pats.length) return () => false;
          return (f) => {
            const name = String(f || "");
            return pats.some((raw) => {
              const p = String(raw).trim();
              if (p.endsWith("/**")) return name.startsWith(p.slice(0, -2));
              if (p.endsWith("/")) return name.startsWith(p);
              if (p.startsWith("**/*")) return name.endsWith(p.slice(4));
              if (p.startsWith("*.")) return name.endsWith(p.slice(1));
              if (!p.includes("*"))
                return name === p || name.startsWith(p + "/");
              return name.includes(p.replace(/\*/g, ""));
            });
          };
        })();

  const signals = {
    aiBoilerplate: aiBoilerplateSignal(pr),
    sprawl: sprawlSignal(pr),
    churn: churnSignal(pr),
    lowEffortBody: lowEffortBodySignal(pr),
    title: titleSignal(pr),
    templateBody: templateBodySignal(pr),
    commitQuality: commitQualitySignal(pr),
    intentMismatch: intentMismatchSignal(pr, isExempt),
    massRename: massRenameSignal(pr),
  };

  // Optional per-signal weight multipliers from repo policy (default 1.0,
  // clamped to [0,2] by policy.js). Multiplying the signal — not the weight —
  // keeps the [0,1] blend math intact and the multiplier easy to reason about.
  const rw = opts.ruleWeights || {};
  const mul = (k) =>
    clamp01(signals[k] * (rw[k] === undefined ? 1 : Number(rw[k]) || 0));

  // Conservative weighted blend. aiBoilerplate is the most reliable tell, so
  // it can carry a PR on its own. The new signals are deliberately given
  // modest weight: they reinforce, they don't single-handedly condemn (no
  // cry-wolf). Weights sum to 1.0 so the score stays a clean [0,1].
  const weighted =
    0.3 * mul("aiBoilerplate") +
    0.15 * mul("sprawl") +
    0.13 * mul("churn") +
    0.1 * mul("lowEffortBody") +
    0.05 * mul("title") +
    0.13 * mul("templateBody") +
    0.07 * mul("commitQuality") +
    0.04 * mul("intentMismatch") +
    0.03 * mul("massRename");

  // Corroboration bonus. The per-signal weights are deliberately timid so no
  // single signal can condemn a PR (anti-cry-wolf). But several INDEPENDENT
  // weak tells firing together is itself strong evidence — that is the whole
  // point of an ensemble. We add a small, capped boost only when ≥3 distinct
  // signals each clear 0.3. This is *structurally incapable* of raising a
  // genuine PR: the legit fixtures fire ZERO signals, so the bonus is 0 for
  // them. It only sharpens multi-tell slop the timid blend would under-rate.
  const firedCount = mulFiredCount(signals, rw);
  let corroboration = 0;
  if (firedCount >= 5) corroboration = 0.22;
  else if (firedCount === 4) corroboration = 0.15;
  else if (firedCount === 3) corroboration = 0.08;
  const finalScore = clamp01(weighted + corroboration);

  const provenance = Object.keys(signals)
    .map((k) => ({ signal: k, value: signals[k], why: SIGNAL_WHY[k] || k }))
    .filter((p) => p.value >= 0.3)
    .sort((a, b) => b.value - a.value);

  return { score: finalScore, signals, provenance };
}

/** Count signals that clear 0.3 *after* the policy rule-weight multiplier
 * (a signal a maintainer disabled with `rules: { x: 0 }` must not corroborate). */
function mulFiredCount(signals, rw) {
  let n = 0;
  for (const k of Object.keys(signals)) {
    const m = rw && rw[k] !== undefined ? Number(rw[k]) || 0 : 1;
    if (clamp01(signals[k] * m) >= 0.3) n++;
  }
  return n;
}
