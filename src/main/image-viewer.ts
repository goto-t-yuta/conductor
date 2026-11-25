import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageReadResult } from "../shared/types.js";

export const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
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

function expandHomePath(rawPath: string): string {
  if (rawPath === "~") {
    return os.homedir();
  }
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function resolveBaseDirectory(baseFilePath?: string): string | null {
  const trimmed = baseFilePath?.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.hash = "";
      parsed.search = "";
      const filePath = fileURLToPath(parsed);
      if (filePath.includes("\0")) return null;
      return path.dirname(path.resolve(filePath));
    } catch {
      return null;
    }
  }
  const expanded = expandHomePath(trimmed);
  if (!path.isAbsolute(expanded)) return null;
  return path.dirname(path.resolve(expanded));
}

function stripQueryAndHashIfNotLiteral(rawPath: string, baseDir: string | null): string {
  const queryIdx = rawPath.indexOf("?");
  const hashIdx = rawPath.indexOf("#");
  const cutIndices = [queryIdx, hashIdx].filter((idx) => idx > 0);
  if (cutIndices.length === 0) {
    return rawPath;
  }

  const expanded = expandHomePath(rawPath);
  const literalCandidate = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : baseDir
      ? path.resolve(baseDir, expanded)
      : null;

  if (literalCandidate && fs.existsSync(literalCandidate)) {
    return rawPath;
  }

  return rawPath.slice(0, Math.min(...cutIndices));
}

function resolveCandidatePath(rawPath: string, baseDir: string | null): string | null {
  const expanded = expandHomePath(rawPath);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  if (baseDir) {
    return path.resolve(baseDir, expanded);
  }
  return null;
}

function findGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveRepoRootFallback(rawInput: string, baseFilePath?: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || /^file:\/\//i.test(trimmed)) {
    return null;
  }
  const baseDir = resolveBaseDirectory(baseFilePath);
  if (!baseDir) return null;

  const cleaned = stripQueryAndHashIfNotLiteral(trimmed, baseDir);
  const relSegment = cleaned.replace(/^\/+/, "");
  if (!relSegment) return null;

  const candidateRoots: string[] = [];
  const gitRoot = findGitRoot(baseDir);
  if (gitRoot) candidateRoots.push(gitRoot);
  if (!candidateRoots.includes(baseDir)) candidateRoots.push(baseDir);

  for (const root of candidateRoots) {
    const literalCandidate = path.resolve(root, relSegment);
    let candidate = literalCandidate;
    if (relSegment.includes("%") && !fs.existsSync(literalCandidate)) {
      try {
        const decoded = decodeURIComponent(relSegment);
        if (!decoded.includes("\0")) {
          candidate = path.resolve(root, decoded);
        }
      } catch {
        // keep literal candidate
      }
    }
    const relFromRoot = path.relative(root, candidate);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
      continue;
    }
    if (isAllowedImageExtension(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveLocalImagePath(
  input: string,
  baseFilePath?: string,
): ResolvedImagePath {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "画像ファイルパスが空です。" };
  }
  if (trimmed.includes("\0")) {
    return { ok: false, error: "不正なファイルパスです。" };
  }

  const baseDir = resolveBaseDirectory(baseFilePath);
  let resolved: string | null = null;

  if (/^file:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.hash = "";
      parsed.search = "";
      const filePath = fileURLToPath(parsed);
      if (filePath.includes("\0")) {
        return { ok: false, error: "不正なファイルパスです。" };
      }
      resolved = path.resolve(filePath);
    } catch {
      return { ok: false, error: `file:// URL を解析できません: ${trimmed}` };
    }
  } else {
    const cleaned = stripQueryAndHashIfNotLiteral(trimmed, baseDir);
    const literalResolved = resolveCandidatePath(cleaned, baseDir);
    if (!literalResolved) {
      return { ok: false, error: "絶対パスまたは file:// URL を指定してください。" };
    }

    if (cleaned.includes("%") && !fs.existsSync(literalResolved)) {
      let decoded: string | null = null;
      try {
        decoded = decodeURIComponent(cleaned);
      } catch {
        decoded = null;
      }
      if (decoded !== null) {
        if (decoded.includes("\0")) {
          return { ok: false, error: "不正なファイルパスです。" };
        }
        const decodedResolved = resolveCandidatePath(decoded, baseDir);
        resolved = decodedResolved ?? literalResolved;
      } else {
        resolved = literalResolved;
      }
    } else {
      resolved = literalResolved;
    }
  }

  if (!isAllowedImageExtension(resolved)) {
    return {
      ok: false,
      error: `対応していない画像形式です: ${path.basename(resolved)}`,
    };
  }

  return { ok: true, filePath: resolved };
}

export function readLocalImageFile(
  input: string,
  baseFilePath?: string,
): ImageReadResult {
  const resolved = resolveLocalImagePath(input, baseFilePath);
  if (!resolved.ok) {
    return { ok: false, filePath: input, error: resolved.error };
  }

  let targetPath = resolved.filePath;

  let realPath: string;
  try {
    realPath = fs.realpathSync(targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      const repoFallback = resolveRepoRootFallback(input, baseFilePath);
      if (repoFallback) {
        targetPath = repoFallback;
        try {
          realPath = fs.realpathSync(targetPath);
        } catch (fallbackErr) {
          return {
            ok: false,
            filePath: targetPath,
            error: `画像ファイルにアクセスできません: ${(fallbackErr as Error).message}`,
          };
        }
      } else {
        return { ok: false, filePath: targetPath, error: "画像ファイルが見つかりません。" };
      }
    } else {
      return {
        ok: false,
        filePath: targetPath,
        error: `画像ファイルにアクセスできません: ${(err as Error).message}`,
      };
    }
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
