# Nightcall — review round 3 (v0.4.1)

## Reply to the Anna Developer Team (forum / review note)

Thanks for the detailed review — all four points were right, so the triage engine was rebuilt (v0.4.1).

**Test A (regex error).** Nightcall now recompiles the pattern from the error message, reproduces "Unterminated group", and points at the cause: the '(' at index 3, not the slash. It flags that the title is wrong (inside `new RegExp("...")` a '/' is an ordinary character) and says escape-string-regexp must not be edited: the call site has to pass the text through it. With no stack trace, confidence is split into cause (high, reproduced) and location (low), so the overall confidence is low, with the reasons listed.

**Patch you can apply.** When the files named in the stack are attached (pasted, or fetched from a public GitHub repo), the result is a unified diff that applies with `git apply`, syntax-checked, plus a regression test. Without code it gives a concrete fix plan and says exactly which files to attach. The "Load sample code" button attaches code matching your two alerts, so the full flow can be seen in one click.

**Test B (null pointer).** Known error classes are handled by deterministic rules, so the same alert gives the same answer (we ran it twice on a Cloud Agent). It traces the undefined value to the caller — `handler` (src/checkout.js:17) passes `req.session` without a user — adds a 401 guard there, makes `getUser` fail with a clear error, and explicitly rejects optional chaining, which would hide the error.

**Beyond a chatbot.** Reproduction of what can be reproduced, a title-vs-error check, calibrated confidence, refusal to edit dependencies, and validated diffs with regression tests. Other error classes still go to Anna's LLM via sampling (seen working on the Cloud Agent), with the same guardrails.

**Tested as requested.** Fresh install on a Cloud Agent (previous versions uninstalled), both alerts with and without code. Screenshots are in the store listing. The executa ships with a test suite that runs both alerts and a red-to-green check of the generated regression test on the sample code.

## Evidence

- Cloud Agent, fresh install, 15/10/2026: Test B ×2 identical (rules, medium/medium); Test A (regex-syntax, cause high / location low → low, reproduce ✓, escaped ✓, title check); Test A + code (diff on src/search.js, high); Test B + code (diff on user.js + checkout.js, 3 checks ✓, regression test); generic ETIMEDOUT → Anna LLM `google/gemini-3-flash-preview`, confidence capped.
- Screenshots: `assets-store/cloud-test/v041-cloud-{1,2,3}.png`, store `assets-store/screenshots/04-06`.
- Tests: `executas/nightcall/test/triage.test.js` (9 tests, run in CI before each binary build).
