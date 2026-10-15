#!/usr/bin/env node
"use strict";
// Nightcall triage executa (protocol v2).
// Deterministic analyzers handle the alert classes they know (same input →
// same answer); Anna's LLM, via sampling, covers the rest. Attached code
// (pasted or from a public GitHub repo) turns the fix into an applicable
// unified diff plus a regression test. User code is never executed.
const readline = require("readline");
const crypto = require("crypto");
const { triage } = require("./lib/triage");

const VERSION = "0.4.0";

const MANIFEST = {
  name: "nightcall",
  display_name: "Nightcall",
  version: VERSION,
  description:
    "Triage a production alert: deterministic analyzers reproduce what can be reproduced (e.g. RegExp compile errors) and trace bad values to their origin; with the code attached it returns a unified diff and a regression test. Anna's LLM covers other errors. User code is never executed.",
  author: "alfredoantonio.decandia@gmail.com",
  host_capabilities: ["llm.sample"],
  tools: [
    {
      name: "triage_alert",
      description:
        "Analyze a production alert. Returns root cause, title-vs-error check, calibrated confidence with reasons, fix plan, a unified diff when code is attached, a regression test, and what to attach for a better answer.",
      parameters: [
        { name: "alert", type: "string", description: "Alert JSON or free text (title, error, service, stack trace)", required: true },
        { name: "code", type: "string", description: "Optional: files from the stack, each starting with a line `// file: path/to/file.js`", required: false },
        { name: "repo", type: "string", description: "Optional: public GitHub repo URL to fetch the files named in the stack", required: false },
        { name: "ref", type: "string", description: "Optional: branch, tag or commit for repo (default HEAD)", required: false },
      ],
    },
  ],
};

// ---- sampling (reverse RPC to the host) -----------------------------------
const pending = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sampler(invokeId) {
  if (!invokeId) return null;
  return (text) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.floor(Math.random() * 1e9);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("sampling timeout waiting for host"));
      }, 75000);
      pending.set(id, (resp) => {
        clearTimeout(timer);
        if (resp.error) {
          const name = (resp.error.data && resp.error.data.errorCode) || resp.error.message;
          return reject(new Error("sampling failed: " + name));
        }
        const r = resp.result || {};
        const content = r.content && (r.content.text != null ? r.content.text : Array.isArray(r.content) ? r.content.map((c) => c.text || "").join("") : "");
        resolve({ text: content || "", model: r.model || null });
      });
      send({
        jsonrpc: "2.0",
        id,
        method: "sampling/createMessage",
        params: {
          messages: [{ role: "user", content: { type: "text", text } }],
          maxTokens: 1400,
          systemPrompt: "You analyze production alerts precisely and reply with a JSON object only.",
          temperature: 0,
          includeContext: "none",
          responseFormat: { type: "json_object" },
          onUnsupported: "json_object",
          metadata: { executa_invoke_id: invokeId },
        },
      });
    });
}

// ---- stdio loop: host responses (no method) vs requests ---------------------
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  if (!req.method) {
    const resolve = pending.get(req.id);
    if (resolve) {
      pending.delete(req.id);
      resolve(req);
    }
    return;
  }
  (async () => {
    try {
      if (req.method === "describe") return send({ jsonrpc: "2.0", id: req.id, result: MANIFEST });
      if (req.method === "health") return send({ jsonrpc: "2.0", id: req.id, result: { status: "ready", version: VERSION } });
      if (req.method === "initialize") {
        return send({
          jsonrpc: "2.0",
          id: req.id,
          result: { protocolVersion: "2.0", serverInfo: { name: "nightcall", version: VERSION }, capabilities: { sampling: {} } },
        });
      }
      if (req.method === "invoke") {
        const params = req.params || {};
        const tool = params.tool || params.method;
        const args = params.arguments || params.args || {};
        if (tool !== "triage_alert") throw Object.assign(new Error("unknown tool: " + tool), { code: -32601 });
        if (!String(args.alert || "").trim()) throw Object.assign(new Error("alert is required"), { code: -32602 });
        const context = params.context || {};
        const data = await triage(args, { sample: sampler(context.invoke_id) });
        return send({ jsonrpc: "2.0", id: req.id, result: { success: true, data: { version: VERSION, ...data } } });
      }
      return send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "unknown method: " + req.method } });
    } catch (e) {
      send({ jsonrpc: "2.0", id: req.id, error: { code: e.code || -32603, message: e.message } });
    }
  })();
});
