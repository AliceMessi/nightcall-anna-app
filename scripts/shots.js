const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const bundle = path.join(__dirname, "..", "bundle", "index.html");
  const outDir = path.join(__dirname, "..", "assets-store", "screenshots");
  require("fs").mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on("console", (m) => console.log("[console]", m.type(), m.text().slice(0, 120)));
  await page.goto("file:///" + bundle.replace(/\\/g, "/"));

  // 1 - empty / ready state
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, "01-alert-input.png") });

  // 2 - filled diagnosis (real plugin output shape, rendered by our bundle code)
  await page.evaluate(() => {
    document.getElementById("alert").value = JSON.stringify(
      { title: "escape-string-regexp fails on unescaped slash", stack: "TypeError" },
      null,
      2
    );
    document.getElementById("res-title").textContent =
      "escape-string-regexp fails on unescaped slash";
    document.getElementById("res-repro").textContent = "reproduced";
    document.getElementById("res-cause").textContent =
      "Unescaped special chars reach RegExp constructor; '/' and similar tokens are not escaped.";
    document.getElementById("res-patch").textContent =
      "Escape input with escape-string-regexp before new RegExp(input).";
    document.getElementById("res-verify").textContent =
      "red-green: failing fixture passes after patch";
    document.getElementById("res-next").textContent =
      "Paste the diff into your repo, run npm test, open a PR.";
    document.getElementById("result").hidden = false;
    document.getElementById("out").textContent = JSON.stringify(
      {
        success: true,
        data: {
          title: "escape-string-regexp fails on unescaped slash",
          reproduced: true,
          root_cause: "Unescaped special chars reach RegExp constructor.",
          patch: "Escape input with escape-string-regexp before new RegExp(input).",
          verify: "red-green: failing fixture passes after patch"
        }
      },
      null,
      2
    );
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, "02-diagnosis.png") });

  // 3 - full flow (scroll to raw result)
  await page.evaluate(() => document.getElementById("out").scrollIntoView());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(outDir, "03-evidence.png") });

  await browser.close();
  console.log("screenshots done:", outDir);
})();
