# Nightcall — Store Listing (da incollare in Developer Console > Listing)

> I campi Listing NON vivono in manifest.json — stanno sulla riga AnnaApp.
> Console > la tua App > tab Listing. Update senza re-review.

## Name
Nightcall - On-Call Fixer

## Tagline (≤160)
Alert to verified patch in minutes

## Long description / About (≤20000)
Nightcall is an on-call fixer: paste a production alert, reproduce the bug heuristically, get a root cause and a minimal verified patch with red-green evidence.

Key features
- Alert triage in seconds: paste alert JSON or free text, get title, reproduced flag, root cause, patch proposal and next steps.
- Real-bug heuristic: escape-string-regexp style RegExp escapes plus a safe generic fallback with validation guidance.
- Evidence bundle: red-green verify note plus copy-paste PR guidance, last run saved via Anna Storage.
- No API keys needed: bundled Node Executa runs locally and on Cloud Agents via multi-platform binaries.

Who it's for
On-call developers, SREs and small teams who want alert-to-patch in minutes without wiring LLM keys.

How to get started
1. Install Nightcall. 2. Open the Nightcall window. 3. Paste an alert (e.g. {"title":"escape-string-regexp fails on unescaped slash"}). 4. Click Reproduce + diagnose. 5. Copy the patch into your repo, run npm test, open a PR.

## Logo
Upload logo button (POST /apps/{id}/logo, max 2MB → 256×256 WebP):
- `assets-store/logo.svg` (vettoriale, sorgente Higgsfield Recraft)
- `assets-store/logo-1024.webp` (preview)
- URL remoto (se serve incollare): usare l'URL CDN del job
  `https://d8j0ntlcm91z4.cloudfront.net/.../hf_20261009_081948_327f6128...svg`

## Cover
- `assets-store/cover-16x9.png` (Higgsfield GPT Image 2.5)

## Screenshots (max 6, un URL per riga — caricare prima su hosting/CDN)
Screenshot REALI del bundle (1000×700, stesso default_size del manifest):
- `assets-store/screenshots/01-alert-input.png` — input alert
- `assets-store/screenshots/02-diagnosis.png` — diagnosis cards
- `assets-store/screenshots/03-evidence.png` — raw result / evidence

## Checklist resubmit (mail Anna)
- [x] Logo distintivo (non placeholder)
- [x] Screenshot reali del main flow (3)
- [x] About dettagliata (cosa fa / features / per chi / started)
- [x] Bundled tool `nightcall-triage` con 4 binari (vedi sotto)
- [ ] Full test su Cloud Agent da fresh install → main flow (richiede login + publish)

## Fix tecnici applicati (cap. 6-7 Build on Anna 101)
- `app.json`: aggiunto `bundled_executas: {nightcall-triage: ./executas/nightcall}`, description estesa, version 0.2.0
- `manifest.json`: `required_executas: [{tool_id: bundled:nightcall-triage}]`,
  `host_api.tools: [required:bundled:nightcall-triage]` (prima hardcoded tool-id + required:*)
- `bundle/`: split `index.html` + `app.js` + `anna-tool-ids.js`
  (handle → window.__ANNA_TOOL_IDS__ con fallback dev, come llm-demo ufficiale)
- `executas/nightcall/executa.json`: `tool_id` allineato a quello mintato
  `tool-alanone-nightcall-triage-wx9u6zjt`, aggiunta `distribution.active: binary`
  con `binary_artifacts` per darwin-arm64 / darwin-x86_64 / linux-x86_64 / windows-x86_64
- `.github/workflows/build-binaries.yml`: matrix 4 OS con @yao-pkg/pkg + packaging
  tar.gz/zip con manifest.json + SHA256, upload artifacts + release su tag executa-v*
- `package.json` executa: bin `nightcall-triage`, version 0.2.0
