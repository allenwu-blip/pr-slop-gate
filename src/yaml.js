/**
 * yaml.js — a TINY, safe, dependency-free parser for the strict YAML SUBSET
 * that `.pr-slop-gate.yml` is allowed to use. This is intentionally NOT a
 * general YAML implementation: the product ships with zero runtime deps, and a
 * full YAML parser is both heavy and a known footgun (anchors, tags, `!!`
 * type coercion, the Norway problem). Restricting the grammar makes the policy
 * file auditable and the parser provably bounded.
 *
 * Supported grammar (everything else is a soft error, never a throw):
 *   - 2-space indentation only (tabs in indentation are rejected with an error)
 *   - block mappings:           key: value
 *   - nested mappings:          key:\n  child: value
 *   - block sequences:          - scalar           (string/number/bool list)
 *   - mapping value scalars:    plain | "double" | 'single' quoted
 *   - scalars: string, integer/float, true/false, null/~/(empty)
 *   - `#` line comments and blank lines
 *
 * Deliberately UNSUPPORTED (reported as an error, parsing continues):
 *   flow collections ({}, []), anchors/aliases (&/*), tags (!!), multi-line
 *   block scalars (| >), sequences of maps. The policy schema never needs them.
 *
 * Contract: parse(text) -> { value, errors }  — NEVER throws. `value` is a
 * best-effort plain object/array/scalar; `errors` is a list of
 * { line, message } the caller can surface as warnings.
 */

const MAX_BYTES = 64 * 1024; // a policy file larger than this is pathological
const MAX_LINES = 2000;
const MAX_DEPTH = 12;

function parseScalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  // Quoted strings are taken verbatim (no escape processing beyond \" / \\),
  // which is all the policy schema needs and avoids YAML escape ambiguity.
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  // Number (integer or float), but ONLY if it round-trips exactly — this is
  // what dodges the "Norway problem": `no`, `on`, version-like `1.2.3`,
  // `08` stay strings.
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && String(n) === s) return n;
  }
  return s;
}

/**
 * @param {string} text
 * @returns {{ value: any, errors: Array<{line:number,message:string}> }}
 */
export function parse(text) {
  const errors = [];
  if (typeof text !== "string") return { value: {}, errors };
  if (text.length > MAX_BYTES) {
    errors.push({ line: 0, message: `policy file too large (>${MAX_BYTES} bytes); ignored` });
    return { value: {}, errors };
  }

  const rawLines = text.split(/\r?\n/);
  if (rawLines.length > MAX_LINES) {
    errors.push({ line: 0, message: `policy file too long (>${MAX_LINES} lines); ignored` });
    return { value: {}, errors };
  }

  // Tokenize into { indent, content, line } skipping blanks / comments.
  const toks = [];
  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    let line = rawLines[i];
    // Strip a trailing comment that is not inside quotes (simple, sufficient
    // for the policy grammar which has no `#` in keys/values we care about).
    const hashAt = findCommentStart(line);
    if (hashAt >= 0) line = line.slice(0, hashAt);
    if (line.trim() === "") continue;
    const indentMatch = line.match(/^[ \t]*/)[0];
    if (indentMatch.includes("\t")) {
      errors.push({ line: lineNo, message: "tab in indentation is not allowed (use 2 spaces)" });
    }
    const indent = indentMatch.replace(/\t/g, "  ").length;
    toks.push({ indent, content: line.trim(), line: lineNo });
  }

  let idx = 0;

  function parseBlock(minIndent, depth) {
    if (depth > MAX_DEPTH) {
      errors.push({ line: toks[idx]?.line ?? 0, message: "policy nesting too deep; truncated" });
      return null;
    }
    if (idx >= toks.length) return null;
    const first = toks[idx];
    if (first.indent < minIndent) return null;
    const isSeq = first.content.startsWith("- ") || first.content === "-";
    return isSeq
      ? parseSequence(first.indent, depth)
      : parseMapping(first.indent, depth);
  }

  function parseMapping(indent, depth) {
    const obj = {};
    while (idx < toks.length) {
      const t = toks[idx];
      if (t.indent < indent) break;
      if (t.indent > indent) {
        errors.push({ line: t.line, message: "unexpected indentation; line ignored" });
        idx++;
        continue;
      }
      if (t.content.startsWith("- ")) {
        errors.push({ line: t.line, message: "sequence item where a mapping key was expected; ignored" });
        idx++;
        continue;
      }
      const colon = splitKeyColon(t.content);
      if (!colon) {
        errors.push({ line: t.line, message: `not a 'key: value' mapping line: ${truncate(t.content)}` });
        idx++;
        continue;
      }
      const key = colon.key;
      const inline = colon.value;
      idx++;
      if (inline !== "") {
        obj[key] = parseScalar(inline);
      } else {
        // value is on following more-indented lines (map or seq), else null
        const next = toks[idx];
        if (next && next.indent > indent) {
          const child = parseBlock(indent + 1, depth + 1);
          obj[key] = child === null ? {} : child;
        } else {
          obj[key] = null;
        }
      }
    }
    return obj;
  }

  function parseSequence(indent, depth) {
    const arr = [];
    while (idx < toks.length) {
      const t = toks[idx];
      if (t.indent < indent) break;
      if (t.indent > indent) {
        errors.push({ line: t.line, message: "unexpected indentation in list; line ignored" });
        idx++;
        continue;
      }
      if (!(t.content === "-" || t.content.startsWith("- "))) break;
      const item = t.content === "-" ? "" : t.content.slice(2).trim();
      if (item === "") {
        // nested block under the dash is intentionally unsupported (schema
        // never needs list-of-maps); record and skip.
        errors.push({ line: t.line, message: "empty or nested list item not supported; ignored" });
        idx++;
        continue;
      }
      if (splitKeyColon(item) && !/^["']/.test(item)) {
        errors.push({ line: t.line, message: "list of mappings is not supported in policy; item ignored" });
        idx++;
        continue;
      }
      arr.push(parseScalar(item));
      idx++;
    }
    return arr;
  }

  const value = parseBlock(0, 0);
  return { value: value === null ? {} : value, errors };
}

/** Index of an unquoted `#` that begins a comment, or -1. */
function findCommentStart(line) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === "#" && !inS && !inD) {
      // a `#` only starts a comment at start-of-line or after whitespace
      if (i === 0 || /\s/.test(line[i - 1])) return i;
    }
  }
  return -1;
}

/** Split "key: value" respecting quotes; returns {key,value} or null. */
function splitKeyColon(s) {
  let inS = false;
  let inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === ":" && !inS && !inD) {
      const after = s[i + 1];
      if (after === undefined || after === " " || after === "\t") {
        return { key: unquoteKey(s.slice(0, i).trim()), value: s.slice(i + 1).trim() };
      }
    }
  }
  return null;
}

function unquoteKey(k) {
  if (k.length >= 2 && ((k[0] === '"' && k.endsWith('"')) || (k[0] === "'" && k.endsWith("'")))) {
    return k.slice(1, -1);
  }
  return k;
}

function truncate(s) {
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}
