import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getMimeTypeForImagePath,
  readLocalImageFile,
  resolveLocalImagePath,
} from "../src/main/image-viewer.js";
import {
  buildImageTabFromAttachment,
  clampZoom,
  closeImageTab,
  computeCursorAnchoredScroll,
  computeFitScale,
  computeNextWheelZoom,
  extractImageFileName,
  formatZoomLabel,
  IMAGE_VIEWPORT_PADDING_PX,
  isDirectRenderableImageUrl,
  isLocalImagePathOrFileUrl,
  isPinchOrZoomWheelEvent,
  isViewableImageAttachment,
  MAX_ZOOM,
  MIN_ZOOM,
  normalizeWheelDeltaY,
  resolveImageSource,
  stepZoom,
  upsertImageTab,
} from "../src/renderer/lib/image-viewer.js";
import type { ChatAttachment } from "../src/shared/types.js";

const TINY_PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64",
);

describe("Local Image Viewer (main service)", () => {
  it("resolves absolute image paths and file:// URLs while rejecting invalid inputs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-img-resolve-"));
    try {
      const spacedFile = path.join(tmpDir, "screen shot 1.png");
      fs.writeFileSync(spacedFile, TINY_PNG_BYTES);

      const fileUrl = `${pathToFileURL(spacedFile).toString()}?v=1`;
      const fromUrl = resolveLocalImagePath(fileUrl);
      expect(fromUrl).toEqual({ ok: true, filePath: spacedFile });

      expect(getMimeTypeForImagePath("photo.JPG")).toBe("image/jpeg");
      expect(getMimeTypeForImagePath("icon.webp")).toBe("image/webp");
      expect(getMimeTypeForImagePath("logo.svg")).toBe("image/svg+xml");
      expect(getMimeTypeForImagePath("README.md")).toBeNull();

      // Rejects relative paths, non-image extensions, and null bytes
      expect(resolveLocalImagePath("paste.png").ok).toBe(false);
      expect(resolveLocalImagePath("/etc/passwd").ok).toBe(false);
      expect(resolveLocalImagePath(path.join(tmpDir, "notes.txt")).ok).toBe(false);
      expect(resolveLocalImagePath("/tmp/bad\0.png").ok).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads local images as data URLs and blocks symlinks pointing to non-image targets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-img-read-"));
    try {
      const pngPath = path.join(tmpDir, "paste-1234.png");
      fs.writeFileSync(pngPath, TINY_PNG_BYTES);

      const res = readLocalImageFile(pngPath);
      expect(res.ok).toBe(true);
      expect(res.filePath).toBe(pngPath);
      expect(res.fileName).toBe("paste-1234.png");
      expect(res.mimeType).toBe("image/png");
      expect(res.sizeBytes).toBe(TINY_PNG_BYTES.length);
      expect(res.dataUrl).toBe(`data:image/png;base64,${TINY_PNG_BYTES.toString("base64")}`);

      // Also works when passed a file:// URL
      const viaUrl = readLocalImageFile(pathToFileURL(pngPath).toString());
      expect(viaUrl.ok).toBe(true);
      expect(viaUrl.dataUrl).toBe(res.dataUrl);

      // Symlink from .png to .txt must be blocked
      const secretTxt = path.join(tmpDir, "secret.txt");
      fs.writeFileSync(secretTxt, "not an image", "utf8");
      const evilLink = path.join(tmpDir, "fake.png");
      fs.symlinkSync(secretTxt, evilLink);

      const blocked = readLocalImageFile(evilLink);
      expect(blocked.ok).toBe(false);
      expect(blocked.dataUrl).toBeUndefined();

      // Missing file returns clean error
      const missing = readLocalImageFile(path.join(tmpDir, "missing.png"));
      expect(missing.ok).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves and reads relative, percent-encoded, Japanese, query/hash, and repo-root image paths against baseFilePath", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-img-rel-"));
    try {
      const docsDir = path.join(tmpDir, "docs");
      const imagesDir = path.join(docsDir, "images");
      const assetsDir = path.join(tmpDir, "assets");
      fs.mkdirSync(path.join(tmpDir, ".git"));
      fs.mkdirSync(imagesDir, { recursive: true });
      fs.mkdirSync(assetsDir, { recursive: true });

      const readmePath = path.join(tmpDir, "README.md");
      const guidePath = path.join(docsDir, "guide.md");
      const overviewPng = path.join(imagesDir, "overview.png");
      const spacedJapanesePng = path.join(imagesDir, "画面 キャプチャ.png");
      const parentAssetPng = path.join(assetsDir, "diagram.png");
      const literalHashPng = path.join(imagesDir, "chart#1.png");

      fs.writeFileSync(readmePath, "# Readme\n", "utf8");
      fs.writeFileSync(guidePath, "# Guide\n", "utf8");
      fs.writeFileSync(overviewPng, TINY_PNG_BYTES);
      fs.writeFileSync(spacedJapanesePng, TINY_PNG_BYTES);
      fs.writeFileSync(parentAssetPng, TINY_PNG_BYTES);
      fs.writeFileSync(literalHashPng, TINY_PNG_BYTES);

      // Relative path without ./ prefix (e.g. docs/images/overview.png)
      const rel1 = readLocalImageFile("docs/images/overview.png", readmePath);
      expect(rel1.ok).toBe(true);
      expect(rel1.filePath).toBe(overviewPng);
      expect(rel1.dataUrl).toBe(`data:image/png;base64,${TINY_PNG_BYTES.toString("base64")}`);

      // Relative path with ./ and ?query#hash (GitHub theme fragments)
      const rel2 = readLocalImageFile("./images/overview.png?raw=1#gh-dark-mode-only", guidePath);
      expect(rel2.ok).toBe(true);
      expect(rel2.filePath).toBe(overviewPng);

      // Parent directory traversal ../
      const relParent = readLocalImageFile("../assets/diagram.png", guidePath);
      expect(relParent.ok).toBe(true);
      expect(relParent.filePath).toBe(parentAssetPng);

      // Percent-encoded spaces & Japanese characters produced by remark/Markdown
      const encodedName = encodeURIComponent("画面 キャプチャ.png");
      const relJapanese = readLocalImageFile(`docs/images/${encodedName}`, readmePath);
      expect(relJapanese.ok).toBe(true);
      expect(relJapanese.filePath).toBe(spacedJapanesePng);

      // Literal '#' in filename preserved when file exists on disk
      const relLiteralHash = resolveLocalImagePath("docs/images/chart#1.png", readmePath);
      expect(relLiteralHash).toEqual({ ok: true, filePath: literalHashPng });

      // baseFilePath provided as file:// URL
      const relWithFileUrlBase = resolveLocalImagePath(
        "docs/images/overview.png",
        pathToFileURL(readmePath).toString(),
      );
      expect(relWithFileUrlBase).toEqual({ ok: true, filePath: overviewPng });

      // GitHub-style repo-root path (/docs/images/...) resolved via git root when absent at OS root
      const repoRootRel = readLocalImageFile("/docs/images/overview.png", guidePath);
      expect(repoRootRel.ok).toBe(true);
      expect(repoRootRel.filePath).toBe(overviewPng);

      // Symlink to non-image file is still blocked even via relative path
      const secretPath = path.join(tmpDir, "secret.txt");
      fs.writeFileSync(secretPath, "secret", "utf8");
      fs.symlinkSync(secretPath, path.join(imagesDir, "evil.png"));
      const blockedRel = readLocalImageFile("docs/images/evil.png", readmePath);
      expect(blockedRel.ok).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Image Viewer (renderer source resolution & tabs)", () => {
  it("supports data URLs, blob URLs, custom protocol URLs, file:// URLs, and local paths", () => {
    expect(isDirectRenderableImageUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isDirectRenderableImageUrl("blob:http://localhost:5179/abc-123")).toBe(true);
    expect(isDirectRenderableImageUrl("https://example.com/a.png")).toBe(true);
    expect(isDirectRenderableImageUrl("conductor-media://attachments/paste-1.png")).toBe(true);
    expect(isDirectRenderableImageUrl("file:///Users/me/paste.png")).toBe(false);
    expect(isDirectRenderableImageUrl("C:\\Users\\me\\paste.png")).toBe(false);

    expect(isLocalImagePathOrFileUrl("/Users/me/paste.png")).toBe(true);
    expect(isLocalImagePathOrFileUrl("~/Desktop/shot.png")).toBe(true);
    expect(isLocalImagePathOrFileUrl("file:///Users/me/paste.png")).toBe(true);
    expect(isLocalImagePathOrFileUrl("C:\\Users\\me\\paste.png")).toBe(true);
    expect(isLocalImagePathOrFileUrl("data:image/png;base64,AAAA")).toBe(false);

    // Pasted image with both data URL and saved local file path
    const pasted: ChatAttachment = {
      id: "att-1",
      kind: "image",
      label: "Pasted Image",
      imagePath: "/Users/me/attachments/paste-1111.png",
      imageDataUrl: "data:image/png;base64,AAAA",
    };
    expect(isViewableImageAttachment(pasted)).toBe(true);
    expect(resolveImageSource(pasted)).toEqual({
      directSrc: "data:image/png;base64,AAAA",
      localPathToLoad: "/Users/me/attachments/paste-1111.png",
    });

    // Blob URL attachment
    const blobAtt: ChatAttachment = {
      id: "att-blob",
      kind: "image",
      label: "Clipboard Blob",
      imageDataUrl: "blob:http://localhost:5179/1234",
    };
    expect(resolveImageSource(blobAtt)).toEqual({
      directSrc: "blob:http://localhost:5179/1234",
      localPathToLoad: null,
    });

    // Local file path only (no inline dataUrl)
    const pathOnly: ChatAttachment = {
      id: "att-path",
      kind: "image",
      label: "diagram.png",
      imagePath: "/Users/me/Pictures/diagram.png",
    };
    expect(isViewableImageAttachment(pathOnly)).toBe(true);
    const builtPathOnly = buildImageTabFromAttachment(pathOnly);
    expect(builtPathOnly.tab.src).toBeNull();
    expect(builtPathOnly.tab.isLoading).toBe(true);
    expect(builtPathOnly.localPathToLoad).toBe("/Users/me/Pictures/diagram.png");
    expect(builtPathOnly.tab.fileName).toBe("diagram.png");

    // Custom protocol URL via imagePath or url
    const protoAtt: ChatAttachment = {
      id: "att-proto",
      kind: "image",
      label: "Remote Capture",
      url: "conductor://capture/42.png",
    };
    expect(resolveImageSource(protoAtt)).toEqual({
      directSrc: "conductor://capture/42.png",
      localPathToLoad: null,
    });

    // Non-image attachments (browserURL, consoleErrors, taskRef) are not viewable images
    const urlAtt: ChatAttachment = {
      id: "att-url",
      kind: "browserURL",
      label: "Localhost",
      url: "http://localhost:3000",
    };
    expect(isViewableImageAttachment(urlAtt)).toBe(false);

    // Browser element WITH screenshot IS viewable
    const elemWithShot: ChatAttachment = {
      id: "att-el",
      kind: "browserElement",
      label: "<button> #submit",
      imagePath: "/Users/me/attachments/element-1.png",
      imageDataUrl: "data:image/png;base64,BBBB",
      url: "http://localhost:3000/checkout",
    };
    expect(isViewableImageAttachment(elemWithShot)).toBe(true);
    expect(extractImageFileName("file:///Users/me/my%20shot.png?raw=1")).toBe("my shot.png");
  });

  it("deduplicates tabs by id/imagePath/src and selects adjacent tabs on close", () => {
    const first = buildImageTabFromAttachment({
      id: "img-1",
      kind: "image",
      label: "Pasted Image",
      imagePath: "/tmp/paste-1.png",
      imageDataUrl: "data:image/png;base64,ONE",
    }).tab;

    const second = buildImageTabFromAttachment({
      id: "img-2",
      kind: "image",
      label: "Screenshot: Home",
      imagePath: "/tmp/browser-2.png",
      imageDataUrl: "data:image/png;base64,TWO",
    }).tab;

    const step1 = upsertImageTab([], first);
    expect(step1.tabs).toHaveLength(1);
    expect(step1.activeTabId).toBe("img-1");

    const step2 = upsertImageTab(step1.tabs, second);
    expect(step2.tabs).toHaveLength(2);
    expect(step2.activeTabId).toBe("img-2");

    // Clicking the same imagePath with a different attachment id reuses the existing tab
    const dupByPath = buildImageTabFromAttachment({
      id: "img-1-resent",
      kind: "image",
      label: "Pasted Image",
      imagePath: "/tmp/paste-1.png",
      imageDataUrl: "data:image/png;base64,ONE",
    }).tab;
    const step3 = upsertImageTab(step2.tabs, dupByPath);
    expect(step3.tabs).toHaveLength(2);
    expect(step3.activeTabId).toBe("img-1");

    // Closing the active first tab focuses the adjacent second tab
    const afterClose1 = closeImageTab(step3.tabs, "img-1", "img-1");
    expect(afterClose1.tabs.map((t) => t.id)).toEqual(["img-2"]);
    expect(afterClose1.activeTabId).toBe("img-2");

    // Closing the last tab yields empty list and null activeTabId
    const afterClose2 = closeImageTab(afterClose1.tabs, afterClose1.activeTabId, "img-2");
    expect(afterClose2.tabs).toEqual([]);
    expect(afterClose2.activeTabId).toBeNull();
  });

  it("steps, clamps, and formats zoom levels cleanly", () => {
    expect(formatZoomLabel("fit", 1)).toBe("Fit");
    expect(formatZoomLabel("custom", 1)).toBe("100%");
    expect(formatZoomLabel("custom", 1.5)).toBe("150%");

    expect(stepZoom(1, "in")).toBe(1.25);
    expect(stepZoom(1.25, "in")).toBe(1.5);
    expect(stepZoom(MAX_ZOOM, "in")).toBe(MAX_ZOOM);

    expect(stepZoom(1, "out")).toBe(0.75);
    expect(stepZoom(MIN_ZOOM, "out")).toBe(MIN_ZOOM);

    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(MIN_ZOOM).toBe(0.25);
    expect(MAX_ZOOM).toBe(5);
  });

  it("computes smooth trackpad pinch / wheel zoom scales with clamping and symmetry", () => {
    // Detects trackpad pinch (ctrlKey) and Cmd/Ctrl+wheel while ignoring normal two-finger scroll
    expect(isPinchOrZoomWheelEvent({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(isPinchOrZoomWheelEvent({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(isPinchOrZoomWheelEvent({ ctrlKey: false, metaKey: false })).toBe(false);

    // Normalizes pixel, line, and page delta modes
    expect(normalizeWheelDeltaY(-10, 0)).toBe(-10);
    expect(normalizeWheelDeltaY(-3, 1)).toBe(-48);
    expect(normalizeWheelDeltaY(1, 2)).toBe(400);
    expect(normalizeWheelDeltaY(Number.NaN, 0)).toBe(0);

    // Negative deltaY zooms in; positive deltaY zooms out smoothly and reversibly
    const zoomedIn = computeNextWheelZoom(1, -10);
    expect(zoomedIn).toBeCloseTo(Math.exp(0.1), 6);
    expect(computeNextWheelZoom(zoomedIn, 10)).toBeCloseTo(1, 6);

    // Transitions cleanly from a rendered fit scale (e.g. 0.5) without jumping to 1.0
    const fromFit = computeNextWheelZoom(0.5, -5);
    expect(fromFit).toBeCloseTo(0.5 * Math.exp(0.05), 6);

    // Clamps cleanly to [0.25, 5.0] even for extreme wheel deltas
    expect(computeNextWheelZoom(4.5, -100)).toBe(MAX_ZOOM);
    expect(computeNextWheelZoom(1, -100_000)).toBe(MAX_ZOOM);
    expect(computeNextWheelZoom(0.3, 100)).toBe(MIN_ZOOM);
    expect(computeNextWheelZoom(1, 100_000)).toBe(MIN_ZOOM);
    expect(computeNextWheelZoom(1.5, 0)).toBe(1.5);
    expect(computeNextWheelZoom(Number.NaN, -10)).toBe(1);

    // Computes fit scale without upscaling small images past 100%
    expect(computeFitScale(1000, 800, 468, 368)).toBeCloseTo(0.46, 6);
    expect(computeFitScale(200, 100, 500, 400)).toBe(1);
    expect(computeFitScale(0, 100, 500, 400)).toBe(1);
  });

  it("computes cursor-anchored scroll offsets across fit-to-custom and zoomed transitions", () => {
    // 1. Center-anchored zoom from fit (0.46) to 2x fit (0.92) centers the scrollbars exactly
    const centered = computeCursorAnchoredScroll({
      prevScale: 0.46,
      nextScale: 0.92,
      naturalWidth: 1000,
      naturalHeight: 800,
      viewportWidth: 500,
      viewportHeight: 400,
      scrollLeft: 0,
      scrollTop: 0,
      cursorX: 250,
      cursorY: 200,
      padding: IMAGE_VIEWPORT_PADDING_PX,
    });
    // Content size becomes (920 + 32) x (736 + 32) => maxScroll = 452 x 368 => half = 226 x 184
    expect(centered.scrollLeft).toBeCloseTo(226, 4);
    expect(centered.scrollTop).toBeCloseTo(184, 4);

    // 2. Arbitrary cursor point stays fixed on the exact same relative image coordinate
    const prevScale = 1.0;
    const nextScale = 1.5;
    const cursorX = 300;
    const cursorY = 220;
    const scrollLeft = 150;
    const scrollTop = 100;
    const anchored = computeCursorAnchoredScroll({
      prevScale,
      nextScale,
      naturalWidth: 1000,
      naturalHeight: 800,
      viewportWidth: 500,
      viewportHeight: 400,
      scrollLeft,
      scrollTop,
      cursorX,
      cursorY,
      padding: IMAGE_VIEWPORT_PADDING_PX,
    });
    expect(anchored.scrollLeft).toBeCloseTo(367, 4);
    expect(anchored.scrollTop).toBeCloseTo(252, 4);

    // Verify image fraction under cursor before and after zoom is identical
    const prevFracX = (scrollLeft + cursorX - IMAGE_VIEWPORT_PADDING_PX) / (1000 * prevScale);
    const nextFracX = (anchored.scrollLeft + cursorX - IMAGE_VIEWPORT_PADDING_PX) / (1000 * nextScale);
    const prevFracY = (scrollTop + cursorY - IMAGE_VIEWPORT_PADDING_PX) / (800 * prevScale);
    const nextFracY = (anchored.scrollTop + cursorY - IMAGE_VIEWPORT_PADDING_PX) / (800 * nextScale);
    expect(nextFracX).toBeCloseTo(prevFracX, 6);
    expect(nextFracY).toBeCloseTo(prevFracY, 6);

    // 3. Top-left cursor clamps at 0; bottom-right cursor clamps at maxScroll
    const topLeft = computeCursorAnchoredScroll({
      prevScale: 0.46,
      nextScale: 0.92,
      naturalWidth: 1000,
      naturalHeight: 800,
      viewportWidth: 500,
      viewportHeight: 400,
      scrollLeft: 0,
      scrollTop: 0,
      cursorX: 20,
      cursorY: 16,
      padding: IMAGE_VIEWPORT_PADDING_PX,
    });
    expect(topLeft).toEqual({ scrollLeft: 0, scrollTop: 0 });

    const bottomRight = computeCursorAnchoredScroll({
      prevScale: 0.46,
      nextScale: 0.92,
      naturalWidth: 1000,
      naturalHeight: 800,
      viewportWidth: 500,
      viewportHeight: 400,
      scrollLeft: 0,
      scrollTop: 0,
      cursorX: 480,
      cursorY: 384,
      padding: IMAGE_VIEWPORT_PADDING_PX,
    });
    expect(bottomRight.scrollLeft).toBeCloseTo(452, 4);
    expect(bottomRight.scrollTop).toBeCloseTo(368, 4);

    // 4. When scaled image still fits inside viewport, scroll remains (0, 0)
    const fitsViewport = computeCursorAnchoredScroll({
      prevScale: 0.25,
      nextScale: 0.4,
      naturalWidth: 500,
      naturalHeight: 400,
      viewportWidth: 600,
      viewportHeight: 500,
      scrollLeft: 0,
      scrollTop: 0,
      cursorX: 300,
      cursorY: 250,
      padding: IMAGE_VIEWPORT_PADDING_PX,
    });
    expect(fitsViewport).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });
});
