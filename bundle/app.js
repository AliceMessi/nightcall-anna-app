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
  $("res-repro").textContent = data.reproduced ? "reproduced" : "not reproduced";
  $("res-cause").textContent = data.root_cause || "-";
  $("res-patch").textContent = data.patch || "-";
  $("res-verify").textContent = data.verify || "-";
  $("res-next").textContent = data.next || "-";
  $("result").hidden = false;
  $("out").textContent = JSON.stringify(result, null, 2);
}

async function run() {
  const out = $("out");
  const btn = $("run");
  out.textContent = "Running...";
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
    { title: "TypeError in checkout", stack: "Cannot read properties of undefined" },
    null,
    2
  );
});
