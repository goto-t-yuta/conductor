import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MarkdownFileWatcher,
  readLocalMarkdownFile,
  resolveLocalMarkdownPath,
} from "../src/main/markdown-viewer.js";
import { MarkdownImageCache } from "../src/renderer/lib/markdown-image-cache.js";
import {
  classifyLinkHref,
  classifyMarkdownImageSrc,
  computeDocumentStats,
  extractMarkdownHeadings,
  isMarkdownPathOrUrl,
  resolveMarkdownImagePath,
  slugifyHeading,
  transformMarkdownUrl,
} from "../src/renderer/lib/markdown-utils.js";
import type { MarkdownWatchEvent } from "../src/shared/types.js";

function waitFor(
  predicate: () => boolean,
  timeoutMs = 2500,
  intervalMs = 30,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for condition`));
      }
    }, intervalMs);
  });
}

describe("Local Markdown Viewer (main service)", () => {
  it("resolves absolute paths, file:// URLs with spaces & fragments, and relative links safely", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-md-resolve-"));
    try {
      const spacedFile = path.join(tmpDir, "my notes.md");
      fs.writeFileSync(spacedFile, "# Notes\n");

      const fileUrl = `${pathToFileURL(spacedFile).toString()}#L10-L20`;
      const fromUrl = resolveLocalMarkdownPath(fileUrl);
      expect(fromUrl.ok).toBe(true);
      if (fromUrl.ok) {
        expect(fromUrl.filePath).toBe(spacedFile);
        expect(fromUrl.hash).toBe("L10-L20");
      }

      const relResolved = resolveLocalMarkdownPath("./other.markdown#intro", spacedFile);
      expect(relResolved.ok).toBe(true);
      if (relResolved.ok) {
        expect(relResolved.filePath).toBe(path.join(tmpDir, "other.markdown"));
        expect(relResolved.hash).toBe("intro");
      }

      // Rejects relative paths without baseFilePath
      expect(resolveLocalMarkdownPath("README.md").ok).toBe(false);
      // Rejects non-markdown extensions
      expect(resolveLocalMarkdownPath("/etc/passwd").ok).toBe(false);
      expect(resolveLocalMarkdownPath(path.join(tmpDir, ".env")).ok).toBe(false);
      // Rejects null bytes
      expect(resolveLocalMarkdownPath("/tmp/bad\0.md").ok).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reads valid markdown files and blocks symlinks pointing to non-markdown targets", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-md-read-"));
    try {
      const mdPath = path.join(tmpDir, "guide.md");
      fs.writeFileSync(mdPath, "# Guide\n\nHello **Conductor**!\n", "utf8");

      const res = readLocalMarkdownFile(mdPath);
      expect(res.ok).toBe(true);
      expect(res.document?.fileName).toBe("guide.md");
      expect(res.document?.content).toContain("Hello **Conductor**!");
      expect(res.document?.sizeBytes).toBeGreaterThan(0);

      // Symlink from .md to .txt must be blocked
      const secretPath = path.join(tmpDir, "secret.txt");
      fs.writeFileSync(secretPath, "top-secret", "utf8");
      const evilLink = path.join(tmpDir, "sneaky.md");
      fs.symlinkSync(secretPath, evilLink);

      const blocked = readLocalMarkdownFile(evilLink);
      expect(blocked.ok).toBe(false);
      expect(blocked.document).toBeUndefined();

      // Missing file returns clean error
      const missing = readLocalMarkdownFile(path.join(tmpDir, "does-not-exist.md"));
      expect(missing.ok).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("watches local markdown files for live reload, handles atomic saves & deletion, and cleans up", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-md-watch-"));
    const mdPath = path.join(tmpDir, "live.md");
    fs.writeFileSync(mdPath, "# V1\n", "utf8");

    const events: MarkdownWatchEvent[] = [];
    const watcher = new MarkdownFileWatcher((ev) => events.push(ev), 40);

    try {
      const started = watcher.watch(mdPath);
      expect(started.ok).toBe(true);
      expect(watcher.getWatchedFilePath()).toBe(mdPath);

      // Direct write update
      fs.writeFileSync(mdPath, "# V2\nUpdated body\n", "utf8");
      await waitFor(() =>
        events.some((e) => e.kind === "changed" && e.document?.content.includes("# V2")),
      );

      // Atomic save (temp file + rename)
      const tmpSave = path.join(tmpDir, ".live.md.tmp");
      fs.writeFileSync(tmpSave, "# V3\nAtomic save\n", "utf8");
      fs.renameSync(tmpSave, mdPath);
      await waitFor(() =>
        events.some((e) => e.kind === "changed" && e.document?.content.includes("# V3")),
      );

      // File deletion
      fs.unlinkSync(mdPath);
      await waitFor(() => events.some((e) => e.kind === "deleted"));

      // Cleanup stops further notifications
      watcher.unwatch();
      expect(watcher.getWatchedFilePath()).toBeNull();
      const countBefore = events.length;
      fs.writeFileSync(mdPath, "# V4 after unwatch\n", "utf8");
      await new Promise((r) => setTimeout(r, 150));
      expect(events.length).toBe(countBefore);
    } finally {
      watcher.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Local Markdown Viewer (renderer utils)", () => {
  it("classifies web, file:// markdown, relative markdown, and anchor links accurately", () => {
    expect(classifyLinkHref("https://example.com/docs")).toEqual({
      kind: "web",
      url: "https://example.com/docs",
    });

    expect(classifyLinkHref("file:///Users/me/README.md#L10-L20")).toEqual({
      kind: "markdown",
      target: "file:///Users/me/README.md#L10-L20",
      hash: "L10-L20",
    });

    expect(classifyLinkHref("./docs/spec.markdown#api", "/Users/me/README.md")).toEqual({
      kind: "markdown",
      target: "./docs/spec.markdown#api",
      baseFilePath: "/Users/me/README.md",
      hash: "api",
    });

    expect(classifyLinkHref("#getting-started")).toEqual({
      kind: "anchor",
      id: "getting-started",
    });

    expect(classifyLinkHref("file:///Users/me/index.ts").kind).toBe("other");
    expect(isMarkdownPathOrUrl("file:///Users/me/notes.mdx?raw=1#top")).toBe(true);
  });

  it("extracts headings for TOC while ignoring fenced code blocks and deduplicating slugs", () => {
    const sample = [
      "# Main Title",
      "",
      "```bash",
      "# Not a heading inside code fence",
      "echo hi",
      "```",
      "",
      "## Overview",
      "### **Detailed** `Setup`",
      "## Overview",
      "## 使い方ガイド",
      "~~~md",
      "## Also ignored in tilde fence",
      "~~~",
    ].join("\n");

    const headings = extractMarkdownHeadings(sample);
    expect(headings.map((h) => ({ level: h.level, text: h.text, id: h.id }))).toEqual([
      { level: 1, text: "Main Title", id: "main-title" },
      { level: 2, text: "Overview", id: "overview" },
      { level: 3, text: "Detailed Setup", id: "detailed-setup" },
      { level: 2, text: "Overview", id: "overview-1" },
      { level: 2, text: "使い方ガイド", id: "使い方ガイド" },
    ]);

    expect(slugifyHeading("Hello, World!")).toBe("hello-world");
    expect(computeDocumentStats("one two\nthree")).toEqual({ lines: 2, words: 3, chars: 13 });
  });

  it("classifies and resolves relative, absolute, file://, remote, inline data:, and invalid Markdown image URLs", () => {
    const baseMd = "/Users/dev/conductor/README.md";
    const nestedMd = "/Users/dev/conductor/docs/guide.md";

    // Relative paths resolved against baseFilePath directory
    const relNoDot = classifyMarkdownImageSrc("docs/images/overview.png", baseMd);
    expect(relNoDot).toEqual({
      kind: "local",
      target: "docs/images/overview.png",
      baseFilePath: baseMd,
      resolvedPath: "/Users/dev/conductor/docs/images/overview.png",
      cacheKey: "/Users/dev/conductor/docs/images/overview.png",
    });

    // ./ relative path normalizes to the exact same cacheKey
    const relDot = classifyMarkdownImageSrc("./docs/images/overview.png?raw=1#dark", baseMd);
    expect(relDot).toEqual({
      kind: "local",
      target: "./docs/images/overview.png?raw=1#dark",
      baseFilePath: baseMd,
      resolvedPath: "/Users/dev/conductor/docs/images/overview.png",
      cacheKey: "/Users/dev/conductor/docs/images/overview.png",
    });

    // ../ parent traversal and percent-encoded Japanese / spaces
    const relParent = classifyMarkdownImageSrc(
      "../assets/%E7%94%BB%E5%83%8F%201.png",
      nestedMd,
    );
    expect(relParent).toEqual({
      kind: "local",
      target: "../assets/%E7%94%BB%E5%83%8F%201.png",
      baseFilePath: nestedMd,
      resolvedPath: "/Users/dev/conductor/assets/画像 1.png",
      cacheKey: "/Users/dev/conductor/assets/画像 1.png",
    });

    // Absolute local path (works even without baseFilePath)
    expect(classifyMarkdownImageSrc("/Users/dev/Desktop/shot.png")).toEqual({
      kind: "local",
      target: "/Users/dev/Desktop/shot.png",
      resolvedPath: "/Users/dev/Desktop/shot.png",
      cacheKey: "/Users/dev/Desktop/shot.png",
    });

    // Home-relative path
    expect(classifyMarkdownImageSrc("~/Desktop/shot.png")).toEqual({
      kind: "local",
      target: "~/Desktop/shot.png",
      resolvedPath: "~/Desktop/shot.png",
      cacheKey: "~/Desktop/shot.png",
    });

    // file:// URL with spaces & query/hash
    expect(
      classifyMarkdownImageSrc("file:///Users/dev/my%20shots/%E5%9B%B3.png?v=2#top"),
    ).toEqual({
      kind: "local",
      target: "file:///Users/dev/my%20shots/%E5%9B%B3.png?v=2#top",
      resolvedPath: "/Users/dev/my shots/図.png",
      cacheKey: "/Users/dev/my shots/図.png",
    });

    // Remote http/https, protocol-relative, inline data:image/*, blob: stay direct
    expect(classifyMarkdownImageSrc("https://example.com/a.png?w=800")).toEqual({
      kind: "direct",
      src: "https://example.com/a.png?w=800",
    });
    expect(classifyMarkdownImageSrc("http://localhost:3000/preview.png")).toEqual({
      kind: "direct",
      src: "http://localhost:3000/preview.png",
    });
    expect(classifyMarkdownImageSrc("//cdn.example.com/badge.svg")).toEqual({
      kind: "direct",
      src: "https://cdn.example.com/badge.svg",
    });
    expect(classifyMarkdownImageSrc("data:image/png;base64,iVBORw0KGgo=")).toEqual({
      kind: "direct",
      src: "data:image/png;base64,iVBORw0KGgo=",
    });

    // Relative path without baseFilePath returns invalid with clean fallback message
    expect(classifyMarkdownImageSrc("docs/images/foo.png").kind).toBe("invalid");
    // Disallowed schemes rejected
    expect(classifyMarkdownImageSrc("javascript:alert(1)").kind).toBe("invalid");
    expect(classifyMarkdownImageSrc("data:text/html,<script>alert(1)</script>").kind).toBe(
      "invalid",
    );
    expect(resolveMarkdownImagePath("docs/images/foo.png")).toBeNull();
  });

  it("preserves safe file:// and data:image/* URLs in transformMarkdownUrl while blocking unsafe schemes", () => {
    const strictFallback = (value: string) =>
      /^(https?:\/\/|\/|\.|[^:]+$)/i.test(value) ? value : "";

    expect(transformMarkdownUrl("file:///Users/me/pic.png", "src", strictFallback)).toBe(
      "file:///Users/me/pic.png",
    );
    expect(
      transformMarkdownUrl("data:image/png;base64,AAAA", "src", strictFallback),
    ).toBe("data:image/png;base64,AAAA");
    expect(transformMarkdownUrl("file:///Users/me/doc.md", "href", strictFallback)).toBe(
      "file:///Users/me/doc.md",
    );
    expect(transformMarkdownUrl("javascript:alert(1)", "src", strictFallback)).toBe("");
    expect(
      transformMarkdownUrl("data:text/html,<h1>x</h1>", "src", strictFallback),
    ).toBe("");
  });

  it("caches loaded local images, deduplicates in-flight requests, handles failure retry, and evicts LRU", async () => {
    const cache = new MarkdownImageCache(2);
    const loader = vi.fn(async (target: string, baseFilePath?: string) => ({
      ok: true,
      filePath: `/repo/${target.replace(/^\.\//, "")}`,
      fileName: target.split("/").pop(),
      dataUrl: `data:image/png;base64,DATA_${target}_${baseFilePath ?? ""}`,
      mimeType: "image/png",
      sizeBytes: 10,
    }));

    // Concurrent requests for the same key only invoke loader once
    const [r1, r2] = await Promise.all([
      cache.load({
        target: "docs/a.png",
        baseFilePath: "/repo/README.md",
        cacheKey: "/repo/docs/a.png",
        loader,
      }),
      cache.load({
        target: "docs/a.png",
        baseFilePath: "/repo/README.md",
        cacheKey: "/repo/docs/a.png",
        loader,
      }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.dataUrl).toBe(r1.dataUrl);
    expect(loader).toHaveBeenCalledTimes(1);

    // Subsequent cache hit avoids IPC
    const r3 = await cache.load({
      target: "./docs/a.png",
      baseFilePath: "/repo/README.md",
      cacheKey: "/repo/docs/a.png",
      loader,
    });
    expect(r3.ok).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);

    // forceReload refreshes from loader
    await cache.load({
      target: "docs/a.png",
      baseFilePath: "/repo/README.md",
      cacheKey: "/repo/docs/a.png",
      forceReload: true,
      loader,
    });
    expect(loader).toHaveBeenCalledTimes(2);

    // Failed load is NOT cached, so a subsequent retry succeeds
    const flakyLoader = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, filePath: "/repo/docs/b.png", error: "一時エラー" })
      .mockResolvedValueOnce({
        ok: true,
        filePath: "/repo/docs/b.png",
        dataUrl: "data:image/png;base64,RECOVERED",
      });
    const failed = await cache.load({
      target: "docs/b.png",
      baseFilePath: "/repo/README.md",
      cacheKey: "/repo/docs/b.png",
      loader: flakyLoader,
    });
    expect(failed.ok).toBe(false);
    expect(cache.get("/repo/docs/b.png")).toBeNull();

    const recovered = await cache.load({
      target: "docs/b.png",
      baseFilePath: "/repo/README.md",
      cacheKey: "/repo/docs/b.png",
      loader: flakyLoader,
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.dataUrl).toBe("data:image/png;base64,RECOVERED");

    // LRU eviction (maxEntries = 2): adding c.png evicts oldest (a.png)
    await cache.load({
      target: "docs/c.png",
      baseFilePath: "/repo/README.md",
      cacheKey: "/repo/docs/c.png",
      loader,
    });
    expect(cache.size()).toBe(2);
    expect(cache.get("/repo/docs/a.png")).toBeNull();
    expect(cache.get("/repo/docs/b.png")).not.toBeNull();
    expect(cache.get("/repo/docs/c.png")).not.toBeNull();

    // Missing loader returns clean error fallback without throwing
    const noLoaderRes = await cache.load({
      target: "docs/d.png",
      cacheKey: "/repo/docs/d.png",
    });
    expect(noLoaderRes.ok).toBe(false);
    expect(noLoaderRes.error).toBeTruthy();
  });
});
