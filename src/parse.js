/**
 * parse.js — normalize a GitHub `pull_request` webhook event payload into a
 * stable, flat `pr` object the rest of the library consumes.
 *
 * PURE. Takes a plain object (the parsed event JSON). Does NOT read files or
 * touch the network — the runner is responsible for loading GITHUB_EVENT_PATH
 * and (optionally) fetching the file list / diff and merging them in under the
 * documented `_files` / `_diff` keys before calling this.
 */

/**
 * @typedef {Object} NormalizedPR
 * @property {number} number
 * @property {string} title
 * @property {string} body
 * @property {string} author        - PR author login
 * @property {string} authorType    - "User" | "Bot" | ...
 * @property {number} additions
 * @property {number} deletions
 * @property {number} changedFiles
 * @property {number} commits
 * @property {boolean} draft
 * @property {string} baseRepo      - "owner/name"
 * @property {string} baseRef
 * @property {string} headRef
 * @property {Array<{filename:string,status:string,additions:number,deletions:number,patch:string}>} files
 * @property {string} diff          - unified diff text (may be "")
 * @property {string[]} labels      - existing label names
 * @property {string[]} commitMessages - first lines of each commit message
 *                                       (runner fills `_commits`; "" if absent)
 */

function num(v, d = 0) {
  return Number.isFinite(v) ? v : d;
}

/**
 * @param {object} event - parsed GitHub pull_request event payload (a dict).
 * @returns {NormalizedPR}
 */
export function parsePullRequestEvent(event) {
  if (!event || typeof event !== "object" || !event.pull_request) {
    throw new Error(
      "pr-slop-gate: payload is not a pull_request event (no `pull_request` key). " +
        "This Action must be triggered on `pull_request` / `pull_request_target`.",
    );
  }
  const p = event.pull_request;
  const repo = event.repository || {};
  const user = p.user || {};
  const base = p.base || {};
  const head = p.head || {};

  return {
    number: num(p.number),
    title: typeof p.title === "string" ? p.title : "",
    body: typeof p.body === "string" ? p.body : "",
    author: typeof user.login === "string" ? user.login : "",
    authorType: typeof user.type === "string" ? user.type : "User",
    additions: num(p.additions),
    deletions: num(p.deletions),
    changedFiles: num(p.changed_files),
    commits: num(p.commits),
    draft: Boolean(p.draft),
    baseRepo:
      typeof repo.full_name === "string" ? repo.full_name : "unknown/unknown",
    baseRef: typeof base.ref === "string" ? base.ref : "",
    headRef: typeof head.ref === "string" ? head.ref : "",
    // `_files` / `_diff` are populated by the runner from the GitHub API; in
    // tests they come straight from the fixture. Either way this stays pure.
    files: Array.isArray(event._files) ? event._files : [],
    diff: typeof event._diff === "string" ? event._diff : "",
    labels: Array.isArray(p.labels)
      ? p.labels.map((l) => (typeof l === "string" ? l : l && l.name)).filter(Boolean)
      : [],
    // `_commits` is populated by the runner from the GitHub API (commit list);
    // each entry's first line is the commit subject. In tests it comes from the
    // fixture. Accepts either ["msg", ...] or [{commit:{message}}|{message}].
    commitMessages: normalizeCommitMessages(event._commits),
  };
}

function normalizeCommitMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const c of raw) {
    let msg = "";
    if (typeof c === "string") msg = c;
    else if (c && typeof c === "object") {
      msg =
        (c.commit && typeof c.commit.message === "string" && c.commit.message) ||
        (typeof c.message === "string" && c.message) ||
        "";
    }
    const firstLine = String(msg).split("\n")[0].trim();
    if (firstLine) out.push(firstLine);
  }
  return out;
}
