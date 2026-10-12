#!/usr/bin/env node
"use strict";
// Nightcall triage executa (protocol v2).
// Real work: parse the alert, extract concrete evidence (error type, stack
// frames, identifiers, service) and ask Anna's LLM via sampling/createMessage
// to analyze THAT alert. No API keys: billing/model handled by the host.
// Honesty: nothing is executed here — no code, no tests, no reproduction.
// Results always carry reproduced:false / verified:false plus analysis_basis.
const readline = require("readline");
const crypto = require("crypto");

const VERSION = "0.3.0";

const MANIFEST = {
  name: "nightcall",
  display_name: "Nightcall",
  version: VERSION,
  description: "Analyze a production alert with Anna's LLM and propose a patch. No code is executed; analysis is inference from the alert text.",
  author: "alfredoantonio.decandia@gmail.com",
  host_capabilities: ["llm.sample"],
  tools: [
    {
      name: "triage_alert",
      description: "Analyze a production alert via Anna's LLM; returns root cause, patch, confidence and the evidence used. Inference only — nothing is run.",
      parameters: [
        { name: "alert", type: "string", description: "Alert JSON or free text (title, service, stack trace)", required: true }
      ]
    }
  ]
};

const HONESTY = {
  reproduced: false,
  verified: false,
  analysis_basis: "Inference from the alert text only. No code was executed, no tests were run, nothing was reproduced or verified. Validate the suggestion in your own repo before applying it."
};

// ---- alert parsing: extract concrete, citable evidence --------------------
// tolerant field reader: works even when the alert JSON contains raw
// newlines inside string values (as pasted from real alerts)
function jsonField(text, names) {
  for (const name of names) {
    const re = new RegExp('"' + name + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', "s");
    const m = text.match(re);
    if (m) {
      try {
        return JSON.parse('"' + m[1] + '"');
      } catch {
        return m[1];
      }
    }
  }
  return null;
}

function extractEvidence(raw) {
  const text = String(raw || "");
  let title = jsonField(text, ["title", "message", "error"]);
  let service = jsonField(text, ["service", "serviceName", "app"]);
  let stack = jsonField(text, ["stack", "stacktrace", "trace"]);
  if (title == null) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        title = parsed.title || parsed.message || parsed.error || null;
        service = service || parsed.service || parsed.serviceName || parsed.app || null;
        stack = stack || parsed.stack || parsed.stacktrace || parsed.trace || "";
      }
    } catch { /* free text */ }
  }
  if (title == null || title === "") {
    title = text.split("\n")[0].slice(0, 200) || "untitled alert";
  }
  stack = stack || "";

  const hay = title + "\n" + String(stack || "");
  const errMatch = hay.match(/([A-Za-z_$][\w$]*(?:Error|Exception|Timeout|OOM|panic))/);
  const errorType = errMatch ? errMatch[1] : null;

  const frames = [];
  const frameRe = /at (\S+) \(([^():]+):(\d+):(\d+)\)/g;
  let m;
  while ((m = frameRe.exec(String(stack || ""))) && frames.length < 8) {
    frames.push({ function: m[1], file: m[2], line: Number(m[3]) });
  }

  const accessed = [];
  const readRe = /reading ['"`]([A-Za-z_$][\w$]*)['"`]/g;
  while ((m = readRe.exec(hay)) && accessed.length < 5) {
    if (!accessed.includes(m[1])) accessed.push(m[1]);
  }

  return { title, service, errorType, frames, accessed, text: text.slice(0, 4000) };
}

function evidenceSummary(ev) {
  const parts = [];
  if (ev.errorType) parts.push("error type: " + ev.errorType);
  if (ev.service) parts.push("service: " + ev.service);
  for (const f of ev.frames.slice(0, 4)) parts.push(`${f.function} (${f.file}:${f.line})`);
  for (const a of ev.accessed) parts.push("accessed field: '" + a + "'");
  return parts;
}

// ---- sampling (reverse RPC) ----------------------------------------------
const pending = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function reverseId() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.floor(Math.random() * 1e9);
}

function sampleAlert(invokeId, ev) {
  return new Promise((resolve, reject) => {
    const id = reverseId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject({ code: -32005, message: "sampling timeout waiting for host" });
    }, 75000);
    pending.set(id, {
      resolve: (resp) => {
        clearTimeout(timer);
        if (resp.error) {
          const code = resp.error.code;
          const name = (resp.error.data && resp.error.data.errorCode) || resp.error.message;
          reject({ code, message: "sampling failed: " + name });
        } else {
          resolve(resp.result);
        }
      }
    });
    const evidence = evidenceSummary(ev).join("; ") || "alert text as pasted";
    send({
      jsonrpc: "2.0",
      id,
      method: "sampling/createMessage",
      params: {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                "You are an on-call engineer. Analyze THIS production alert and reply with a JSON object " +
                '{"root_cause": string, "patch": string, "confidence": "low"|"medium"|"high", "evidence_used": string[]}. ' +
                "Rules: cite only concrete details from the alert (error type, function names, file:line, fields, service) " +
                "in evidence_used; root_cause must reference those specifics, never generic phrases; patch must be a minimal " +
                "concrete change naming the actual function/file/field; confidence low unless the stack pinpoints the fault. " +
                "Alert title: " + ev.title + "\n" +
                "Extracted evidence: " + evidence + "\n" +
                "Full alert text:\n" + ev.text
            }
          }
        ],
        maxTokens: 800,
        systemPrompt: "You analyze production alerts precisely and reply with a JSON object only.",
        temperature: 0.2,
        includeContext: "none",
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "nightcall_triage",
            strict: false,
            schema: {
              type: "object",
              properties: {
                root_cause: { type: "string" },
                patch: { type: "string" },
                confidence: { type: "string", enum: ["low", "medium", "high"] },
                evidence_used: { type: "array", items: { type: "string" } }
              },
              required: ["root_cause", "patch", "confidence", "evidence_used"],
              additionalProperties: false
            }
          }
        },
        onUnsupported: "json_object",
        metadata: { executa_invoke_id: invokeId }
      }
    });
  });
}

function parseAnalysis(text) {
  const raw = String((text && text.content && text.content.text) || text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      if (obj && typeof obj.root_cause === "string" && typeof obj.patch === "string") {
        return {
          root_cause: obj.root_cause,
          patch: obj.patch,
          confidence: ["low", "medium", "high"].includes(obj.confidence) ? obj.confidence : "low",
          evidence_used: Array.isArray(obj.evidence_used) ? obj.evidence_used.map(String).slice(0, 10) : []
        };
      }
    } catch { /* fall through */ }
  }
  return null;
}

// ---- heuristic fallback: still cites the alert's own specifics -----------
function heuristic(ev) {
  const used = evidenceSummary(ev);
  let rootCause;
  let patch;
  const top = ev.frames[0];
  if (ev.errorType && /cannot read properties of undefined/i.test(ev.title + ev.text) && top) {
    const field = ev.accessed[0] ? `'${ev.accessed[0]}'` : "a property";
    rootCause =
      `${ev.errorType} in ${top.function} (${top.file}:${top.line}): code reads ${field} ` +
      `from a value that is undefined at that point. Evidence: ` + used.join("; ") + ".";
    patch =
      `Guard the read in ${top.function} (${top.file}:${top.line}): use optional chaining ` +
      `or an explicit null check before accessing ${field}, and trace where the undefined ` +
      `value originates (caller in the stack above). Add a regression test that passes ` +
      `undefined into ${top.function}.`;
  } else if (top) {
    rootCause =
      `${ev.errorType || "Unhandled exception"} in ${top.function} (${top.file}:${top.line}). ` +
      `Evidence: ` + used.join("; ") + ".";
    patch =
      `Inspect ${top.function} at ${top.file}:${top.line}: validate inputs at the top of the ` +
      `function, handle the failing case explicitly, and add a regression test reproducing ` +
      `this stack before fixing.`;
  } else {
    rootCause = `Alert reports: ${ev.title}. Evidence: ` + (used.join("; ") || "title only — no stack frames found") + ".";
    patch = "Add logging around the failing path to capture a stack trace, then guard the failing operation and cover it with a regression test.";
  }
  return { root_cause: rootCause, patch, confidence: "low", evidence_used: used };
}

async function triage(args, context) {
  const ev = extractEvidence(args.alert || "");
  const invokeId = (context && context.invoke_id) || null;
  if (invokeId) {
    try {
      const res = await sampleAlert(invokeId, ev);
      const parsed = parseAnalysis(res);
      const model = res && res.model ? res.model : null;
      if (parsed) {
        return {
          success: true,
          data: {
            title: ev.title,
            service: ev.service,
            error_type: ev.errorType,
            frames: ev.frames,
            root_cause: parsed.root_cause,
            patch: parsed.patch,
            confidence: parsed.confidence,
            evidence_used: parsed.evidence_used.length ? parsed.evidence_used : evidenceSummary(ev),
            analysis_source: "anna-llm",
            model,
            next: "Apply the suggestion in your own repo and run your own tests — nothing was executed here.",
            ...HONESTY
          }
        };
      }
    } catch (e) {
      const h = heuristic(ev);
      return {
        success: true,
        data: {
          title: ev.title,
          service: ev.service,
          error_type: ev.errorType,
          frames: ev.frames,
          root_cause: h.root_cause,
          patch: h.patch,
          confidence: h.confidence,
          evidence_used: h.evidence_used,
          analysis_source: "heuristic-fallback",
          sampling_error: e && e.message ? e.message : String(e),
          next: "Anna's LLM was unreachable for this call; this is a local heuristic citing the alert's own details. Run your own tests before applying.",
          ...HONESTY
        }
      };
    }
  }
  const h = heuristic(ev);
  return {
    success: true,
    data: {
      title: ev.title,
      service: ev.service,
      error_type: ev.errorType,
      frames: ev.frames,
      root_cause: h.root_cause,
      patch: h.patch,
      confidence: h.confidence,
      evidence_used: h.evidence_used,
      analysis_source: "heuristic-fallback",
      sampling_error: "no invoke context (local run without host sampling)",
      next: "Run your own tests before applying — nothing was executed here.",
      ...HONESTY
    }
  };
}

// ---- stdio loop: host responses (no method) vs agent requests ------------
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
    const p = pending.get(req.id);
    if (p) {
      pending.delete(req.id);
      p.resolve(req);
    }
    return;
  }
  (async () => {
    try {
      if (req.method === "describe") return send({ jsonrpc: "2.0", id: req.id, result: MANIFEST });
      if (req.method === "health") return send({ jsonrpc: "2.0", id: req.id, result: { status: "ready" } });
      if (req.method === "initialize") {
        return send({
          jsonrpc: "2.0", id: req.id,
          result: { protocolVersion: "2.0", serverInfo: { name: "nightcall", version: VERSION }, capabilities: { sampling: {} } }
        });
      }
      if (req.method === "invoke") {
        const params = req.params || {};
        const tool = params.tool || params.method;
        const args = params.arguments || params.args || {};
        if (tool === "triage_alert") {
          return send({ jsonrpc: "2.0", id: req.id, result: await triage(args, params.context || {}) });
        }
        throw Object.assign(new Error("unknown tool: " + tool), { code: -32601 });
      }
      return send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "unknown method: " + req.method } });
    } catch (e) {
      send({ jsonrpc: "2.0", id: req.id, error: { code: e.code || -32603, message: e.message } });
    }
  })();
});
