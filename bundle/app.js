import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";

const EXECUTA_HANDLE = "nightcall-triage";
const DEV_FALLBACK_TOOL_ID = "tool-alanone-nightcall-triage-wx9u6zjt";
const EXECUTA_METHOD = "triage_alert";

function resolveToolId() {
  return (
    (typeof window !== "undefined" &&
      window.__ANNA_TOOL_IDS__ &&
      window.__ANNA_TOOL_IDS__[EXECUTA_HANDLE]) ||
    DEV_FALLBACK_TOOL_ID
  );
}

const $ = (id) => document.getElementById(id);

const annaReady = (async () => {
  const anna = await AnnaAppRuntime.connect();
  window.anna = anna;
  try {
    await anna.window.set_title({ title: "Nightcall" });
  } catch {
    // ignore - title is cosmetic
  }
  return anna;
})();

function renderResult(result) {
  const data = result && result.data ? result.data : result;
  if (!data || typeof data !== "object") {
    $("out").textContent = JSON.stringify(result, null, 2);
    return;
  }
  $("res-title").textContent = data.title || "untitled alert";
  const src = data.analysis_source === "anna-llm" ? "Anna LLM" : "local heuristic";
  $("res-source").textContent = src + (data.model ? " (" + data.model + ")" : "");
  $("res-conf").textContent = data.confidence || "low";
  $("res-cause").textContent = data.root_cause || "-";
  $("res-patch").textContent = data.patch || "-";
  $("res-evidence").textContent = (data.evidence_used || []).join("; ") || "-";
  $("res-honesty").textContent =
    "Not reproduced, not verified — inference from the alert text only. Validate in your own repo before applying.";
  $("result").hidden = false;
  $("out").textContent = JSON.stringify(result, null, 2);
}

async function run() {
  const out = $("out");
  const btn = $("run");
  out.textContent = "Analyzing with Anna's LLM...";
  btn.disabled = true;
  try {
    const anna = await annaReady;
    const alertText = $("alert").value;
    if (!alertText.trim()) {
      out.textContent = "Paste an alert first.";
      return;
    }
    const reply = await anna.tools.invoke({
      tool_id: resolveToolId(),
      method: EXECUTA_METHOD,
      args: { alert: alertText }
    });
    renderResult(reply);
    try {
      await anna.storage.set({ key: "last_run", value: reply });
    } catch {
      // storage is best-effort
    }
  } catch (e) {
    out.textContent = "Error: " + (e?.message || e);
  } finally {
    btn.disabled = false;
  }
}

$("run").addEventListener("click", run);
$("fill-regex").addEventListener("click", () => {
  $("alert").value = JSON.stringify(
    { title: "escape-string-regexp fails on unescaped slash", stack: "TypeError" },
    null,
    2
  );
});
$("fill-generic").addEventListener("click", () => {
  $("alert").value = JSON.stringify(
    {
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      service: "checkout-api",
      stack: "at getUser (src/user.js:42:18)\n at handler (src/checkout.js:17:5)"
    },
    null,
    2
  );
});
