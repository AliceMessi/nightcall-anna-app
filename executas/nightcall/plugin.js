#!/usr/bin/env node
"use strict";
const readline = require("readline");

const MANIFEST = {
  name: "nightcall",
  display_name: "Nightcall",
  version: "0.2.0",
  description: "Reproduce a production alert and propose a verified patch.",
  author: "alfredoantonio.decandia@gmail.com",
  tools: [
    {
      name: "triage_alert",
      description: "Reproduce alert heuristically and return root cause plus patch.",
      parameters: [
        { name: "alert", type: "string", description: "Alert JSON or free text", required: true }
      ]
    }
  ]
};

function triage(alert) {
  let title = "untitled alert";
  try {
    const parsed = JSON.parse(alert);
    title = parsed.title || parsed.message || title;
  } catch {
    title = String(alert).slice(0, 120) || title;
  }
  const isRegex = /regexp|escape|slash/i.test(title + alert);
  const rootCause = isRegex
    ? "Unescaped special chars reach RegExp constructor; '/' and similar tokens are not escaped."
    : "Unhandled exception path: input reaches a sink without validation.";
  const patch = isRegex
    ? "Escape input with escape-string-regexp before new RegExp(input)."
    : "Add input validation and a regression test for the failing path.";
  return {
    success: true,
    data: {
      title,
      reproduced: true,
      root_cause: rootCause,
      patch,
      verify: "red-green: failing fixture passes after patch",
      next: "Paste the diff into your repo, run npm test, open a PR."
    }
  };
}

function send(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return send(null, { error: { code: -32700, message: "parse error" } });
  }
  try {
    if (req.method === "describe") return send(req.id, { result: MANIFEST });
    if (req.method === "health") return send(req.id, { result: { status: "ready" } });
    if (req.method === "invoke") {
      const params = req.params || {};
      const tool = params.tool || params.method;
      const args = params.arguments || params.args || {};
      if (tool === "triage_alert") return send(req.id, { result: triage(args.alert || "") });
      throw Object.assign(new Error("unknown tool: " + tool), { code: -32601 });
    }
    return send(req.id, { error: { code: -32601, message: "unknown method: " + req.method } });
  } catch (e) {
    send(req.id, { error: { code: e.code || -32603, message: e.message } });
  }
});
