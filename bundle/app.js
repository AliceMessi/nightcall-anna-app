import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";
import { SAMPLES } from "./samples.js";

const EXECUTA_HANDLE = "nightcall-triage";
const DEV_FALLBACK_TOOL_ID = "tool-alanone-nightcall-triage-wx9u6zjt";
const EXECUTA_METHOD = "triage_alert";

const $ = (id) => document.getElementById(id);
let selectedSample = "checkout";
let lastData = null;

function resolveToolId() {
  return (window.__ANNA_TOOL_IDS__ && window.__ANNA_TOOL_IDS__[EXECUTA_HANDLE]) || DEV_FALLBACK_TOOL_ID;
}

const annaReady = (async () => {
  const anna = await AnnaAppRuntime.connect();
  window.anna = anna;
  try {
    await anna.window.set_title({ title: "Nightcall" });
  } catch {
    // cosmetic
  }
  return anna;
})();

// ---- rendering (textContent only: alert and code are untrusted) -----------
function list(el, items, cls) {
  el.replaceChildren(
    ...items.map((it) => {
      const li = document.createElement("li");
      if (typeof it === "string") li.textContent = it;
      else {
        li.textContent = `${it.name} — ${it.detail}`;
        if (cls) li.className = it.status;
      }
      return li;
    }),
  );
}

function renderDiff(el, text) {
  el.replaceChildren(
    ...String(text || "").split("\n").map((line) => {
      const span = document.createElement("span");
      span.textContent = line + "\n";
      if (/^@@/.test(line)) span.className = "hunk";
      else if (/^\+(?!\+\+)/.test(line)) span.className = "add";
      else if (/^-(?!--)/.test(line)) span.className = "del";
      return span;
    }),
  );
}

function badge(text, cls) {
  const b = document.createElement("span");
  b.className = "badge" + (cls ? " " + cls : "");
  b.textContent = text;
  return b;
}

function render(data, cached) {
  lastData = data;
  const c = data.confidence_detail || {};
  $("badges").replaceChildren(
    badge(
      data.analysis_source === "anna-llm"
        ? `Anna LLM${data.model ? " · " + data.model : ""}`
        : data.analysis_source === "basic"
          ? "Basic (Anna LLM unavailable)"
          : "Rules (deterministic)",
    ),
    badge(`confidence: ${data.confidence}`, data.confidence),
    badge(`cause ${c.cause} · location ${c.location}`),
    ...(data.error_type ? [badge(data.error_type)] : []),
    ...(data.service ? [badge(data.service)] : []),
    ...(cached ? [badge("saved result for this exact input")] : []),
  );
  $("res-cause").textContent = data.root_cause;
  $("res-title-check").hidden = !data.title_check;
  $("res-title-check").textContent = data.title_check ? "Title vs error: " + data.title_check : "";
  $("res-pointer").hidden = !data.pointer;
  $("res-pointer").textContent = data.pointer || "";
  list($("res-facts"), data.facts || []);
  list($("res-checks"), (data.checks || []).length ? data.checks : [{ name: "No local checks apply", detail: "nothing to reproduce from this alert", status: "skipped" }], true);
  list($("res-conf"), (c.reasons || []));
  list($("res-plan"), data.fix_plan || []);
  const p = data.patch || {};
  $("res-patch-note").textContent = (p.kind === "diff" ? "Unified diff — " : p.kind === "snippet" ? "Change to make (not anchored to your files) — " : "") + (p.note || "");
  renderDiff($("res-patch"), p.diff || "(no diff: attach the code named in the stack)");
  const t = data.regression_test;
  $("test-box").hidden = !t;
  if (t) {
    $("res-test-meta").textContent = `${t.path} — run: ${t.run}`;
    $("res-test").textContent = t.content;
  }
  $("needs-box").hidden = !(data.needs || []).length;
  list($("res-needs"), data.needs || []);
  $("res-honesty").textContent =
    "Your code was not executed and no tests were run. " + (data.reproduced ? "Reproduced: " + data.reproduced_scope + "." : "Nothing was reproduced.") +
    ((data.code_notes || []).length ? " Code: " + data.code_notes.join("; ") : "");
  $("result").hidden = false;
  $("out").textContent = JSON.stringify(data, null, 2);
}

async function inputKey(args) {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return "run:" + [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function run(force) {
  const btn = $("run");
  const args = { alert: $("alert").value };
  if ($("code").value.trim()) args.code = $("code").value;
  if ($("repo").value.trim()) {
    args.repo = $("repo").value.trim();
    if ($("ref").value.trim()) args.ref = $("ref").value.trim();
  }
  if (!args.alert.trim()) {
    $("status").textContent = "Paste an alert first.";
    return;
  }
  btn.disabled = true;
  $("status").textContent = "Analyzing…";
  try {
    const anna = await annaReady;
    const key = await inputKey(args);
    if (!force) {
      try {
        const saved = await anna.storage.get({ key });
        const value = saved && (saved.value !== undefined ? saved.value : saved);
        if (value && value.root_cause) {
          render(value, true);
          $("status").textContent = "Same input as before: showing the saved result. Shift+click Analyze to re-run.";
          return;
        }
      } catch {
        // storage is best-effort
      }
    }
    const reply = await anna.tools.invoke({ tool_id: resolveToolId(), method: EXECUTA_METHOD, args });
    const data = reply && reply.data ? reply.data : reply;
    if (!data || !data.root_cause) throw new Error("unexpected reply: " + JSON.stringify(reply).slice(0, 300));
    render(data, false);
    $("status").textContent = "Done.";
    try {
      await anna.storage.set({ key, value: data });
      await anna.storage.set({ key: "last_run", value: data });
    } catch {
      // best-effort
    }
  } catch (e) {
    $("status").textContent = "Error: " + (e && e.message ? e.message : e);
  } finally {
    btn.disabled = false;
  }
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Select and copy";
  }
  setTimeout(() => (btn.textContent = "Copy"), 1500);
}

function pick(name) {
  selectedSample = name;
  $("alert").value = SAMPLES[name].alert;
  $("code").value = "";
  $("repo").value = "";
  $("ref").value = "";
}

$("run").addEventListener("click", (ev) => run(ev.shiftKey));
$("fill-regex").addEventListener("click", () => pick("regex"));
$("fill-checkout").addEventListener("click", () => pick("checkout"));
$("fill-code").addEventListener("click", () => {
  $("code").value = SAMPLES[selectedSample].code;
  $("code-box").open = true;
});
$("copy-patch").addEventListener("click", (ev) => lastData && copy((lastData.patch && lastData.patch.diff) || "", ev.target));
$("copy-test").addEventListener("click", (ev) => lastData && lastData.regression_test && copy(lastData.regression_test.content, ev.target));

pick("checkout");
annaReady
  .then(async (anna) => {
    try {
      const saved = await anna.storage.get({ key: "last_run" });
      const value = saved && (saved.value !== undefined ? saved.value : saved);
      if (value && value.root_cause && value.version) render(value, true);
    } catch {
      // nothing saved yet
    }
  })
  .catch(() => {
    $("status").textContent = "Not connected to Anna (open this app from Anna).";
  });
