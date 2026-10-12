const { chromium } = require("playwright");
const path = require("path");

(async () => {
  const bundle = path.join(__dirname, "..", "bundle", "index.html");
  const outDir = path.join(__dirname, "..", "assets-store", "screenshots");
  require("fs").mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto("file:///" + bundle.replace(/\\/g, "/"));

  // 1 - empty / ready state (mail's alert prefilled by default)
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(outDir, "01-alert-input.png") });

  // 2 - AI analysis rendered by our bundle code (honest fields)
  await page.evaluate(() => {
    document.getElementById("res-title").textContent =
      "TypeError: Cannot read properties of undefined (reading 'id')";
    document.getElementById("res-source").textContent = "Anna LLM";
    document.getElementById("res-conf").textContent = "medium";
    document.getElementById("res-cause").textContent =
      "getUser in src/user.js:42 reads id from an undefined user object; the caller handler in src/checkout.js:17 passes no user.";
    document.getElementById("res-patch").textContent =
      "Guard in getUser: if (!user) throw new Error('missing user'); use user?.id at the read site.";
    document.getElementById("res-evidence").textContent =
      "getUser (src/user.js:42); handler (src/checkout.js:17); accessed field: 'id'; service: checkout-api";
    document.getElementById("res-honesty").textContent =
      "Not reproduced, not verified — inference from the alert text only. Validate in your own repo before applying.";
    document.getElementById("result").hidden = false;
    document.getElementById("out").textContent = JSON.stringify(
      {
        success: true,
        data: {
          title: "TypeError: Cannot read properties of undefined (reading 'id')",
          confidence: "medium",
          evidence_used: ["getUser (src/user.js:42)", "accessed field: 'id'"],
          analysis_source: "anna-llm",
          reproduced: false,
          verified: false
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
