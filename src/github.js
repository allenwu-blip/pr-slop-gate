/**
 * github.js — the thin GitHub REST client used ONLY by the runner. All actual
 * network I/O for the Action lives here so the scoring library stays pure.
 * Uses Node 20+ built-in fetch (zero runtime dependencies).
 *
 * Not exercised in CI (would require a live token + network). Kept small,
 * defensive, and documented.
 */

const API = process.env.GITHUB_API_URL || "https://api.github.com";

function gh(token) {
  return async (method, path, body) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "pr-slop-gate",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${t.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  };
}

/** List changed files (paginated, capped) for a PR. */
export async function listPullFiles(token, owner, repo, number, cap = 300) {
  const call = gh(token);
  const out = [];
  for (let page = 1; page <= 10 && out.length < cap; page++) {
    const batch = await call(
      "GET",
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const f of batch) {
      out.push({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch || "",
      });
    }
    if (batch.length < 100) break;
  }
  return out;
}

/** Fetch the raw unified diff for a PR. */
export async function getPullDiff(token, owner, repo, number) {
  const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/${number}`, {
    headers: {
      accept: "application/vnd.github.v3.diff",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "pr-slop-gate",
    },
  });
  if (!res.ok) return "";
  return res.text();
}

/**
 * Best-effort list of logins who already had a PR merged into this repo
 * (used as the prior-merged-authors trusted set). Capped; failures degrade
 * gracefully to an empty list (then only the explicit allowlist applies).
 */
export async function derivePriorMergedAuthors(token, owner, repo, cap = 300) {
  const call = gh(token);
  const set = new Set();
  try {
    for (let page = 1; page <= 5 && set.size < cap; page++) {
      const batch = await call(
        "GET",
        `/repos/${owner}/${repo}/pulls?state=closed&per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const pr of batch) {
        if (pr.merged_at && pr.user && pr.user.login) set.add(pr.user.login);
      }
      if (batch.length < 100) break;
    }
  } catch {
    /* graceful: empty set => allowlist-only exemption */
  }
  return [...set];
}

/** Fetch CONTRIBUTING.md content (best-effort; "" if absent). */
export async function getContributing(token, owner, repo) {
  for (const path of [
    "CONTRIBUTING.md",
    ".github/CONTRIBUTING.md",
    "docs/CONTRIBUTING.md",
  ]) {
    try {
      const res = await fetch(
        `${API}/repos/${owner}/${repo}/contents/${path}`,
        {
          headers: {
            accept: "application/vnd.github.raw+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "pr-slop-gate",
          },
        },
      );
      if (res.ok) return res.text();
    } catch {
      /* try next path */
    }
  }
  return "";
}

/**
 * Fetch the repo's `.pr-slop-gate.yml` policy file (best-effort; "" if absent
 * or unreadable). Tries the given path then a `.github/` fallback. Network I/O
 * stays here; the policy PARSER (policy.js) is pure and takes the text.
 */
export async function getPolicyFile(token, owner, repo, path = ".pr-slop-gate.yml") {
  const candidates = [path, `.github/${path}`].filter(
    (v, i, a) => v && a.indexOf(v) === i,
  );
  for (const p of candidates) {
    try {
      const res = await fetch(
        `${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(p)}`,
        {
          headers: {
            accept: "application/vnd.github.raw+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "pr-slop-gate",
          },
        },
      );
      if (res.ok) return res.text();
    } catch {
      /* try next path */
    }
  }
  return "";
}

export async function addLabels(token, owner, repo, number, labels) {
  await gh(token)("POST", `/repos/${owner}/${repo}/issues/${number}/labels`, {
    labels,
  });
}

export async function createComment(token, owner, repo, number, body) {
  await gh(token)(
    "POST",
    `/repos/${owner}/${repo}/issues/${number}/comments`,
    { body },
  );
}

export async function closePull(token, owner, repo, number) {
  await gh(token)("PATCH", `/repos/${owner}/${repo}/pulls/${number}`, {
    state: "closed",
  });
}
