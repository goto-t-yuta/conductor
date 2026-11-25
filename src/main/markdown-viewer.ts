import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MarkdownDocument, MarkdownReadResult, MarkdownWatchEvent } from "../shared/types.js";

export const ALLOWED_MARKDOWN_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
  ".mdx",
]);

export const MAX_MARKDOWN_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

export function isAllowedMarkdownExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ALLOWED_MARKDOWN_EXTENSIONS.has(ext);
}

export type ResolvedMarkdownPath =
  | { ok: true; filePath: string; hash: string | null }
  | { ok: false; error: string };

export function resolveLocalMarkdownPath(
  input: string,
  baseFilePath?: string,
): ResolvedMarkdownPath {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "ファイルパスが空です。" };
  }
  if (trimmed.includes("\0")) {
    return { ok: false, error: "不正なファイルパスです。" };
  }

  let rawPath = trimmed;
  let hash: string | null = null;

  if (/^file:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      hash = parsed.hash ? parsed.hash.slice(1) : null;
      parsed.hash = "";
      parsed.search = "";
      rawPath = fileURLToPath(parsed);
    } catch {
      return { ok: false, error: `file:// URL を解析できません: ${trimmed}` };
    }
  } else {
    // Strip #fragment (e.g. /path/doc.md#L10-L20) unless the literal path with '#' exists on disk
    const hashIdx = trimmed.indexOf("#");
    if (hashIdx > 0 && !fs.existsSync(trimmed)) {
      hash = trimmed.slice(hashIdx + 1) || null;
      rawPath = trimmed.slice(0, hashIdx);
    }
    if (rawPath === "~") {
      rawPath = os.homedir();
    } else if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
      rawPath = path.join(os.homedir(), rawPath.slice(2));
    }
  }

  let resolved: string;
  if (path.isAbsolute(rawPath)) {
    resolved = path.resolve(rawPath);
  } else if (baseFilePath) {
    resolved = path.resolve(path.dirname(baseFilePath), rawPath);
  } else {
    return { ok: false, error: "絶対パスまたは file:// URL を指定してください。" };
  }

  if (!isAllowedMarkdownExtension(resolved)) {
    return {
      ok: false,
      error: `Markdown ファイル (.md / .markdown) のみ開けます: ${path.basename(resolved)}`,
    };
  }

  return { ok: true, filePath: resolved, hash };
}

export function readLocalMarkdownFile(
  input: string,
  baseFilePath?: string,
): MarkdownReadResult {
  const resolved = resolveLocalMarkdownPath(input, baseFilePath);
  if (!resolved.ok) {
    return { ok: false, filePath: input, error: resolved.error };
  }

  const targetPath = resolved.filePath;

  let realPath: string;
  try {
    realPath = fs.realpathSync(targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { ok: false, filePath: targetPath, error: "ファイルが見つかりません。" };
    }
    return {
      ok: false,
      filePath: targetPath,
      error: `ファイルにアクセスできません: ${(err as Error).message}`,
    };
  }

  // Defense in depth: prevent symlinks pointing to non-markdown files (e.g. .md -> /etc/passwd)
  if (!isAllowedMarkdownExtension(realPath)) {
    return {
      ok: false,
      filePath: targetPath,
      error: "リンク先が Markdown ファイルではないため読み込みを拒否しました。",
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch (err) {
    return {
      ok: false,
      filePath: targetPath,
      error: `ファイル情報の取得に失敗しました: ${(err as Error).message}`,
    };
  }

  if (!stat.isFile()) {
    return { ok: false, filePath: targetPath, error: "指定されたパスは通常のファイルではありません。" };
  }

  if (stat.size > MAX_MARKDOWN_FILE_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      filePath: targetPath,
      error: `ファイルサイズが大きすぎます (${mb} MB / 上限 5 MB)。`,
    };
  }

  try {
    const content = fs.readFileSync(realPath, "utf8");
    const document: MarkdownDocument = {
      filePath: targetPath,
      fileName: path.basename(targetPath),
      content,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
    };
    return { ok: true, filePath: targetPath, document };
  } catch (err) {
    return {
      ok: false,
      filePath: targetPath,
      error: `ファイルの読み込みに失敗しました: ${(err as Error).message}`,
    };
  }
}

export class MarkdownFileWatcher {
  private readonly onEvent: (event: MarkdownWatchEvent) => void;
  private readonly debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private watchedFilePath: string | null = null;
  private lastMtimeMs: number | null = null;
  private lastSizeBytes: number | null = null;
  private lastContent: string | null = null;

  constructor(onEvent: (event: MarkdownWatchEvent) => void, debounceMs = 120) {
    this.onEvent = onEvent;
    this.debounceMs = debounceMs;
  }

  public getWatchedFilePath(): string | null {
    return this.watchedFilePath;
  }

  public watch(filePathOrUrl: string): { ok: boolean; filePath?: string; error?: string } {
    this.unwatch();

    const resolved = resolveLocalMarkdownPath(filePathOrUrl);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }

    const targetPath = resolved.filePath;
    const parentDir = path.dirname(targetPath);
    const targetBase = path.basename(targetPath);

    if (!fs.existsSync(parentDir)) {
      return { ok: false, error: "親ディレクトリが見つかりません。" };
    }

    // Seed baseline state so we don't fire spurious duplicate events
    const initial = readLocalMarkdownFile(targetPath);
    if (initial.ok && initial.document) {
      this.lastMtimeMs = initial.document.mtimeMs;
      this.lastSizeBytes = initial.document.sizeBytes;
      this.lastContent = initial.document.content;
    }

    try {
      // Watch parent directory so atomic editor saves (temp file + rename) keep working reliably
      this.watcher = fs.watch(parentDir, { persistent: false }, (_eventType, filename) => {
        if (filename && filename.toString() !== targetBase) {
          return;
        }
        this.scheduleReload(targetPath);
      });

      this.watcher.on("error", (err) => {
        this.onEvent({
          filePath: targetPath,
          kind: "error",
          error: `ファイル監視エラー: ${err.message}`,
        });
      });

      this.watchedFilePath = targetPath;
      return { ok: true, filePath: targetPath };
    } catch (err) {
      this.unwatch();
      return {
        ok: false,
        error: `ファイル監視を開始できませんでした: ${(err as Error).message}`,
      };
    }
  }

  public unwatch(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore close errors
      }
      this.watcher = null;
    }
    this.watchedFilePath = null;
    this.lastMtimeMs = null;
    this.lastSizeBytes = null;
    this.lastContent = null;
  }

  public dispose(): void {
    this.unwatch();
  }

  private scheduleReload(targetPath: string): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.watchedFilePath !== targetPath) return;

      if (!fs.existsSync(targetPath)) {
        this.lastMtimeMs = null;
        this.lastSizeBytes = null;
        this.lastContent = null;
        this.onEvent({
          filePath: targetPath,
          kind: "deleted",
          error: "ファイルが削除または移動されました。",
        });
        return;
      }

      const result = readLocalMarkdownFile(targetPath);
      if (!result.ok || !result.document) {
        this.onEvent({
          filePath: targetPath,
          kind: "error",
          error: result.error ?? "ファイルの再読み込みに失敗しました。",
        });
        return;
      }

      const doc = result.document;
      if (
        this.lastMtimeMs === doc.mtimeMs &&
        this.lastSizeBytes === doc.sizeBytes &&
        this.lastContent === doc.content
      ) {
        return;
      }

      this.lastMtimeMs = doc.mtimeMs;
      this.lastSizeBytes = doc.sizeBytes;
      this.lastContent = doc.content;

      this.onEvent({
        filePath: targetPath,
        kind: "changed",
        document: doc,
      });
    }, this.debounceMs);
  }
}
