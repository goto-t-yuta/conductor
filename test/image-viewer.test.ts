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
  extractImageFileName,
  formatZoomLabel,
  isDirectRenderableImageUrl,
  isLocalImagePathOrFileUrl,
  isViewableImageAttachment,
  MAX_ZOOM,
  MIN_ZOOM,
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
  });
});
