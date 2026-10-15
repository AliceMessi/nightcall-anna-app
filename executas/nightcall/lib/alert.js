"use strict";
// Reads an alert (JSON, JSON with raw newlines inside strings, or free text)
// into the fields the analyzers need. Nothing here guesses a cause.

// Tolerant reader: real alerts are often pasted with raw newlines inside
// string values, which JSON.parse rejects.
function jsonField(text, names) {
  for (const name of names) {
    const re = new RegExp('"' + name + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', "s");
    const m = text.match(re);
    if (m) {
      try {
        return JSON.parse('"' + m[1].replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"');
      } catch {
        return m[1];
      }
    }
  }
  return null;
}

const FRAME_RE = /^\s*at (?:(?:async )?([^\s(]+) \()?((?:[A-Za-z]:)?[^():\s]+):(\d+):(\d+)\)?\s*$/;

function parseFrames(stack) {
  const frames = [];
  for (const line of String(stack || "").split(/\r?\n/)) {
    const m = line.match(FRAME_RE);
    if (!m) continue;
    const file = m[2].replace(/\\/g, "/");
    frames.push({
      function: m[1] || "<anonymous>",
      file,
      line: Number(m[3]),
      column: Number(m[4]),
      library: /(^|\/)node_modules\//.test(file) || /^node:/.test(file) || /^internal\//.test(file),
    });
    if (frames.length >= 12) break;
  }
  return frames;
}

function parseAlert(raw) {
  const text = String(raw || "");
  let title = jsonField(text, ["title", "summary", "name"]);
  let error = jsonField(text, ["error", "message", "exception", "msg"]);
  let service = jsonField(text, ["service", "serviceName", "app"]);
  let stack = jsonField(text, ["stack", "stacktrace", "stack_trace", "trace"]);
  if (title == null && error == null) {
    // free text: first line is the headline, "at ..." lines are the stack
    const lines = text.split(/\r?\n/);
    title = (lines.find((l) => l.trim()) || "untitled alert").trim().slice(0, 300);
    const stackLines = lines.filter((l) => /^\s*at /.test(l));
    if (stackLines.length) stack = stackLines.join("\n");
  }
  title = title || error || "untitled alert";
  stack = stack || "";
  // an error message can also carry the stack ("TypeError: ...\n    at ...")
  if (!stack && error && /\n\s*at /.test(error)) {
    stack = error.slice(error.search(/\n\s*at /) + 1);
    error = error.slice(0, error.search(/\n\s*at /));
  }

  const frames = parseFrames(stack);
  const headline = [error, title].filter(Boolean).join("\n");
  const typeMatch = headline.match(/\b([A-Z][A-Za-z]*(?:Error|Exception))\b/) || String(stack).match(/\b([A-Z][A-Za-z]*(?:Error|Exception))\b/);
  const accessed = [];
  for (const m of headline.matchAll(/reading ['"`]([^'"`]+)['"`]/g)) if (!accessed.includes(m[1])) accessed.push(m[1]);

  return {
    title: String(title).trim(),
    error: error ? String(error).trim() : null,
    service: service || null,
    stack: String(stack),
    frames,
    appFrames: frames.filter((f) => !f.library),
    errorType: typeMatch ? typeMatch[1] : null,
    accessed,
    text: text.slice(0, 6000),
  };
}

module.exports = { parseAlert, parseFrames, jsonField };
