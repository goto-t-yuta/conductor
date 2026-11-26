import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAppIconPath } from "../src/main/app-icon.js";

const ROOT_DIR = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(ROOT_DIR, "build");

function readPngDimensions(buffer: Buffer): { width: number; height: number } {
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buffer.subarray(0, 8).equals(pngSig)).toBe(true);
  expect(buffer.toString("ascii", 12, 16)).toBe("IHDR");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function parseIcnsChunkTypes(buffer: Buffer): string[] {
  expect(buffer.toString("ascii", 0, 4)).toBe("icns");
  const totalLength = buffer.readUInt32BE(4);
  expect(totalLength).toBe(buffer.length);

  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32BE(offset + 4);
    expect(chunkLength).toBeGreaterThanOrEqual(8);
    types.push(chunkType);
    offset += chunkLength;
  }
  return types;
}

function parseIcoSizes(buffer: Buffer): number[] {
  expect(buffer.readUInt16LE(0)).toBe(0); // reserved
  expect(buffer.readUInt16LE(2)).toBe(1); // type = ICO
  const count = buffer.readUInt16LE(4);
  const sizes: number[] = [];

  for (let i = 0; i < count; i++) {
    const entryOffset = 6 + i * 16;
    const width = buffer.readUInt8(entryOffset) || 256;
    const height = buffer.readUInt8(entryOffset + 1) || 256;
    const bytesInRes = buffer.readUInt32LE(entryOffset + 8);
    const imageOffset = buffer.readUInt32LE(entryOffset + 12);

    expect(width).toBe(height);
    expect(imageOffset + bytesInRes).toBeLessThanOrEqual(buffer.length);
    sizes.push(width);
  }

  return sizes;
}

describe("Conductor application icons", () => {
  it("provides a valid high-resolution SVG master and 1024x1024 PNG icon", () => {
    const svgPath = path.join(BUILD_DIR, "icon.svg");
    const pngPath = path.join(BUILD_DIR, "icon.png");

    expect(fs.existsSync(svgPath)).toBe(true);
    expect(fs.existsSync(pngPath)).toBe(true);

    const svg = fs.readFileSync(svgPath, "utf8");
    expect(svg).toContain('viewBox="0 0 1024 1024"');

    const png = fs.readFileSync(pngPath);
    const dims = readPngDimensions(png);
    expect(dims).toEqual({ width: 1024, height: 1024 });
  });

  it("provides a valid macOS .icns archive containing @1x and @2x entries up to 1024px", () => {
    const icnsPath = path.join(BUILD_DIR, "icon.icns");
    expect(fs.existsSync(icnsPath)).toBe(true);

    const chunkTypes = parseIcnsChunkTypes(fs.readFileSync(icnsPath));
    // Standard iconutil chunks covering 16x16 through 512x512@2x (1024x1024)
    for (const requiredType of [
      "ic04",
      "ic11",
      "ic05",
      "ic12",
      "ic07",
      "ic13",
      "ic08",
      "ic14",
      "ic09",
      "ic10",
    ]) {
      expect(chunkTypes).toContain(requiredType);
    }
  });

  it("provides a valid Windows multi-size .ico archive (256/128/64/48/32/16px)", () => {
    const icoPath = path.join(BUILD_DIR, "icon.ico");
    expect(fs.existsSync(icoPath)).toBe(true);

    const sizes = parseIcoSizes(fs.readFileSync(icoPath));
    expect(sizes).toEqual([256, 128, 64, 48, 32, 16]);
  });

  it("registers platform icons and runtime icon asset in electron-builder.yml", () => {
    const config = fs.readFileSync(path.join(ROOT_DIR, "electron-builder.yml"), "utf8");
    expect(config).toContain("buildResources: build");
    expect(config).toContain("build/icon.icns");
    expect(config).toContain("build/icon.ico");
    expect(config).toContain("build/icon.png");
  });

  it("resolves the runtime app icon across dev and packaged layouts", () => {
    // Real repository resolution (simulating compiled dist/main)
    const devResolved = resolveAppIconPath({
      mainDir: path.join(ROOT_DIR, "dist/main"),
    });
    expect(devResolved).toBe(path.join(ROOT_DIR, "build/icon.png"));

    // Packaged app.asar fallback
    const packagedPath = "/Applications/Conductor.app/Contents/Resources/app.asar/build/icon.png";
    const packagedResolved = resolveAppIconPath({
      mainDir: "/nonexistent/dist/main",
      appPath: "/Applications/Conductor.app/Contents/Resources/app.asar",
      existsSync: (p) => p === path.normalize(packagedPath),
    });
    expect(packagedResolved).toBe(path.normalize(packagedPath));

    // Returns null gracefully if no icon exists
    const missing = resolveAppIconPath({
      mainDir: "/nonexistent/dist/main",
      appPath: "/nonexistent/app",
      resourcesPath: "/nonexistent/resources",
      existsSync: () => false,
    });
    expect(missing).toBeNull();
  });

  it("provides matching Android adaptive launcher icon drawables", () => {
    const androidResDir = path.join(ROOT_DIR, "mobile/android/app/src/main/res");
    const files = [
      "drawable/ic_launcher_background.xml",
      "drawable/ic_launcher_foreground.xml",
      "drawable/ic_launcher_monochrome.xml",
      "mipmap-anydpi-v26/ic_launcher.xml",
      "mipmap-anydpi-v26/ic_launcher_round.xml",
    ];
    for (const rel of files) {
      const full = path.join(androidResDir, rel);
      expect(fs.existsSync(full)).toBe(true);
      const xml = fs.readFileSync(full, "utf8");
      expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    }
  });
});
