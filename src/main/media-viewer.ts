import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { VideoReadResult } from "../shared/types.js";

export const CONDUCTOR_MEDIA_PROTOCOL = "conductor-media";
export const CONDUCTOR_MEDIA_HOST = "local";

export const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

export const ALLOWED_VIDEO_EXTENSIONS = new Set(Object.keys(VIDEO_MIME_BY_EXTENSION));

export const MAX_VIDEO_FILE_BYTES = 200 * 1024 * 1024; // 200 MB

export function getMimeTypeForVideoPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_MIME_BY_EXTENSION[ext] ?? null;
}

/**
 * Returns the HTTP Content-Type used when streaming a local video to Chromium's `<video>` element.
 * Chromium often rejects `video/quicktime` even for H.264/AAC `.mov` files, whereas `video/mp4`
 * allows its ISOBMFF demuxer to play standard macOS `.mov` screen recordings cleanly.
 */
export function getPlaybackContentTypeForVideoPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mov") return "video/mp4";
  return VIDEO_MIME_BY_EXTENSION[ext] ?? null;
}

export function isAllowedVideoExtension(filePath: string): boolean {
  return getMimeTypeForVideoPath(filePath) !== null;
}

export function buildConductorMediaUrl(filePath: string): string {
  return `${CONDUCTOR_MEDIA_PROTOCOL}://${CONDUCTOR_MEDIA_HOST}/video?path=${encodeURIComponent(filePath)}`;
}

export type ResolvedVideoPath =
  | { ok: true; filePath: string }
  | { ok: false; error: string };

export type LocalVideoErrorCode =
  | "invalid"
  | "not_found"
  | "forbidden"
  | "too_large"
  | "io_error";

export type InspectedLocalVideo =
  | {
      ok: true;
      filePath: string;
      realPath: string;
      fileName: string;
      mimeType: string;
      playbackContentType: string;
      sizeBytes: number;
      mtimeMs: number;
    }
  | {
      ok: false;
      filePath: string;
      error: string;
      errorCode: LocalVideoErrorCode;
    };

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
  let candidate: string;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.hash = "";
      parsed.search = "";
      const filePath = fileURLToPath(parsed);
      if (filePath.includes("\0")) return null;
      candidate = path.resolve(filePath);
    } catch {
      return null;
    }
  } else {
    const expanded = expandHomePath(trimmed);
    if (!path.isAbsolute(expanded)) return null;
    candidate = path.resolve(expanded);
  }
  try {
    if (fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // Non-existent path: treat as a file path and use its parent directory
  }
  return path.dirname(candidate);
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
    if (isAllowedVideoExtension(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveLocalVideoPath(
  input: string,
  baseFilePath?: string,
): ResolvedVideoPath {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: "動画ファイルパスが空です。" };
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

  if (!isAllowedVideoExtension(resolved)) {
    return {
      ok: false,
      error: `対応していない動画形式です: ${path.basename(resolved)}`,
    };
  }

  return { ok: true, filePath: resolved };
}

export function inspectLocalVideoFile(
  input: string,
  baseFilePath?: string,
): InspectedLocalVideo {
  const resolved = resolveLocalVideoPath(input, baseFilePath);
  if (!resolved.ok) {
    return { ok: false, filePath: input, error: resolved.error, errorCode: "invalid" };
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
          const fallbackCode = (fallbackErr as NodeJS.ErrnoException)?.code;
          return {
            ok: false,
            filePath: targetPath,
            error: `動画ファイルにアクセスできません: ${(fallbackErr as Error).message}`,
            errorCode: fallbackCode === "EACCES" || fallbackCode === "EPERM" ? "forbidden" : "io_error",
          };
        }
      } else {
        return {
          ok: false,
          filePath: targetPath,
          error: "動画ファイルが見つかりません。",
          errorCode: "not_found",
        };
      }
    } else {
      return {
        ok: false,
        filePath: targetPath,
        error: `動画ファイルにアクセスできません: ${(err as Error).message}`,
        errorCode: code === "EACCES" || code === "EPERM" ? "forbidden" : "io_error",
      };
    }
  }

  // Defense in depth: block symlinks pointing to non-video files
  const mimeType = getMimeTypeForVideoPath(realPath);
  const playbackContentType = getPlaybackContentTypeForVideoPath(realPath);
  if (!mimeType || !playbackContentType) {
    return {
      ok: false,
      filePath: targetPath,
      error: "リンク先が動画ファイルではないため読み込みを拒否しました。",
      errorCode: "forbidden",
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      filePath: targetPath,
      error: `動画情報を取得できません: ${(err as Error).message}`,
      errorCode: code === "EACCES" || code === "EPERM" ? "forbidden" : "io_error",
    };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      filePath: targetPath,
      error: "指定されたパスは通常ファイルではありません。",
      errorCode: "invalid",
    };
  }

  if (stat.size > MAX_VIDEO_FILE_BYTES) {
    return {
      ok: false,
      filePath: targetPath,
      error: `動画サイズが大きすぎます (上限 ${(MAX_VIDEO_FILE_BYTES / (1024 * 1024)).toFixed(0)}MB)。`,
      errorCode: "too_large",
    };
  }

  return {
    ok: true,
    filePath: targetPath,
    realPath,
    fileName: path.basename(targetPath),
    mimeType,
    playbackContentType,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

export function readLocalVideoFile(
  input: string,
  baseFilePath?: string,
): VideoReadResult {
  const inspected = inspectLocalVideoFile(input, baseFilePath);
  if (!inspected.ok) {
    return { ok: false, filePath: inspected.filePath, error: inspected.error };
  }

  return {
    ok: true,
    filePath: inspected.filePath,
    fileName: inspected.fileName,
    mediaUrl: buildConductorMediaUrl(inspected.realPath),
    mimeType: inspected.mimeType,
    sizeBytes: inspected.sizeBytes,
  };
}

export function parseHttpByteRange(
  rangeHeader: string,
  fileSize: number,
): { start: number; end: number } | "invalid" | null {
  const trimmed = rangeHeader.trim();
  if (!trimmed) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match) return "invalid";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  if (fileSize <= 0) return "invalid";

  if (!rawStart && rawEnd) {
    // Suffix byte range: bytes=-500
    const suffixLength = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return "invalid";
    const start = Math.max(0, fileSize - suffixLength);
    return { start, end: fileSize - 1 };
  }

  const start = Number.parseInt(rawStart!, 10);
  if (!Number.isFinite(start) || start < 0 || start >= fileSize) {
    return "invalid";
  }

  const end = rawEnd ? Math.min(Number.parseInt(rawEnd, 10), fileSize - 1) : fileSize - 1;
  if (!Number.isFinite(end) || end < start) {
    return "invalid";
  }

  return { start, end };
}

/**
 * Electron `protocol.handle("conductor-media", ...)` handler that streams validated local video
 * files with HTTP `Range` (`206 Partial Content`) support so `<video controls>` can seek smoothly.
 */
export async function handleConductorMediaRequest(request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(request.url);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (
    parsedUrl.protocol.toLowerCase() !== `${CONDUCTOR_MEDIA_PROTOCOL}:` ||
    parsedUrl.hostname.toLowerCase() !== CONDUCTOR_MEDIA_HOST ||
    parsedUrl.pathname !== "/video"
  ) {
    return new Response("Not Found", { status: 404 });
  }

  const rawPath = parsedUrl.searchParams.get("path");
  if (!rawPath) {
    return new Response("Missing path", { status: 400 });
  }

  const resolved = resolveLocalVideoPath(rawPath);
  if (!resolved.ok) {
    return new Response(resolved.error, { status: 403 });
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved.filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return new Response("Not Found", { status: code === "ENOENT" ? 404 : 403 });
  }

  const contentType = getPlaybackContentTypeForVideoPath(realPath);
  if (!contentType) {
    return new Response("Forbidden", { status: 403 });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  if (!stat.isFile() || stat.size > MAX_VIDEO_FILE_BYTES) {
    return new Response("Forbidden", { status: 403 });
  }

  const fileSize = stat.size;
  const rangeHeader = request.headers.get("range");
  const parsedRange = rangeHeader ? parseHttpByteRange(rangeHeader, fileSize) : null;

  if (parsedRange === "invalid") {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: {
        "Content-Range": `bytes */${fileSize}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  if (parsedRange) {
    const { start, end } = parsedRange;
    const chunkSize = end - start + 1;
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    };
    if (request.method === "HEAD") {
      return new Response(null, { status: 206, headers });
    }
    const stream = fs.createReadStream(realPath, { start, end });
    return new Response(
      Readable.toWeb(stream) as unknown as ConstructorParameters<typeof Response>[0],
      {
        status: 206,
        headers,
      },
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(fileSize),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  const stream = fs.createReadStream(realPath);
  return new Response(
    Readable.toWeb(stream) as unknown as ConstructorParameters<typeof Response>[0],
    {
      status: 200,
      headers,
    },
  );
}
