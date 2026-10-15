"use strict";
// Code the user attaches (pasted files or a public GitHub repo), unified
// diffs, and a parse-only syntax check. Nothing here executes user code.
const vm = require("vm");

const MAX_FILE = 200_000;

/**
 * Pasted code: one or more files, each introduced by a header line such as
 *   // file: src/user.js      # file: app.py      === src/user.js ===      ```js src/user.js
 */
function parsePastedCode(text) {
  const src = String(text || "").replace(/\r\n/g, "\n");
  if (!src.trim()) return [];
  const header = /^(?:\/\/|#|--)\s*file:\s*(\S+)\s*$|^===\s*(\S+)\s*===\s*$|^```[\w-]*\s+(\S+\.\w+)\s*$/;
  const files = [];
  let current = null;
  for (const line of src.split("\n")) {
    const m = line.match(header);
    if (m) {
      current = { path: (m[1] || m[2] || m[3]).replace(/^\.\//, ""), lines: [], source: "pasted" };
      files.push(current);
      continue;
    }
    if (/^```\s*$/.test(line) && current) continue;
    if (current) current.lines.push(line);
  }
  if (!files.length) return [{ path: "pasted.js", content: src.slice(0, MAX_FILE), source: "pasted" }];
  return files.map((f) => ({ path: f.path, content: f.lines.join("\n").replace(/\n+$/, "\n").slice(0, MAX_FILE), source: f.source }));
}

/** Fetches the files named in the stack from a public GitHub repo (raw.githubusercontent.com only). */
async function fetchFromGitHub(repo, ref, paths, fetchImpl = globalThis.fetch) {
  const m = String(repo || "").match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m || !fetchImpl) return { files: [], errors: repo ? ["repo must look like https://github.com/owner/name"] : [] };
  const [, owner, name] = m;
  const branch = (ref || "HEAD").replace(/[^\w./-]/g, "");
  const files = [];
  const errors = [];
  for (const path of [...new Set(paths)].slice(0, 6)) {
    const clean = path.replace(/^\/+/, "").replace(/\.\.+/g, "");
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${clean}`;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        errors.push(`${clean}: HTTP ${res.status}`);
        continue;
      }
      files.push({ path: clean, content: (await res.text()).slice(0, MAX_FILE), source: `github ${owner}/${name}@${branch}` });
    } catch (e) {
      errors.push(`${clean}: ${e.message}`);
    }
  }
  return { files, errors };
}

/** Matches a stack path (absolute, /app/src/x.js, src/x.js) to an attached file. */
function findFile(files, path) {
  const want = String(path || "").replace(/\\/g, "/");
  return (
    files.find((f) => f.path === want) ||
    files.find((f) => want.endsWith("/" + f.path) || f.path.endsWith("/" + want)) ||
    files.find((f) => f.path.split("/").pop() === want.split("/").pop()) ||
    null
  );
}

// ---- parse-only syntax check ------------------------------------------------
function blankKeepNewlines(s) {
  return s.replace(/[^\n]/g, " ");
}

function neutralizeModuleSyntax(src) {
  return src
    .replace(/^\s*import\s[\s\S]*?\sfrom\s*['"][^'"]+['"]\s*;?/gm, blankKeepNewlines)
    .replace(/^\s*import\s*['"][^'"]+['"]\s*;?/gm, blankKeepNewlines)
    .replace(/^\s*export\s*\*\s*from\s*['"][^'"]+['"]\s*;?/gm, blankKeepNewlines)
    .replace(/^\s*export\s*\{[^}]*\}\s*(from\s*['"][^'"]+['"])?\s*;?/gm, blankKeepNewlines)
    .replace(/^(\s*)export\s+default\s+/gm, "$1void ")
    .replace(/^(\s*)export\s+(?=(async\s+)?function|class|const|let|var)/gm, "$1");
}

function syntaxCheck(code, path) {
  if (/\.(tsx?|jsx)$/.test(path)) return { checked: false, reason: "TypeScript/JSX: syntax check skipped" };
  if (!/\.(c|m)?js$/.test(path)) return { checked: false, reason: "not a JavaScript file: syntax check skipped" };
  let src = String(code).replace(/^#!.*/, "");
  const isModule = path.endsWith(".mjs") || /^\s*(import\s|export\s)/m.test(src);
  if (isModule) src = neutralizeModuleSyntax(src);
  try {
    // compiled, never run: the wrapper function is not called
    new vm.Script(`(async function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: path });
    return { checked: true, ok: true };
  } catch (e) {
    return { checked: true, ok: false, error: e.message };
  }
}

// ---- unified diff ------------------------------------------------------------
function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t;
}

function unifiedDiff(path, before, after, context = 3) {
  const a = String(before).replace(/\n$/, "").split("\n");
  const b = String(after).replace(/\n$/, "").split("\n");
  if (a.length * b.length > 9_000_000) throw new Error("file too large to diff");
  const t = lcsTable(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ op: " ", line: a[i++], ai: i, bj: ++j });
    else if (i < a.length && (j === b.length || t[i + 1][j] >= t[i][j + 1])) ops.push({ op: "-", line: a[i++] });
    else ops.push({ op: "+", line: b[j++] });
  }
  // group changes into hunks with context
  const changeIdx = ops.map((o, k) => (o.op === " " ? -1 : k)).filter((k) => k >= 0);
  if (!changeIdx.length) return "";
  const hunks = [];
  let start = Math.max(0, changeIdx[0] - context);
  let end = Math.min(ops.length, changeIdx[0] + context + 1);
  for (const k of changeIdx.slice(1)) {
    if (k - context <= end) end = Math.min(ops.length, k + context + 1);
    else {
      hunks.push([start, end]);
      start = Math.max(0, k - context);
      end = Math.min(ops.length, k + context + 1);
    }
  }
  hunks.push([start, end]);

  let out = `--- a/${path}\n+++ b/${path}\n`;
  for (const [s, e] of hunks) {
    let aLine = 1;
    let bLine = 1;
    for (let k = 0; k < s; k++) {
      if (ops[k].op !== "+") aLine++;
      if (ops[k].op !== "-") bLine++;
    }
    const slice = ops.slice(s, e);
    const aCount = slice.filter((o) => o.op !== "+").length;
    const bCount = slice.filter((o) => o.op !== "-").length;
    out += `@@ -${aCount ? aLine : aLine - 1},${aCount} +${bCount ? bLine : bLine - 1},${bCount} @@\n`;
    for (const o of slice) out += o.op + o.line + "\n";
  }
  return out;
}

/** Applies a unified diff produced by unifiedDiff to `before` — used to prove the diff applies. */
function applyDiff(before, diff) {
  const src = String(before).replace(/\n$/, "").split("\n");
  const out = [];
  let pos = 0;
  const lines = diff.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const h = lines[k].match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    if (!h) continue;
    const aStart = Number(h[2]) === 0 ? Number(h[1]) : Number(h[1]) - 1;
    while (pos < aStart) out.push(src[pos++]);
    for (k = k + 1; k < lines.length && !lines[k].startsWith("@@") && !lines[k].startsWith("--- "); k++) {
      const op = lines[k][0];
      const text = lines[k].slice(1);
      if (op === " " || op === "-") {
        if (src[pos] !== text) throw new Error(`context mismatch at line ${pos + 1}`);
        if (op === " ") out.push(text);
        pos++;
      } else if (op === "+") out.push(text);
    }
    k--;
  }
  while (pos < src.length) out.push(src[pos++]);
  return out.join("\n") + "\n";
}

module.exports = { parsePastedCode, fetchFromGitHub, findFile, syntaxCheck, unifiedDiff, applyDiff, neutralizeModuleSyntax };
