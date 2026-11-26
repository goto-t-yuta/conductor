import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_MARKDOWN_FILE_BYTES,
  MarkdownFileWatcher,
  readLocalMarkdownFile,
  resolveLocalMarkdownPath,
  writeLocalMarkdownFile,
} from "../src/main/markdown-viewer.js";
import {
  applyMarkdownDiskDeleted,
  applyMarkdownDiskReload,
  applyMarkdownDraftEdit,
  applyTextareaIndent,
  beginMarkdownSave,
  completeMarkdownSave,
  discardMarkdownDraft,
  dismissMarkdownExternalChange,
  getEffectiveMarkdownContent,
  setMarkdownTabViewMode,
} from "../src/renderer/lib/markdown-editor-state.js";
import type { MarkdownViewerTab } from "../src/renderer/lib/right-pane-tabs.js";
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

  it("writes UTF-8 markdown files safely, returns updated metadata, and enforces security boundaries", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-md-write-"));
    try {
      const mdPath = path.join(tmpDir, "notes.md");
      fs.writeFileSync(mdPath, "# Initial\n", "utf8");

      const updatedContent = "# 更新済みタイトル\n\n本文テキスト 🚀\n";
      const writeRes = writeLocalMarkdownFile(mdPath, updatedContent);
      expect(writeRes.ok).toBe(true);
      expect(writeRes.filePath).toBe(mdPath);
      expect(writeRes.document?.fileName).toBe("notes.md");
      expect(writeRes.document?.content).toBe(updatedContent);
      expect(writeRes.document?.sizeBytes).toBe(Buffer.byteLength(updatedContent, "utf8"));
      expect(writeRes.document?.mtimeMs).toBeGreaterThan(0);
      expect(fs.readFileSync(mdPath, "utf8")).toBe(updatedContent);

      // Writes via file:// URL cleanly
      const fileUrlRes = writeLocalMarkdownFile(pathToFileURL(mdPath).toString(), "# Via URL\n");
      expect(fileUrlRes.ok).toBe(true);
      expect(fs.readFileSync(mdPath, "utf8")).toBe("# Via URL\n");

      // Allows writing through a symlink pointing to a valid .md target
      const targetMd = path.join(tmpDir, "real-target.md");
      fs.writeFileSync(targetMd, "# Real\n", "utf8");
      const validLink = path.join(tmpDir, "alias.md");
      fs.symlinkSync(targetMd, validLink);
      const validLinkRes = writeLocalMarkdownFile(validLink, "# Updated via link\n");
      expect(validLinkRes.ok).toBe(true);
      expect(fs.readFileSync(targetMd, "utf8")).toBe("# Updated via link\n");
      expect(fs.lstatSync(validLink).isSymbolicLink()).toBe(true);

      // Blocks symlinks pointing to non-markdown files
      const secretTxt = path.join(tmpDir, "secret.txt");
      fs.writeFileSync(secretTxt, "keep-untouched", "utf8");
      const evilLink = path.join(tmpDir, "evil.md");
      fs.symlinkSync(secretTxt, evilLink);
      const blockedSymlink = writeLocalMarkdownFile(evilLink, "pwned");
      expect(blockedSymlink.ok).toBe(false);
      expect(fs.readFileSync(secretTxt, "utf8")).toBe("keep-untouched");

      // Blocks broken symlinks
      const brokenLink = path.join(tmpDir, "broken.md");
      fs.symlinkSync(path.join(tmpDir, "nonexistent.txt"), brokenLink);
      const blockedBroken = writeLocalMarkdownFile(brokenLink, "# Nope\n");
      expect(blockedBroken.ok).toBe(false);

      // Blocks non-markdown extensions, relative paths, null bytes, directories, and oversized payloads
      expect(writeLocalMarkdownFile(path.join(tmpDir, "plain.txt"), "hello").ok).toBe(false);
      expect(writeLocalMarkdownFile("relative.md", "# rel").ok).toBe(false);
      expect(writeLocalMarkdownFile(path.join(tmpDir, "bad\0.md"), "# bad").ok).toBe(false);
      const dirWithMdExt = path.join(tmpDir, "folder.md");
      fs.mkdirSync(dirWithMdExt);
      expect(writeLocalMarkdownFile(dirWithMdExt, "# dir").ok).toBe(false);

      const oversized = "a".repeat(MAX_MARKDOWN_FILE_BYTES + 1);
      expect(writeLocalMarkdownFile(mdPath, oversized).ok).toBe(false);

      // Can recreate a deleted .md file when its parent directory exists
      fs.unlinkSync(mdPath);
      const recreated = writeLocalMarkdownFile(mdPath, "# Recreated\n");
      expect(recreated.ok).toBe(true);
      expect(fs.readFileSync(mdPath, "utf8")).toBe("# Recreated\n");

      // Rejects when parent directory does not exist
      const missingParent = path.join(tmpDir, "missing-dir", "doc.md");
      expect(writeLocalMarkdownFile(missingParent, "# No parent\n").ok).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("suppresses self-triggered watcher events via recordKnownDocument while still emitting external edits", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-md-selfsave-"));
    const mdPath = path.join(tmpDir, "doc.md");
    fs.writeFileSync(mdPath, "# V1\n", "utf8");

    const events: MarkdownWatchEvent[] = [];
    const watcher = new MarkdownFileWatcher((ev) => events.push(ev), 40);

    try {
      expect(watcher.watch(mdPath).ok).toBe(true);

      // Self-write followed by recordKnownDocument should NOT emit a watcher change event
      const saved = writeLocalMarkdownFile(mdPath, "# Saved by Conductor\n");
      expect(saved.ok).toBe(true);
      watcher.recordKnownDocument(saved.document!);

      await new Promise((r) => setTimeout(r, 150));
      expect(events).toHaveLength(0);

      // Subsequent external write MUST still emit a change event
      fs.writeFileSync(mdPath, "# Edited externally\n", "utf8");
      await waitFor(() =>
        events.some((e) => e.kind === "changed" && e.document?.content.includes("Edited externally")),
      );
    } finally {
      watcher.dispose();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Local Markdown Editor State (draft, dirty, save, discard, auto-reload safety)", () => {
  const makeBaseTab = (content = "# Title\n\nBody\n"): MarkdownViewerTab => ({
    filePath: "/repo/docs/spec.md",
    fileName: "spec.md",
    document: {
      filePath: "/repo/docs/spec.md",
      fileName: "spec.md",
      content,
      mtimeMs: 1_700_000_000_000,
      sizeBytes: Buffer.byteLength(content, "utf8"),
    },
    error: null,
    deletedOnDisk: false,
    isLoading: false,
    lastReloadedAt: 1_700_000_000_000,
  });

  it("tracks draft edits, clears dirty when reverted back to saved content, and preserves viewMode", () => {
    const initial = setMarkdownTabViewMode(makeBaseTab(), "raw");
    expect(getEffectiveMarkdownContent(initial)).toBe("# Title\n\nBody\n");
    expect(initial.isDirty).toBeFalsy();

    const edited = applyMarkdownDraftEdit(initial, "# Title\n\nEdited Body\n");
    expect(edited.isDirty).toBe(true);
    expect(edited.draftContent).toBe("# Title\n\nEdited Body\n");
    expect(getEffectiveMarkdownContent(edited)).toBe("# Title\n\nEdited Body\n");
    expect(edited.viewMode).toBe("raw");

    // Toggling to preview preserves draft & dirty state
    const previewed = setMarkdownTabViewMode(edited, "rendered");
    expect(previewed.isDirty).toBe(true);
    expect(getEffectiveMarkdownContent(previewed)).toBe("# Title\n\nEdited Body\n");

    // Editing back to exact saved content automatically clears dirty state
    const reverted = applyMarkdownDraftEdit(previewed, "# Title\n\nBody\n");
    expect(reverted.isDirty).toBe(false);
    expect(reverted.draftContent).toBeNull();
  });

  it("handles save lifecycle cleanly including failure recovery and concurrent edits during save", () => {
    const edited = applyMarkdownDraftEdit(makeBaseTab(), "# Saved Draft\n");
    const saving = beginMarkdownSave(edited);
    expect(saving.isSaving).toBe(true);

    // Failed save retains draft & dirty state and exposes saveError
    const failed = completeMarkdownSave(
      saving,
      { ok: false, filePath: edited.filePath, error: "EACCES: permission denied" },
      1_700_000_005_000,
    );
    expect(failed.isSaving).toBe(false);
    expect(failed.isDirty).toBe(true);
    expect(failed.saveError).toBe("EACCES: permission denied");
    expect(getEffectiveMarkdownContent(failed)).toBe("# Saved Draft\n");

    // Successful save clears dirty state and records lastSavedAt
    const savedDoc = {
      filePath: edited.filePath,
      fileName: edited.fileName,
      content: "# Saved Draft\n",
      mtimeMs: 1_700_000_010_000,
      sizeBytes: 14,
    };
    const saved = completeMarkdownSave(
      beginMarkdownSave(failed),
      { ok: true, filePath: edited.filePath, document: savedDoc },
      1_700_000_010_000,
    );
    expect(saved.isSaving).toBe(false);
    expect(saved.isDirty).toBe(false);
    expect(saved.draftContent).toBeNull();
    expect(saved.saveError).toBeNull();
    expect(saved.lastSavedAt).toBe(1_700_000_010_000);
    expect(saved.document).toEqual(savedDoc);

    // Concurrent edit typed while save was in flight is preserved as dirty!
    const typingWhileSaving = applyMarkdownDraftEdit(
      beginMarkdownSave(edited),
      "# Saved Draft\n+ extra typing\n",
    );
    const afterInflightSave = completeMarkdownSave(
      typingWhileSaving,
      { ok: true, filePath: edited.filePath, document: savedDoc },
      1_700_000_010_000,
    );
    expect(afterInflightSave.isDirty).toBe(true);
    expect(afterInflightSave.document).toEqual(savedDoc);
    expect(getEffectiveMarkdownContent(afterInflightSave)).toBe("# Saved Draft\n+ extra typing\n");
  });

  it("protects unsaved drafts from watcher auto-reload, ignores self-save echoes, and allows explicit discard/reload", () => {
    const base = makeBaseTab("# V1\n");

    // Clean tab auto-reloads normally on external change
    const v2Doc = {
      ...base.document!,
      content: "# V2 external\n",
      mtimeMs: 1_700_000_020_000,
      sizeBytes: 14,
    };
    const cleanReload = applyMarkdownDiskReload(base, v2Doc, 1_700_000_020_000);
    expect(cleanReload.didReload).toBe(true);
    expect(cleanReload.hasExternalConflict).toBe(false);
    expect(cleanReload.tab.document?.content).toBe("# V2 external\n");

    // Dirty tab ignores self-save echo cleanly (even if user typed more edits right after saving)
    const dirtyAfterSave = applyMarkdownDraftEdit(cleanReload.tab, "# V2 external\nmore edits\n");
    const echoResult = applyMarkdownDiskReload(dirtyAfterSave, v2Doc, 1_700_000_020_100, {
      lastSelfSavedDoc: v2Doc,
    });
    expect(echoResult.ignoredSelfSave).toBe(true);
    expect(echoResult.didReload).toBe(false);
    expect(echoResult.hasExternalConflict).toBe(false);
    expect(echoResult.tab.externalChange).toBeFalsy();
    expect(getEffectiveMarkdownContent(echoResult.tab)).toBe("# V2 external\nmore edits\n");

    // External change while dirty MUST NOT overwrite draft; sets non-destructive externalChange banner
    const v3ExternalDoc = {
      ...base.document!,
      content: "# V3 from another editor\n",
      mtimeMs: 1_700_000_030_000,
      sizeBytes: 25,
    };
    const conflictResult = applyMarkdownDiskReload(dirtyAfterSave, v3ExternalDoc, 1_700_000_030_000);
    expect(conflictResult.didReload).toBe(false);
    expect(conflictResult.hasExternalConflict).toBe(true);
    expect(conflictResult.tab.isDirty).toBe(true);
    expect(getEffectiveMarkdownContent(conflictResult.tab)).toBe("# V2 external\nmore edits\n");
    expect(conflictResult.tab.externalChange?.kind).toBe("changed");
    expect(conflictResult.tab.externalChange?.document).toEqual(v3ExternalDoc);

    // Dismissing banner keeps draft intact
    const dismissed = dismissMarkdownExternalChange(conflictResult.tab);
    expect(dismissed.externalChange).toBeNull();
    expect(dismissed.isDirty).toBe(true);

    // Explicit force reload / discard replaces draft with disk document
    const forced = applyMarkdownDiskReload(conflictResult.tab, v3ExternalDoc, 1_700_000_040_000, {
      force: true,
    });
    expect(forced.didReload).toBe(true);
    expect(forced.tab.isDirty).toBe(false);
    expect(forced.tab.draftContent).toBeNull();
    expect(forced.tab.externalChange).toBeNull();
    expect(getEffectiveMarkdownContent(forced.tab)).toBe("# V3 from another editor\n");

    // External deletion while dirty preserves draft so user can still save/recreate
    const dirtyAgain = applyMarkdownDraftEdit(forced.tab, "# Keep my draft\n");
    const deletedWhileDirty = applyMarkdownDiskDeleted(dirtyAgain, undefined, 1_700_000_050_000);
    expect(deletedWhileDirty.deletedOnDisk).toBe(true);
    expect(deletedWhileDirty.isDirty).toBe(true);
    expect(deletedWhileDirty.externalChange?.kind).toBe("deleted");
    expect(getEffectiveMarkdownContent(deletedWhileDirty)).toBe("# Keep my draft\n");

    // Discard with fresh disk doc restores clean state
    const discarded = discardMarkdownDraft(dirtyAgain, v3ExternalDoc, 1_700_000_060_000);
    expect(discarded.isDirty).toBe(false);
    expect(discarded.draftContent).toBeNull();
    expect(getEffectiveMarkdownContent(discarded)).toBe("# V3 from another editor\n");
  });

  it("indents and unindents single lines and multi-line selections cleanly with Tab / Shift+Tab", () => {
    // Caret insert
    const single = applyTextareaIndent("- item", 0, 0, false);
    expect(single).toEqual({ value: "  - item", selectionStart: 2, selectionEnd: 2 });

    // Multi-line indent
    const multi = applyTextareaIndent("line1\nline2\nline3", 0, 11, false);
    expect(multi.value).toBe("  line1\n  line2\nline3");
    expect(multi.selectionStart).toBe(2);
    expect(multi.selectionEnd).toBe(15);

    // Multi-line Shift+Tab outdent
    const outdented = applyTextareaIndent("  line1\n  line2\nline3", 2, 15, true);
    expect(outdented.value).toBe("line1\nline2\nline3");
    expect(outdented.selectionStart).toBe(0);
    expect(outdented.selectionEnd).toBe(11);
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
