"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { triage } = require("../lib/triage");
const { applyDiff, unifiedDiff, parsePastedCode, syntaxCheck } = require("../lib/code");
const { locateCulprit } = require("../lib/regex");

// The two alerts the Anna reviewers used, verbatim.
const ALERT_A =
  '{"title":"escape-string-regexp fails on unescaped slash","service":"web","error":"SyntaxError: Invalid regular expression: /a/b(/: Unterminated group"}';
const ALERT_B =
  '{"title":"TypeError: Cannot read properties of undefined (reading \'id\')","service":"checkout-api","stack":"at getUser (src/user.js:42:18)\\n at handler (src/checkout.js:17:5)"}';

const SAMPLES = path.join(__dirname, "..", "samples");
const sampleCode = (name) => {
  const dir = path.join(SAMPLES, name, "src");
  return fs.readdirSync(dir).map((f) => `// file: src/${f}\n` + fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
};

// A nested `node --test` inherits NODE_TEST_CONTEXT from this runner and then
// always exits 0; drop it so the child's exit code means pass/fail.
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
const runTest = (dir, file) => spawnSync(process.execPath, ["--test", file], { cwd: dir, encoding: "utf8", env: CHILD_ENV });

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

function patchedTree(files, diff) {
  // apply every file section of a multi-file diff
  const out = { ...files };
  for (const part of diff.split(/^(?=--- a\/)/m).filter(Boolean)) {
    const p = part.match(/^--- a\/(\S+)/)[1];
    out[p] = applyDiff(files[p], part);
  }
  return out;
}

const ESCAPE_STUB = {
  "node_modules/escape-string-regexp/package.json": '{"name":"escape-string-regexp","main":"index.js"}',
  "node_modules/escape-string-regexp/index.js":
    "module.exports = (s) => s.replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&').replace(/-/g, '\\\\x2d');\n",
};

test("Test A: the real cause is the unescaped '(' — not the slash, not the library", async () => {
  const r = await triage({ alert: ALERT_A });
  assert.equal(r.analyzer, "regex-syntax");
  assert.match(r.root_cause, /'\(' at index 3/);
  assert.match(r.root_cause, /Nothing needs to change in escape-string-regexp/);
  assert.match(r.title_check, /title blames '\/'/);
  assert.equal(r.checks.find((c) => c.name === "Reproduce the error").status, "pass");
  // no stack, no code: the location is unknown, so overall confidence is low
  assert.equal(r.confidence_detail.cause, "high");
  assert.equal(r.confidence_detail.location, "low");
  assert.equal(r.confidence, "low");
  assert.equal(r.patch.kind, "snippet");
  assert.ok(r.needs.length > 0);
  assert.doesNotMatch(r.fix_plan.join(" "), /edit (the )?escape-string-regexp/i);
});

test("Test B: stable answer that traces the undefined value instead of masking it", async () => {
  const a = await triage({ alert: ALERT_B });
  const b = await triage({ alert: ALERT_B });
  assert.deepEqual(a, b, "same alert, same answer");
  assert.equal(a.analyzer, "undefined-read");
  assert.match(a.root_cause, /handler \(src\/checkout\.js:17\)/);
  assert.match(a.root_cause, /Optional chaining .* would only hide/);
  assert.match(a.fix_plan.join("\n"), /Do not replace the read with optional chaining/);
  assert.equal(a.confidence, "medium");
  assert.equal(a.patch.kind, "none");
  assert.match(a.patch.note, /Attach src\/user\.js and src\/checkout\.js/);
});

test("Test B + code: the diff applies, parses, and turns the regression test from red to green", async () => {
  const r = await triage({ alert: ALERT_B, code: sampleCode("checkout") });
  assert.equal(r.patch.kind, "diff");
  assert.deepEqual(r.patch.files, ["src/user.js", "src/checkout.js"]);
  assert.match(r.patch.diff, /\+\s+if \(!req\.session\?\.user\) \{/);
  assert.match(r.patch.diff, /return res\.status\(401\)/);
  assert.doesNotMatch(r.patch.diff, /\+.*session\?\.user\?\.id/);
  assert.ok(r.checks.every((c) => c.status === "pass"), JSON.stringify(r.checks));
  assert.ok(r.regression_test);

  const original = Object.fromEntries(parsePastedCode(sampleCode("checkout")).map((f) => [f.path, f.content]));
  const fixed = patchedTree(original, r.patch.diff);
  const run = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightcall-"));
    writeTree(dir, { ...files, [r.regression_test.path]: r.regression_test.content });
    return runTest(dir, r.regression_test.path);
  };
  assert.notEqual(run(original).status, 0, "red before the patch");
  assert.equal(run(fixed).status, 0, "green after the patch");

  // and the handler now answers 401 instead of crashing
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightcall-"));
  writeTree(dir, fixed);
  const { handler } = require(path.join(dir, "src/checkout.js"));
  const res = { statusCode: 0, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  await handler({ session: {}, body: { items: [{ sku: "a", price: 1, qty: 1 }] } }, res);
  assert.equal(res.statusCode, 401);
});

test("Test A + code: escapes the call site and the generated test goes green", async () => {
  const r = await triage({ alert: ALERT_A, code: sampleCode("search") });
  assert.equal(r.patch.kind, "diff");
  assert.match(r.patch.diff, /\+  const re = new RegExp\(escapeStringRegexp\(query\), "gi"\);/);
  assert.equal(r.confidence, "high");
  const original = Object.fromEntries(parsePastedCode(sampleCode("search")).map((f) => [f.path, f.content]));
  const fixed = patchedTree(original, r.patch.diff);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nightcall-"));
  writeTree(dir, { ...fixed, ...ESCAPE_STUB, [r.regression_test.path]: r.regression_test.content });
  const run = runTest(dir, r.regression_test.path);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const { highlight } = require(path.join(dir, "src/search.js"));
  assert.equal(highlight("a/b( found", "a/b("), "<mark>a/b(</mark> found");
});

test("stack frames with aliases and node: paths are parsed (and marked as library)", () => {
  const { parseFrames } = require("../lib/alert");
  const frames = parseFrames(
    "Error: x\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1606:16)\n    at async run (/app/src/jobs/pay.js:12:7)\n    at /app/src/index.js:3:1",
  );
  assert.deepEqual(frames.map((f) => [f.function, f.file, f.line, f.library]), [
    ["TCPConnectWrap.afterConnect", "node:net", 1606, true],
    ["run", "/app/src/jobs/pay.js", 12, false],
    ["<anonymous>", "/app/src/index.js", 3, false],
  ]);
});

test("regex scanner points at the right character", () => {
  assert.deepEqual(locateCulprit("a/b(", "Unterminated group").map((c) => c.index), [3]);
  assert.equal(locateCulprit("a)b", "Unmatched ')'")[0].char, ")");
  assert.equal(locateCulprit("[abc", "Unterminated character class")[0].char, "[");
  assert.equal(locateCulprit("*a", "Nothing to repeat")[0].index, 0);
  assert.equal(locateCulprit("a\\(b", "x").length, 0);
});

test("unified diff round-trips and syntax check catches broken code", () => {
  const before = "a\nb\nc\nd\n";
  const after = "a\nB\nc\nd\ne\n";
  assert.equal(applyDiff(before, unifiedDiff("f.js", before, after)), after);
  assert.equal(syntaxCheck("const x = ;", "x.js").ok, false);
  assert.equal(syntaxCheck("import a from 'b';\nexport const c = await a();\n", "m.mjs").ok, true);
  assert.equal(syntaxCheck("x", "a.py").checked, false);
});

test("other alerts go to Anna's LLM, with library edits refused and confidence capped", async () => {
  const alert = '{"title":"Payment timeout","error":"Error: ETIMEDOUT connecting to payments"}';
  const sample = async () => ({
    model: "mock",
    text: JSON.stringify({ root_cause: "Patch node_modules/axios to raise the timeout", fix_plan: ["edit the library"], confidence: "high", evidence_used: ["ETIMEDOUT"], edits: [] }),
  });
  const r = await triage({ alert }, { sample });
  assert.equal(r.analyzer, "anna-llm");
  assert.equal(r.confidence, "low", "no stack trace and a library edit: low");
  assert.ok(r.checks.some((c) => c.name === "Fix targets the caller, not a dependency" && c.status === "fail"));

  const noLlm = await triage({ alert });
  assert.equal(noLlm.analyzer, "basic");
  assert.equal(noLlm.confidence, "low");
});

test("protocol: describe, invoke with a sampling round trip, and errors", async () => {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "plugin.js")], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  const waiters = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      // answer sampling requests like the Anna host would
      if (msg.method === "sampling/createMessage") {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { model: "host-model", content: { type: "text", text: '{"root_cause":"ok","fix_plan":[],"confidence":"low","evidence_used":[],"edits":[]}' } } }) + "\n");
        continue;
      }
      lines.push(msg);
      waiters.splice(0).forEach((w) => w());
    }
  });
  const call = async (obj) => {
    child.stdin.write(JSON.stringify(obj) + "\n");
    while (!lines.some((l) => l.id === obj.id)) await new Promise((r) => waiters.push(r));
    return lines.find((l) => l.id === obj.id);
  };
  const d = await call({ jsonrpc: "2.0", id: 1, method: "describe" });
  assert.equal(d.result.version, "0.4.1");
  const a = await call({ jsonrpc: "2.0", id: 2, method: "invoke", params: { tool: "triage_alert", arguments: { alert: ALERT_A }, context: { invoke_id: "x" } } });
  assert.equal(a.result.data.analyzer, "regex-syntax");
  const g = await call({ jsonrpc: "2.0", id: 3, method: "invoke", params: { tool: "triage_alert", arguments: { alert: "Error: disk full" }, context: { invoke_id: "y" } } });
  assert.equal(g.result.data.model, "host-model");
  const e = await call({ jsonrpc: "2.0", id: 4, method: "invoke", params: { tool: "triage_alert", arguments: { alert: " " } } });
  assert.equal(e.error.code, -32602);
  child.kill();
});
