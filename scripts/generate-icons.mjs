#!/usr/bin/env node
/**
 * Generates platform application icons from build/icon.svg:
 * - build/icon.png  (1024x1024 RGBA PNG — master & Linux)
 * - build/icon.icns (macOS universal iconset via `iconutil`, all 10 @1x/@2x entries)
 * - build/icon.ico  (Windows multi-size ICO: 256, 128, 64, 48, 32, 16px)
 *
 * Uses the repository's installed Electron (Chromium/Skia) renderer so SVG filters,
 * gradients, and alpha transparency rasterize with exact vector fidelity.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const buildDir = path.join(rootDir, "build");
const svgPath = path.join(buildDir, "icon.svg");
const pngOutPath = path.join(buildDir, "icon.png");
const icnsOutPath = path.join(buildDir, "icon.icns");
const icoOutPath = path.join(buildDir, "icon.ico");

const ALL_SIZES = [1024, 512, 256, 128, 64, 48, 32, 16];
const ICO_SIZES = [256, 128, 64, 48, 32, 16];
const ICNS_ENTRIES = [
  { name: "icon_16x16.png", size: 16 },
  { name: "icon_16x16@2x.png", size: 32 },
  { name: "icon_32x32.png", size: 32 },
  { name: "icon_32x32@2x.png", size: 64 },
  { name: "icon_128x128.png", size: 128 },
  { name: "icon_128x128@2x.png", size: 256 },
  { name: "icon_256x256.png", size: 256 },
  { name: "icon_256x256@2x.png", size: 512 },
  { name: "icon_512x512.png", size: 512 },
  { name: "icon_512x512@2x.png", size: 1024 },
];

function resolveElectronBinary() {
  const localBin = path.join(
    rootDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron",
  );
  if (fs.existsSync(localBin)) return localBin;
  throw new Error(`Electron binary not found at ${localBin}. Run pnpm install first.`);
}

/**
 * Rasterizes `svgPath` at each requested square pixel size into `outDir/icon-<size>.png`
 * using Electron's Chromium canvas renderer (preserving full alpha transparency).
 */
function rasterizeSvgSizes(sizes, outDir, previewOutPath) {
  const runnerPath = path.join(outDir, "render-runner.cjs");
  const svgContent = fs.readFileSync(svgPath, "utf8");
  const svgBase64 = Buffer.from(svgContent, "utf8").toString("base64");

  const runnerCode = `
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const sizes = ${JSON.stringify(sizes)};
const outDir = ${JSON.stringify(outDir)};
const svgDataUrl = "data:image/svg+xml;base64,${svgBase64}";
const previewOutPath = ${JSON.stringify(previewOutPath ?? null)};

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      offscreen: true,
    },
  });

  ipcMain.handle("save-png", (_event, filePath, dataUrl) => {
    const base64 = dataUrl.replace(/^data:image\\/png;base64,/, "");
    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    return true;
  });

  ipcMain.on("done", (_event, errMsg) => {
    if (errMsg) {
      console.error("[generate-icons]", errMsg);
      app.exit(1);
    } else {
      app.exit(0);
    }
  });

  const html = \`<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:transparent;">
<script>
const { ipcRenderer } = require("electron");
const path = require("node:path");
const sizes = \${JSON.stringify(sizes)};
const outDir = \${JSON.stringify(outDir)};
const svgDataUrl = \${JSON.stringify(svgDataUrl)};
const previewOutPath = \${JSON.stringify(previewOutPath)};

async function run() {
  const img = new Image();
  img.decoding = "sync";
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Failed to decode build/icon.svg"));
    img.src = svgDataUrl;
  });

  for (const size of sizes) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, size, size);
    const dataUrl = canvas.toDataURL("image/png");
    await ipcRenderer.invoke("save-png", path.join(outDir, "icon-" + size + ".png"), dataUrl);
  }

  if (previewOutPath) {
    const pw = 1200;
    const ph = 700;
    const pc = document.createElement("canvas");
    pc.width = pw;
    pc.height = ph;
    const pctx = pc.getContext("2d");

    // Left panel: macOS Dark Mode backdrop
    pctx.fillStyle = "#111318";
    pctx.fillRect(0, 0, pw / 2, ph);
    // Right panel: macOS Light Mode backdrop
    pctx.fillStyle = "#F4F5F8";
    pctx.fillRect(pw / 2, 0, pw / 2, ph);

    // Subtle divider
    pctx.fillStyle = "rgba(128,128,128,0.22)";
    pctx.fillRect(pw / 2 - 1, 0, 2, ph);

    // Headers
    pctx.font = "600 18px -apple-system, BlinkMacSystemFont, sans-serif";
    pctx.fillStyle = "#E4E4E7";
    pctx.fillText("Dark Mode (512 / 128 / 64 / 32 / 16px)", 36, 44);
    pctx.fillStyle = "#18181B";
    pctx.fillText("Light Mode (512 / 128 / 64 / 32 / 16px)", pw / 2 + 36, 44);

    // Large icons
    pctx.imageSmoothingEnabled = true;
    pctx.imageSmoothingQuality = "high";
    pctx.drawImage(img, 108, 76, 384, 384);
    pctx.drawImage(img, pw / 2 + 108, 76, 384, 384);

    // Dock-style row for smaller sizes
    const dockSizes = [128, 64, 32, 16];
    for (let side = 0; side < 2; side++) {
      const baseX = side * (pw / 2) + 46;
      const dockY = 492;
      pctx.fillStyle = side === 0 ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)";
      pctx.beginPath();
      pctx.roundRect(baseX, dockY, 508, 168, 28);
      pctx.fill();

      let curX = baseX + 42;
      for (const s of dockSizes) {
        const y = dockY + (152 - s) / 2;
        pctx.drawImage(img, curX, y, s, s);
        pctx.font = "500 13px -apple-system, BlinkMacSystemFont, sans-serif";
        pctx.fillStyle = side === 0 ? "#A1A1AA" : "#52525B";
        pctx.fillText(s + "px", curX + Math.max(0, s / 2 - 14), dockY + 154);
        curX += s + 52;
      }
    }

    await ipcRenderer.invoke("save-png", previewOutPath, pc.toDataURL("image/png"));
  }

  ipcRenderer.send("done", null);
}

run().catch((err) => ipcRenderer.send("done", String(err && err.stack || err)));
</script>
</body>
</html>\`;

  const htmlPath = path.join(outDir, "render.html");
  fs.writeFileSync(htmlPath, html, "utf8");
  await win.loadFile(htmlPath);
});
`;

  fs.writeFileSync(runnerPath, runnerCode, "utf8");
  const electronBin = resolveElectronBinary();
  execFileSync(electronBin, [runnerPath], {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
  });
}

/**
 * Encodes multiple PNG buffers into a single valid Windows ICO binary.
 */
function buildIcoBuffer(entries) {
  const headerSize = 6;
  const dirEntrySize = 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = ICO
  header.writeUInt16LE(entries.length, 4);

  const dirBuffers = [];
  let offset = headerSize + dirEntrySize * entries.length;

  for (const { size, png } of entries) {
    const dir = Buffer.alloc(dirEntrySize);
    dir.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256px
    dir.writeUInt8(size >= 256 ? 0 : size, 1);
    dir.writeUInt8(0, 2); // color palette count
    dir.writeUInt8(0, 3); // reserved
    dir.writeUInt16LE(1, 4); // color planes
    dir.writeUInt16LE(32, 6); // bits per pixel
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirBuffers.push(dir);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirBuffers, ...entries.map((e) => e.png)]);
}

function main() {
  if (!fs.existsSync(svgPath)) {
    throw new Error(`Missing source SVG at ${svgPath}`);
  }

  const previewIdx = process.argv.indexOf("--preview");
  const previewOutPath =
    previewIdx !== -1 && process.argv[previewIdx + 1]
      ? path.resolve(process.argv[previewIdx + 1])
      : null;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-icons-"));
  try {
    rasterizeSvgSizes(ALL_SIZES, tmpDir, previewOutPath);

    // 1. Master 1024x1024 PNG (also used for Linux & Electron runtime icon)
    fs.copyFileSync(path.join(tmpDir, "icon-1024.png"), pngOutPath);
    console.log(`[generate-icons] wrote ${path.relative(rootDir, pngOutPath)} (1024x1024)`);

    // 2. Windows multi-size ICO (256, 128, 64, 48, 32, 16)
    const icoEntries = ICO_SIZES.map((size) => ({
      size,
      png: fs.readFileSync(path.join(tmpDir, `icon-${size}.png`)),
    }));
    fs.writeFileSync(icoOutPath, buildIcoBuffer(icoEntries));
    console.log(
      `[generate-icons] wrote ${path.relative(rootDir, icoOutPath)} (${ICO_SIZES.join("/")}px)`,
    );

    // 3. macOS universal ICNS via iconutil (all 10 @1x/@2x entries)
    if (process.platform === "darwin") {
      const iconsetDir = path.join(tmpDir, "icon.iconset");
      fs.mkdirSync(iconsetDir, { recursive: true });
      for (const entry of ICNS_ENTRIES) {
        fs.copyFileSync(
          path.join(tmpDir, `icon-${entry.size}.png`),
          path.join(iconsetDir, entry.name),
        );
      }
      execFileSync("/usr/bin/iconutil", ["-c", "icns", iconsetDir, "-o", icnsOutPath], {
        stdio: "inherit",
      });
      console.log(
        `[generate-icons] wrote ${path.relative(rootDir, icnsOutPath)} (${ICNS_ENTRIES.length} iconset entries)`,
      );
    } else {
      console.warn("[generate-icons] skipping .icns generation (iconutil requires macOS)");
    }

    if (previewOutPath) {
      console.log(`[generate-icons] wrote preview sheet: ${previewOutPath}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
