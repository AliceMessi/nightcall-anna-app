"use strict";
// Invalid regular expression alerts: the pattern is in the message, so the
// failure can be reproduced exactly by compiling it (compile only — no user
// code runs) and the offending character located by a small scanner.
const { unifiedDiff, syntaxCheck } = require("./code");

// one line at a time: greedy (.*) stops at the last "/flags: " of that line
const MSG_RE = /Invalid regular expression: \/(.*)\/([dgimsuvy]*): ([^\n"]+)/;

// Same algorithm as escape-string-regexp v5 (and v4 for these characters).
function escapeLikeLibrary(text) {
  return text.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}

/** Walks the pattern like the RegExp parser does for groups, classes and escapes. */
function locateCulprit(pattern, reason) {
  const groups = [];
  let classStart = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      if (i === pattern.length - 1) return [{ index: i, char: "\\", why: "the pattern ends with a lone backslash" }];
      i++;
      continue;
    }
    if (classStart >= 0) {
      if (c === "]") classStart = -1;
      continue;
    }
    if (c === "[") classStart = i;
    else if (c === "(") groups.push(i);
    else if (c === ")") {
      if (!groups.length) return [{ index: i, char: ")", why: "it closes a group that was never opened" }];
      groups.pop();
    } else if (/^Nothing to repeat/i.test(reason) && /[*+?{]/.test(c)) {
      const prev = i === 0 ? "" : pattern[i - 1];
      if (i === 0 || prev === "(" || prev === "|") return [{ index: i, char: c, why: "a quantifier has nothing before it to repeat" }];
    }
  }
  if (classStart >= 0) return [{ index: classStart, char: "[", why: "it opens a character class that is never closed" }];
  if (groups.length) return groups.map((index) => ({ index, char: "(", why: "it opens a group that is never closed" }));
  return [];
}

const CHAR_WORDS = [
  { re: /\bback-?slash/i, char: "\\" },
  { re: /\bslash\b|forward slash/i, char: "/" },
  { re: /\bparen(thes[ie]s)?\b|\bbracket\b/i, char: "(" },
  { re: /square bracket/i, char: "[" },
];

const ESCAPERS = ["escape-string-regexp", "lodash.escaperegexp", "escape-regexp", "RegExp.escape"];

function compileError(pattern, flags) {
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (e) {
    return e.message;
  }
}

/** Wraps dynamic `new RegExp(x)` calls in escapeStringRegexp(x) inside attached code. */
function patchCallSites(files) {
  const changed = [];
  for (const f of files) {
    const lines = f.content.split("\n");
    let touched = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/(new\s+)?RegExp\(\s*([^,)]+?)\s*(,|\))/);
      if (!m) continue;
      const arg = m[2];
      if (/^['"`/]/.test(arg) || /escape/i.test(arg)) continue; // literal or already escaped
      lines[i] = line.replace(m[0], `${m[1] || ""}RegExp(escapeStringRegexp(${arg})${m[3]}`);
      touched = true;
    }
    if (!touched) continue;
    if (!/escapeStringRegexp\s*=|import\s+escapeStringRegexp/.test(f.content)) {
      const esm = /^\s*(import\s|export\s)/m.test(f.content) || f.path.endsWith(".mjs");
      const imp = esm ? 'import escapeStringRegexp from "escape-string-regexp";' : 'const escapeStringRegexp = require("escape-string-regexp"); // v4 (v5 is ESM-only)';
      let at = 0;
      while (at < lines.length && /^\s*(#!|["']use strict["'];?|import\s|const .*= require\(|\/\/)/.test(lines[at])) at++;
      lines.splice(at, 0, imp);
    }
    const after = lines.join("\n");
    changed.push({ path: f.path, before: f.content, after });
  }
  return changed;
}

function analyzeRegex(ev, files) {
  let m = null;
  for (const src of [ev.error, ev.title, ev.stack, ev.text]) {
    for (const line of String(src || "").split("\n")) {
      m = line.match(MSG_RE);
      if (m) break;
    }
    if (m) break;
  }
  if (!m) return null;
  const [, pattern, flags, reasonRaw] = m;
  const reason = reasonRaw.replace(/["'}\s]+$/, "").trim();

  const facts = [];
  const checks = [];
  const reproduced = compileError(pattern, flags);
  checks.push({
    name: "Reproduce the error",
    status: reproduced && reproduced.includes(reason.split(" ")[0]) ? "pass" : "fail",
    detail: reproduced
      ? `new RegExp(${JSON.stringify(pattern)}${flags ? ", " + JSON.stringify(flags) : ""}) fails here too: ${reproduced}`
      : `the pattern ${JSON.stringify(pattern)} compiles on this runtime — the alert may come from a different engine`,
  });

  const culprits = locateCulprit(pattern, reason);
  const main = culprits[0];
  const pointer = main ? `${pattern}\n${" ".repeat(main.index)}^` : null;
  if (main) facts.push(`'${main.char}' at index ${main.index} of the pattern: ${main.why}`);
  facts.push(`engine message: "${reason}"`);
  if (ev.frames.length === 0) facts.push("no stack trace in the alert: the code that builds this RegExp is unknown");

  // What the title claims vs what the error proves
  let titleCheck = null;
  for (const w of CHAR_WORDS) {
    if (w.re.test(ev.title) && main && w.char !== main.char) {
      titleCheck =
        `The title blames '${w.char}', but the error is caused by '${main.char}' at index ${main.index}. ` +
        (w.char === "/" ? "Inside new RegExp(\"...\") a '/' is an ordinary character; it only needs escaping in a /literal/." : "");
      break;
    }
  }
  const lib = ESCAPERS.find((n) => ev.title.includes(n) || ev.text.includes(n));
  const escaped = escapeLikeLibrary(pattern);
  const escapedErr = compileError(escaped, flags);
  const literalMatches = !escapedErr && new RegExp(escaped, flags.replace(/[gy]/g, "")).test(pattern);
  checks.push({
    name: "Escaped input compiles and matches itself",
    status: !escapedErr && literalMatches ? "pass" : "fail",
    detail: !escapedErr
      ? `escapeStringRegexp(${JSON.stringify(pattern)}) = ${JSON.stringify(escaped)} compiles and ${literalMatches ? "matches the original text literally" : "does not match it"}`
      : `escaped pattern still fails: ${escapedErr}`,
  });
  if (lib) {
    facts.push(`${lib} escapes '(' correctly (checked above), so this text reached RegExp without going through it`);
  }

  const rootCause =
    `The text ${JSON.stringify(pattern)} was used as a regular expression without escaping. ` +
    (main ? `Its '${main.char}' at index ${main.index} ${main.why.replace(/^it /, "")}, so the RegExp constructor throws "${reason}". ` : `The RegExp constructor throws "${reason}". `) +
    (lib ? `Nothing needs to change in ${lib}: the call site has to pass the text through it before building the RegExp.` : "Escape the text where the RegExp is built.");

  const fixPlan = [
    "Find where the code builds a RegExp from this text (search for `new RegExp(` with a variable argument)" +
      (ev.frames.length ? "." : " — the alert has no stack trace, so attach the stack or the file to locate it."),
    `Wrap that argument: new RegExp(escapeStringRegexp(text)) — keep ${lib || "escape-string-regexp"} as it is.`,
    "If the text is meant to be a real pattern (not a literal), validate it with try/catch and reject it with a clear error instead.",
    "Add the regression test below so this input stays covered.",
  ];

  let patch;
  const changed = patchCallSites(files || []);
  if (changed.length) {
    const diff = changed.map((c) => unifiedDiff(c.path, c.before, c.after)).join("");
    for (const c of changed) {
      const s = syntaxCheck(c.after, c.path);
      checks.push({ name: `Patched ${c.path} parses`, status: !s.checked ? "skipped" : s.ok ? "pass" : "fail", detail: s.checked ? s.error || "syntax OK" : s.reason });
    }
    patch = { kind: "diff", diff, files: changed.map((c) => c.path), note: "Applies to the attached code with `git apply`." };
  } else {
    patch = {
      kind: "snippet",
      diff:
        "--- a/<file that builds the RegExp>\n+++ b/<file that builds the RegExp>\n" +
        "-const re = new RegExp(text);\n+const re = new RegExp(escapeStringRegexp(text));\n",
      note: files && files.length
        ? "No dynamic `new RegExp(...)` call found in the attached code."
        : "No code attached: this is the change to make at the call site. Attach the file (or the stack) to get an exact diff.",
    };
  }

  const test = {
    path: "test/regex-input.regression.test.cjs",
    run: "node --test test/regex-input.regression.test.cjs",
    content:
      `// Added by Nightcall: the input from the alert must never crash RegExp again.\n` +
      `const test = require("node:test");\nconst assert = require("node:assert/strict");\n\n` +
      `const input = ${JSON.stringify(pattern)};\n\n` +
      `test("raw input is not a valid pattern (reproduces the alert)", () => {\n` +
      `  assert.throws(() => new RegExp(input${flags ? ", " + JSON.stringify(flags) : ""}), /${reason.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}/);\n});\n\n` +
      `test("escaped input compiles and matches itself literally", async () => {\n` +
      `  const { default: escapeStringRegexp } = await import("escape-string-regexp");\n` +
      `  assert.ok(new RegExp(escapeStringRegexp(input)).test(input));\n});\n`,
  };

  const hasLocation = changed.length > 0 || ev.frames.length > 0;
  return {
    analyzer: "regex-syntax",
    root_cause: rootCause,
    title_check: titleCheck,
    pointer,
    facts,
    checks,
    confidence: {
      cause: reproduced ? "high" : "medium",
      location: changed.length ? "high" : ev.frames.length ? "medium" : "low",
      reasons: [
        reproduced ? "the compile error was reproduced locally from the pattern in the message" : "the pattern did not reproduce here",
        changed.length ? "the call site was found in the attached code" : ev.frames.length ? "the stack points at the call site" : "no stack trace and no code: where the RegExp is built is unknown",
      ],
    },
    fix_plan: fixPlan,
    patch,
    regression_test: test,
    needs: hasLocation ? [] : ["the stack trace or the file that builds the RegExp, to turn the snippet into an exact diff"],
    reproduced: Boolean(reproduced),
    reproduced_scope: "only the RegExp compilation was reproduced (pattern from the message); no application code was run",
  };
}

module.exports = { analyzeRegex, locateCulprit, escapeLikeLibrary, patchCallSites };
