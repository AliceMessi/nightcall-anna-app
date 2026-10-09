#!/usr/bin/env node
// CI packaging: after pkg builds raw binaries per-OS (one runner per platform),
// pack each as .tar.gz (unix) / .zip (windows) with manifest.json at archive root.
// Run on each runner AFTER `npx @yao-pkg/pkg plugin.js --targets <this-platform>`.
//
// Layout per Binary Distribution docs:
//   archive root: <entrypoint binary> + manifest.json
//   manifest.json pins name/version + runtime.binary.entrypoint
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const name = "nightcall-triage";
const platform = process.argv[2]; // e.g. linux-x86_64
if (!platform) {
  console.error("usage: build-binaries.mjs <platform-key>");
  process.exit(1);
}

const isWin = platform.startsWith("windows");
const binFile = isWin ? `${name}.exe` : name;
const archive = isWin
  ? `${name}-${version}-${platform}.zip`
  : `${name}-${version}-${platform}.tar.gz`;

if (!existsSync(join(root, "dist", binFile))) {
  console.error(`missing dist/${binFile} - run pkg first for ${platform}`);
  process.exit(1);
}

const manifest = {
  name: "tool-alanone-nightcall-triage-wx9u6zjt",
  version,
  runtime: {
    binary: {
      entrypoint: {
        default: `bin/${name}`,
        "windows-x86_64": `bin/${name}.exe`,
        "windows-arm64": `bin/${name}.exe`
      },
      permissions: {}
    }
  }
};
writeFileSync(join(root, "dist", "manifest.json"), JSON.stringify(manifest, null, 2));

// Stage into bin/ layout then archive (entrypoint resolution: manifest + asset dict)
const staging = join(root, "dist", "stage");
execSync(
  isWin
    ? `New-Item -ItemType Directory -Force -Path dist/stage/bin | Out-Null; Copy-Item dist/${binFile} dist/stage/bin/${binFile} -Force; Copy-Item dist/manifest.json dist/stage/manifest.json -Force; Compress-Archive -Path dist/stage/bin, dist/stage/manifest.json -DestinationPath dist/${archive} -Force`
    : `rm -rf dist/stage && mkdir -p dist/stage/bin && cp dist/${binFile} dist/stage/bin/${name} && chmod +x dist/stage/bin/${name} && cp dist/manifest.json dist/stage/manifest.json && tar -czf dist/${archive} -C dist/stage bin manifest.json`,
  { cwd: root, shell: isWin ? "powershell.exe" : "/bin/sh", stdio: "inherit" }
);
console.log(`packed dist/${archive}`);
const sha256 = createHash("sha256").update(readFileSync(join(root, "dist", archive))).digest("hex");
console.log(`sha256 ${sha256}  dist/${archive}`);
