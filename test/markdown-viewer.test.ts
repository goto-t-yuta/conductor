import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MarkdownFileWatcher,
  readLocalMarkdownFile,
  resolveLocalMarkdownPath,
} from "../src/main/markdown-viewer.js";
import {
  classifyLinkHref,
  computeDocumentStats,
  extractMarkdownHeadings,
  isMarkdownPathOrUrl,
  slugifyHeading,
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
});
