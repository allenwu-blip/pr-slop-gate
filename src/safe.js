/**
 * safe.js — hardening layer. PURE, no I/O. The promise this module enforces:
 * **pr-slop-gate never breaks the host repo's CI.** Whatever GitHub (or an
 * attacker opening a hostile PR) throws at it — truncated event JSON, a
 * 50MB diff, binary blobs, invalid UTF-8, millions of files — the Action
 * degrades to a safe, deterministic `allow` and a diagnostic, and exits 0.
 *
 * These caps are deliberate and documented (README "Limitations"): scoring a
 * multi-megabyte patch line-by-line is both pointless (it's obviously not a
 * focused human PR) and a DoS vector on the runner. We cap, mark the record
 * `truncated`, and keep going.
 */

// --- bounds (generous enough for any genuine PR; pathological beyond) -------
export const LIMITS = Object.freeze({
  MAX_EVENT_BYTES: 8 * 1024 * 1024, // 8MB event JSON
  MAX_FILES: 3000, // files scored per PR
  MAX_PATCH_BYTES: 256 * 1024, // per-file patch kept for analysis
  MAX_TOTAL_PATCH_BYTES: 4 * 1024 * 1024, // sum of patches scored
  MAX_BODY_BYTES: 512 * 1024, // PR body considered
  MAX_DIFF_BYTES: 4 * 1024 * 1024, // raw unified diff considered
});

// NUL written as an explicit escape so there is NO literal NUL byte in this
// source file (a literal one is invisible and trips editors / bundlers).
const NUL = new RegExp(String.fromCharCode(0), "g");

/**
 * JSON.parse that never throws.
 * @param {string} text
 * @returns {{ event: any, error: string|null, oversized: boolean }}
 */
export function safeParseEvent(text) {
  if (typeof text !== "string") {
    return { event: null, error: "event payload is not a string", oversized: false };
  }
  if (text.length > LIMITS.MAX_EVENT_BYTES) {
    return {
      event: null,
      error: `event JSON exceeds ${LIMITS.MAX_EVENT_BYTES} bytes; refusing to parse`,
      oversized: true,
    };
  }
  try {
    const event = JSON.parse(text);
    if (event === null || typeof event !== "object") {
      return { event: null, error: "event JSON is not an object", oversized: false };
    }
    return { event, error: null, oversized: false };
  } catch (e) {
    return {
      event: null,
      error: `event JSON did not parse: ${String(e && e.message).slice(0, 200)}`,
      oversized: false,
    };
  }
}

/** Heuristic: does this string look like binary / non-text content? */
export function looksBinary(s) {
  if (typeof s !== "string" || s.length === 0) return false;
  // A NUL byte never appears in a real text patch; U+FFFD means the UTF-8
  // decoder already replaced invalid bytes. Either ⇒ treat as binary.
  // Sample the first 8KB (cheap and sufficient).
  const sample = s.length > 8192 ? s.slice(0, 8192) : s;
  if (NUL.test(sample)) {
    NUL.lastIndex = 0; // reset the global regex's stateful lastIndex
    return true;
  }
  let weird = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0xfffd) weird++;
    else if (c < 9 || (c > 13 && c < 32)) weird++;
  }
  return weird / sample.length > 0.1;
}

/** Coerce anything to a bounded UTF-8-ish string (strip NUL, cap length). */
function safeStr(v, cap) {
  let s = typeof v === "string" ? v : v == null ? "" : String(v);
  s = s.replace(NUL, "");
  if (cap && s.length > cap) s = s.slice(0, cap);
  return s;
}

/**
 * Sanitize a normalized PR before scoring: cap sizes, drop binary/oversized
 * patches, bound file count and body/diff length. Returns a NEW object plus a
 * `sanitation` note (counts of what was dropped/truncated) so the analytics
 * record and run log can state it honestly. Never throws.
 *
 * @param {import('./parse.js').NormalizedPR} pr
 */
export function sanitizePr(pr) {
  const notes = {
    truncated: false,
    filesDropped: 0,
    binaryPatchesDropped: 0,
    patchesTruncated: 0,
    bodyTruncated: false,
    diffTruncated: false,
  };
  if (!pr || typeof pr !== "object") {
    return { pr: emptyPr(), sanitation: { ...notes, truncated: true } };
  }

  const body = safeStr(pr.body, LIMITS.MAX_BODY_BYTES);
  if (typeof pr.body === "string" && pr.body.length > LIMITS.MAX_BODY_BYTES) {
    notes.bodyTruncated = true;
    notes.truncated = true;
  }
  let diff = safeStr(pr.diff, LIMITS.MAX_DIFF_BYTES);
  if (typeof pr.diff === "string" && pr.diff.length > LIMITS.MAX_DIFF_BYTES) {
    notes.diffTruncated = true;
    notes.truncated = true;
  }
  if (looksBinary(diff)) {
    diff = "";
  }

  const rawFiles = Array.isArray(pr.files) ? pr.files : [];
  if (rawFiles.length > LIMITS.MAX_FILES) {
    notes.filesDropped = rawFiles.length - LIMITS.MAX_FILES;
    notes.truncated = true;
  }
  const capped = rawFiles.slice(0, LIMITS.MAX_FILES);

  let totalPatch = 0;
  const files = [];
  for (const f of capped) {
    if (!f || typeof f !== "object") continue;
    const filename = safeStr(f.filename, 1024);
    let patch = typeof f.patch === "string" ? f.patch : "";
    if (patch && looksBinary(patch)) {
      // GitHub usually omits `patch` for binary; if a hostile payload injects
      // binary, drop the patch but KEEP the file (its add/del counts still
      // inform sprawl/rename signals — just no patch-level analysis).
      notes.binaryPatchesDropped++;
      patch = "";
      notes.truncated = true;
    }
    if (patch.length > LIMITS.MAX_PATCH_BYTES) {
      patch = patch.slice(0, LIMITS.MAX_PATCH_BYTES);
      notes.patchesTruncated++;
      notes.truncated = true;
    }
    if (totalPatch + patch.length > LIMITS.MAX_TOTAL_PATCH_BYTES) {
      patch = ""; // global patch budget exhausted; metadata still scored
      notes.truncated = true;
    } else {
      totalPatch += patch.length;
    }
    files.push({
      filename,
      status: safeStr(f.status, 32),
      additions: finiteNum(f.additions),
      deletions: finiteNum(f.deletions),
      patch,
    });
  }

  return {
    pr: {
      ...pr,
      number: finiteNum(pr.number),
      title: safeStr(pr.title, 4096),
      body,
      author: safeStr(pr.author, 256),
      authorType: safeStr(pr.authorType || "User", 32),
      additions: finiteNum(pr.additions),
      deletions: finiteNum(pr.deletions),
      changedFiles: finiteNum(pr.changedFiles),
      commits: finiteNum(pr.commits),
      files,
      diff,
      commitMessages: Array.isArray(pr.commitMessages)
        ? pr.commitMessages.slice(0, 200).map((m) => safeStr(m, 1024))
        : [],
      labels: Array.isArray(pr.labels)
        ? pr.labels.slice(0, 200).map((l) => safeStr(l, 256))
        : [],
    },
    sanitation: notes,
  };
}

function finiteNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function emptyPr() {
  return {
    number: 0,
    title: "",
    body: "",
    author: "",
    authorType: "User",
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    commits: 0,
    files: [],
    diff: "",
    commitMessages: [],
    labels: [],
  };
}

/**
 * The safe, inert result returned whenever anything goes wrong. Deterministic.
 * `decision: "allow"` + no label/comment/close → the Action is a no-op and the
 * host CI is unaffected. The diagnostic is surfaced (logged), never thrown.
 *
 * @param {string} reason
 * @param {object} [extra]
 */
export function safeAllowResult(reason, extra = {}) {
  return {
    number: finiteNum(extra.number),
    author: typeof extra.author === "string" ? extra.author : "",
    score: 0,
    heuristicScore: 0,
    graderScore: 0,
    graderUsed: false,
    decision: "allow",
    label: null,
    shouldComment: false,
    shouldClose: false,
    exemptedBy: null,
    comment: null,
    reasons: [],
    signals: {},
    provenance: [],
    error: String(reason || "unknown error").slice(0, 300),
    degraded: true,
  };
}
