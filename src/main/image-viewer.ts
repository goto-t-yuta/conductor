import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageReadResult } from "../shared/types.js";

export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

export const ALLOWED_IMAGE_EXTENSIONS = new Set(Object.keys(IMAGE_MIME_BY_EXTENSION));

export const MAX_IMAGE_FILE_BYTES = 30 * 1024 * 1024; // 30 MB

export function getMimeTypeForImagePath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[ext] ?? null;
}

export function isAllowedImageExtension(filePath: string): boolean {
  return getMimeTypeForImagePath(filePath) !== null;
}

export type ResolvedImagePath =
  | { ok: true; filePath: string }
  | { ok: false; error: string };

export function resolveLocalImagePath(input: string): ResolvedImagePath {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "画像ファイルパスが空です。" };
  }
  if (trimmed.includes("\0")) {
    return { ok: false, error: "不正なファイルパスです。" };
  }

  let rawPath = trimmed;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.hash = "";
      parsed.search = "";
      rawPath = fileURLToPath(parsed);
    } catch {
      return { ok: false, error: `file:// URL を解析できません: ${trimmed}` };
    }
  } else if (rawPath === "~") {
    rawPath = os.homedir();
  } else if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    rawPath = path.join(os.homedir(), rawPath.slice(2));
  }

  if (!path.isAbsolute(rawPath)) {
    return { ok: false, error: "絶対パスまたは file:// URL を指定してください。" };
  }

  const resolved = path.resolve(rawPath);
  if (!isAllowedImageExtension(resolved)) {
    return {
      ok: false,
      error: `対応していない画像形式です: ${path.basename(resolved)}`,
    };
  }

  return { ok: true, filePath: resolved };
}

export function readLocalImageFile(input: string): ImageReadResult {
  const resolved = resolveLocalImagePath(input);
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
      return { ok: false, filePath: targetPath, error: "画像ファイルが見つかりません。" };
    }
    return {
      ok: false,
      filePath: targetPath,
      error: `画像ファイルにアクセスできません: ${(err as Error).message}`,
    };
  }

  // Defense in depth: block symlinks pointing to non-image files
  const mimeType = getMimeTypeForImagePath(realPath);
  if (!mimeType) {
    return {
      ok: false,
      filePath: targetPath,
      error: "リンク先が画像ファイルではないため読み込みを拒否しました。",
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch (err) {
    return {
      ok: false,
      filePath: targetPath,
      error: `画像情報を取得できません: ${(err as Error).message}`,
    };
  }

  if (!stat.isFile()) {
    return { ok: false, filePath: targetPath, error: "指定されたパスは通常ファイルではありません。" };
  }

  if (stat.size > MAX_IMAGE_FILE_BYTES) {
    return {
      ok: false,
      filePath: targetPath,
      error: `画像サイズが大きすぎます (上限 ${(MAX_IMAGE_FILE_BYTES / (1024 * 1024)).toFixed(0)}MB)。`,
    };
  }

  try {
    const buf = fs.readFileSync(realPath);
    const dataUrl = `data:${mimeType};base64,${buf.toString("base64")}`;
    return {
      ok: true,
      filePath: targetPath,
      fileName: path.basename(targetPath),
      dataUrl,
      mimeType,
      sizeBytes: stat.size,
    };
  } catch (err) {
    return {
      ok: false,
      filePath: targetPath,
      error: `画像を読み込めませんでした: ${(err as Error).message}`,
    };
  }
}
