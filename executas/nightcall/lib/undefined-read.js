"use strict";
// "Cannot read properties of undefined (reading 'x')" alerts.
// The stack names the failing read; attached code lets us find WHICH value is
// undefined and where it comes from, and patch the origin instead of hiding
// the error with optional chaining.
const { findFile, syntaxCheck, unifiedDiff } = require("./code");

const READ_RES = [
  /Cannot read propert(?:y|ies) of (undefined|null) \(reading ['"`]([^'"`]+)['"`]\)/,
  /Cannot read property ['"`]([^'"`]+)['"`] of (undefined|null)/,
  /undefined is not an object \(evaluating ['"`]([^'"`]+)['"`]\)/,
];

function matchRead(text) {
  let m = text.match(READ_RES[0]);
  if (m) return { nullish: m[1], field: m[2] };
  m = text.match(READ_RES[1]);
  if (m) return { nullish: m[2], field: m[1] };
  m = text.match(READ_RES[2]);
  if (m) return { nullish: "undefined", field: m[1].split(".").pop(), expr: m[1] };
  return null;
}

const ident = "[A-Za-z_$][\\w$]*";

/** The member expression right before `.field` on a line, e.g. `session.user` in `session.user.id`. */
function readTarget(line, field) {
  const re = new RegExp(`(${ident}(?:(?:\\?\\.|\\.)${ident})*)\\s*(?:\\?\\.|\\.)${field.replace(/[$]/g, "\\$")}\\b`);
  const m = line.match(re);
  return m ? m[1].replace(/\?\./g, ".") : null;
}

/** Parameter names of `name` as declared in `content` (simple params only). */
function functionParams(content, name) {
  const n = name.split(".").pop().replace(/[$]/g, "\\$");
  const patterns = [
    new RegExp(`function\\s*\\*?\\s*${n}\\s*\\(([^)]*)\\)`),
    new RegExp(`\\b${n}\\s*[:=]\\s*(?:async\\s+)?function\\s*\\*?\\s*\\(([^)]*)\\)`),
    new RegExp(`\\b${n}\\s*[:=]\\s*(?:async\\s+)?\\(([^)]*)\\)\\s*=>`),
    new RegExp(`\\b${n}\\s*[:=]\\s*(?:async\\s+)?(${ident})\\s*=>`),
    new RegExp(`^\\s*(?:async\\s+)?${n}\\s*\\(([^)]*)\\)\\s*\\{`, "m"),
  ];
  for (const re of patterns) {
    const m = content.match(re);
    if (m) {
      const params = m[1].split(",").map((p) => p.trim().replace(/\s*=.*$/, "")).filter(Boolean);
      const isAsync = new RegExp(`async\\s+function\\s*${n}\\b|\\b${n}\\s*[:=]\\s*async\\b|^\\s*async\\s+${n}\\s*\\(`, "m").test(content);
      return { params, simple: params.every((p) => new RegExp(`^${ident}$`).test(p)), isAsync };
    }
  }
  return null;
}

/** Arguments of the first `name(...)` call on a line (balanced parentheses). */
function callArgs(line, name) {
  const short = name.split(".").pop();
  const at = line.search(new RegExp(`\\b${short.replace(/[$]/g, "\\$")}\\s*\\(`));
  if (at < 0) return null;
  let i = line.indexOf("(", at) + 1;
  let depth = 1;
  let cur = "";
  const args = [];
  for (; i < line.length && depth > 0; i++) {
    const c = line[i];
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (depth === 0) break;
    if (c === "," && depth === 1) {
      args.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

function indentOf(line) {
  return (line.match(/^\s*/) || [""])[0];
}

const AUTHY = /user|session|auth|token|account|login|principal/i;

function exportsName(content, name) {
  const n = name.split(".").pop();
  return new RegExp(`module\\.exports\\s*=\\s*\\{[^}]*\\b${n}\\b|exports\\.${n}\\s*=|export\\s+(async\\s+)?function\\s+${n}\\b|export\\s+(const|let)\\s+${n}\\b|export\\s*\\{[^}]*\\b${n}\\b`).test(content);
}

function relImport(fromTestDir, target) {
  return "../" + target.replace(/^\/+/, "");
}

/** Deterministic patch: guard the origin in the caller, fail loudly in the callee. */
function buildPatch(ev, read, files) {
  const top = ev.appFrames[0];
  const caller = ev.appFrames[1];
  const topFile = top && findFile(files, top.file);
  if (!topFile) return null;
  const topLines = topFile.content.split("\n");
  const failing = topLines[top.line - 1];
  if (failing == null) return { problem: `${topFile.path} has no line ${top.line}` };
  const target = read.expr ? read.expr.split(".").slice(0, -1).join(".") : readTarget(failing, read.field);
  if (!target) return { problem: `no '.${read.field}' read found on ${topFile.path}:${top.line}` };

  const fn = top.function.split(".").pop();
  const sig = functionParams(topFile.content, fn);
  const root = target.split(".")[0];
  const paramIndex = sig && sig.simple ? sig.params.indexOf(root) : -1;
  const changes = [];
  const facts = [];

  // 1) callee: fail with a message that names the missing value
  const guardExpr = target.split(".").join("?.");
  const msg = `${fn}: ${target} is missing` + (paramIndex >= 0 ? "; the caller must check it before calling " + fn : "");
  const calleeGuard = `${indentOf(failing)}if (${guardExpr} == null) throw new Error(${JSON.stringify(msg)});`;
  const newTop = [...topLines];
  newTop.splice(top.line - 1, 0, calleeGuard);
  changes.push({ path: topFile.path, before: topFile.content, after: newTop.join("\n") });
  facts.push(`${topFile.path}:${top.line} reads '${read.field}' from ${target} — that value is ${read.nullish}`);

  // 2) caller: stop the request where the value comes from
  let origin = null;
  if (paramIndex >= 0 && caller) {
    const callerFile = findFile(files, caller.file);
    const callerLines = callerFile && callerFile.content.split("\n");
    const callLine = callerLines && callerLines[caller.line - 1];
    const args = callLine && callArgs(callLine, fn);
    if (args && args[paramIndex]) {
      const arg = args[paramIndex];
      const rest = target.split(".").slice(1);
      origin = rest.length ? `${arg}.${rest.join(".")}` : arg;
      facts.push(`${caller.function} (${callerFile.path}:${caller.line}) passes ${arg} as '${root}', so the missing value is ${origin}`);
      const check = rest.length ? `${arg}?.${rest.join("?.")}` : arg;
      const authy = AUTHY.test(origin);
      const status = authy ? 401 : 400;
      const errText = authy ? "not signed in" : `missing ${origin.split(".").pop()}`;
      const usesRes = /\bres\.status\(/.test(callerFile.content) && /\(\s*req\s*,\s*res\b/.test(callerFile.content);
      const ind = indentOf(callLine);
      const body = usesRes
        ? `${ind}  return res.status(${status}).json({ error: ${JSON.stringify(errText)} });`
        : `${ind}  throw Object.assign(new Error(${JSON.stringify(errText)}), { status: ${status} });`;
      const guard = [`${ind}if (!${check}) {`, body, `${ind}}`];
      if (callerFile.path === topFile.path) {
        // same file: apply on top of the callee change (the callee guard sits below or above)
        const base = changes[0].after.split("\n");
        const shift = caller.line > top.line ? 1 : 0;
        base.splice(caller.line - 1 + shift, 0, ...guard);
        changes[0].after = base.join("\n");
      } else {
        const after = [...callerLines];
        after.splice(caller.line - 1, 0, ...guard);
        changes.push({ path: callerFile.path, before: callerFile.content, after: after.join("\n") });
      }
    } else if (!callerFile) {
      facts.push(`attach ${caller.file} to also patch the caller ${caller.function}`);
    }
  } else if (paramIndex < 0) {
    facts.push(`${target} is not a parameter of ${fn}: it is produced inside ${fn} (e.g. a lookup that found nothing)`);
  }

  // regression test: the callee must fail with the clear message, never a TypeError
  let test = null;
  if (exportsName(topFile.content, fn) && sig && sig.simple) {
    const args = sig.params.map((p, k) => (k === paramIndex ? (target.includes(".") ? "{}" : "undefined") : "undefined"));
    const call = `${fn}(${args.join(", ")})`;
    const assertion = sig.isAsync
      ? `await assert.rejects(() => ${call}, /${target.replace(/\./g, "\\.")} is missing/);`
      : `assert.throws(() => ${call}, /${target.replace(/\./g, "\\.")} is missing/);`;
    const base = topFile.path.split("/").pop().replace(/\.(c|m)?js$/, "");
    test = {
      path: `test/${base}.regression.test.cjs`,
      run: `node --test test/${base}.regression.test.cjs`,
      content:
        `// Added by Nightcall: ${fn} must name the missing value instead of crashing with a TypeError.\n` +
        `const test = require("node:test");\nconst assert = require("node:assert/strict");\n` +
        `const path = require("node:path");\nconst { pathToFileURL } = require("node:url");\n\n` +
        `test("${fn} fails clearly when ${target} is missing", async () => {\n` +
        `  const mod = await import(pathToFileURL(path.join(__dirname, ${JSON.stringify(relImport("test", topFile.path))})).href);\n` +
        `  const ${fn} = mod.${fn} || (mod.default && mod.default.${fn});\n` +
        `  ${assertion}\n});\n`,
    };
  }
  return { changes, facts, origin, target, test };
}

function analyzeUndefinedRead(ev, files) {
  const read = matchRead([ev.error, ev.title, ev.stack].filter(Boolean).join("\n"));
  if (!read) return null;
  const top = ev.appFrames[0];
  const caller = ev.appFrames[1];
  const facts = [];
  const checks = [];
  if (top) facts.push(`failing read: ${top.function} at ${top.file}:${top.line}:${top.column}`);
  if (caller) facts.push(`called from: ${caller.function} at ${caller.file}:${caller.line}`);
  if (!top) facts.push("no application frame in the stack: the failing line is unknown");
  if (ev.service) facts.push(`service: ${ev.service}`);

  const p = top && files && files.length ? buildPatch(ev, read, files) : null;
  let patch;
  let test = null;
  let rootCause;
  if (p && p.changes) {
    facts.push(...p.facts);
    let diff = "";
    for (const c of p.changes) {
      diff += unifiedDiff(c.path, c.before, c.after);
      const s = syntaxCheck(c.after, c.path);
      checks.push({ name: `Patched ${c.path} parses`, status: !s.checked ? "skipped" : s.ok ? "pass" : "fail", detail: s.checked ? s.error || "syntax OK (parsed, not run)" : s.reason });
    }
    const failingLine = p.changes[0].after.split("\n")[top.line]; // original failing line, now one below the guard
    checks.push({
      name: "Fix is not optional chaining on the failing read",
      status: failingLine && failingLine.includes(`?.${read.field}`) ? "fail" : "pass",
      detail: "the failing line is kept as is; a guard names the missing value instead of silently skipping it",
    });
    patch = { kind: "diff", diff, files: p.changes.map((c) => c.path), note: "Applies to the attached code with `git apply`. Not run: run your tests after applying." };
    test = p.test;
    rootCause =
      `In ${top.function} (${top.file}:${top.line}), ${p.target} is ${read.nullish}, so reading '${read.field}' throws. ` +
      (p.origin
        ? `${top.function} gets it from ${caller.function} (${caller.file}:${caller.line}) as ${p.origin}: the request reached that point without it` +
          (AUTHY.test(p.origin) ? " (no signed-in user)." : ".")
        : `${p.target} is produced inside ${top.function}, so the lookup that sets it returned nothing.`) +
      ` Optional chaining at line ${top.line} would only hide this: the code would carry on without the value.`;
  } else {
    if (p && p.problem) facts.push(p.problem);
    rootCause = top
      ? `${top.function} (${top.file}:${top.line}) reads '${read.field}' from a value that is ${read.nullish}. ` +
        (caller
          ? `${top.function} is called by ${caller.function} (${caller.file}:${caller.line}), so that value is either passed in as ${read.nullish} by ${caller.function} or produced inside ${top.function} by a lookup that found nothing. `
          : "") +
        `Optional chaining on that read would only hide the error, not fix where the ${read.nullish} value comes from.`
      : `Code reads '${read.field}' from a ${read.nullish} value, but the stack has no application frame to say where.`;
    patch = {
      kind: "none",
      note: files && files.length
        ? "The attached code does not contain the failing line; attach " + [top, caller].filter(Boolean).map((f) => f.file).join(" and ") + "."
        : "No code attached. Attach " + ([top, caller].filter(Boolean).map((f) => `${f.file}`).join(" and ") || "the failing file") + " (paste or GitHub URL) to get an exact diff and a regression test.",
    };
  }

  const fixPlan = top
    ? [
        caller
          ? `In ${caller.function} (${caller.file}:${caller.line}), check the value passed to ${top.function} and stop with an explicit error (e.g. 401/400) when it is missing — this is where the bad state enters.`
          : `Find where the value read at ${top.file}:${top.line} is set and handle the missing case there.`,
        `In ${top.function} (${top.file}:${top.line}), throw an error that names the missing value instead of letting a TypeError escape.`,
        `Do not replace the read with optional chaining: ${read.field} would become undefined and the request would continue without it.`,
        "Add a regression test that calls the code without that value.",
      ]
    : ["Capture a stack trace with application frames, then follow the value being read back to where it is set."];

  const withCode = Boolean(p && p.changes);
  return {
    analyzer: "undefined-read",
    root_cause: rootCause,
    title_check: null,
    pointer: null,
    facts,
    checks,
    confidence: {
      cause: withCode ? "high" : top ? "medium" : "low",
      location: withCode ? "high" : top ? "medium" : "low",
      reasons: [
        top ? `the stack pinpoints the failing read at ${top.file}:${top.line}` : "no application frame in the stack",
        withCode ? "the undefined value and its origin were found in the attached code" : "without the code, which value is undefined (and why) cannot be confirmed",
        "nothing was executed: the patch is checked for syntax, not run",
      ],
    },
    fix_plan: fixPlan,
    patch,
    regression_test: test,
    needs: withCode ? [] : top ? [`code of ${[top, caller].filter(Boolean).map((f) => f.file).join(" and ")}`] : ["a stack trace with application frames"],
    reproduced: false,
    reproduced_scope: "nothing was reproduced: this analysis reads the stack and the attached code",
  };
}

module.exports = { analyzeUndefinedRead, matchRead, readTarget, functionParams, callArgs };
