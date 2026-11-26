export const MARKDOWN_EXT_REGEX = /\.(?:md|markdown|mdown|mkd|mdx)$/i;

export interface MarkdownHeading {
  level: number;
  text: string;
  id: string;
  line: number;
}

export type ClassifiedHref =
  | { kind: "web"; url: string }
  | { kind: "markdown"; target: string; baseFilePath?: string; hash: string | null }
  | { kind: "anchor"; id: string }
  | { kind: "other"; href: string };

export type ClassifiedMarkdownImageSrc =
  | { kind: "direct"; src: string }
  | {
      kind: "local";
      target: string;
      baseFilePath?: string;
      resolvedPath: string | null;
      cacheKey: string;
    }
  | { kind: "invalid"; raw: string; error: string };

const WINDOWS_DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const DATA_IMAGE_URL_RE = /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i;

export function isSafeDataImageUrl(url: string): boolean {
  return DATA_IMAGE_URL_RE.test(url.trim());
}

export function transformMarkdownUrl(
  url: string,
  key: string,
  fallbackTransform: (value: string) => string,
): string {
  const trimmed = url.trim();
  // Allow local file:// URLs on anchor hrefs so local .md links remain clickable
  if (key === "href" && /^file:\/\//i.test(trimmed)) {
    return trimmed;
  }
  // Allow file://, inline data:image/*, blob:, and Windows drive paths on img src / source srcSet
  // so our MarkdownImage renderer can resolve and load them safely.
  if (key === "src" || key === "srcSet") {
    if (
      /^file:\/\//i.test(trimmed) ||
      DATA_IMAGE_URL_RE.test(trimmed) ||
      /^blob:/i.test(trimmed) ||
      WINDOWS_DRIVE_PATH_RE.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return fallbackTransform(url);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizePathSegments(raw: string): string {
  const forward = raw.replace(/\\/g, "/");

  let prefix = "";
  let rest = forward;
  if (WINDOWS_DRIVE_PATH_RE.test(forward)) {
    prefix = forward.slice(0, 3);
    rest = forward.slice(3);
  } else if (forward.startsWith("//")) {
    const parts = forward.slice(2).split("/");
    const host = parts.shift() ?? "";
    prefix = `//${host}/`;
    rest = parts.join("/");
  } else if (forward.startsWith("/")) {
    prefix = "/";
    rest = forward.slice(1);
  } else if (forward === "~") {
    return "~";
  } else if (forward.startsWith("~/")) {
    prefix = "~/";
    rest = forward.slice(2);
  }

  const stack: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!prefix) {
        stack.push("..");
      }
      continue;
    }
    stack.push(segment);
  }

  if (prefix) {
    return `${prefix}${stack.join("/")}`;
  }
  return stack.join("/") || ".";
}

function fileUrlToLocalPath(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol.toLowerCase() !== "file:") return null;
    let pathname = safeDecodeURIComponent(parsed.pathname);
    if (!pathname) return null;
    if (/^\/[a-zA-Z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    const host = parsed.hostname;
    if (host && host.toLowerCase() !== "localhost") {
      return normalizePathSegments(`//${host}${pathname}`);
    }
    return normalizePathSegments(pathname);
  } catch {
    return null;
  }
}

function dirnameOfPath(filePath: string): string {
  const normalized = /^file:\/\//i.test(filePath)
    ? (fileUrlToLocalPath(filePath) ?? filePath)
    : filePath.replace(/\\/g, "/");
  const trimmed = normalized.replace(/\/+$/, "");
  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash < 0) return "";
  if (lastSlash === 0) return "/";
  if (WINDOWS_DRIVE_PATH_RE.test(trimmed) && lastSlash === 2) {
    return `${trimmed.slice(0, 2)}/`;
  }
  return trimmed.slice(0, lastSlash);
}

/**
 * Resolves a Markdown image `src` (relative, absolute, ~/, or file://) to a normalized local
 * filesystem path string in the renderer without Node dependencies.
 * Returns null if `rawSrc` is relative and no `baseFilePath` is provided, or if malformed.
 */
export function resolveMarkdownImagePath(rawSrc: string, baseFilePath?: string): string | null {
  const trimmed = rawSrc.trim();
  if (!trimmed || trimmed.includes("\0")) return null;

  if (/^file:\/\//i.test(trimmed)) {
    return fileUrlToLocalPath(trimmed);
  }

  const withoutQueryAndHash = stripQueryAndHash(trimmed);
  const decoded = safeDecodeURIComponent(withoutQueryAndHash);
  if (!decoded || decoded.includes("\0")) return null;

  if (
    decoded.startsWith("/") ||
    decoded === "~" ||
    decoded.startsWith("~/") ||
    decoded.startsWith("~\\") ||
    WINDOWS_DRIVE_PATH_RE.test(decoded)
  ) {
    return normalizePathSegments(decoded);
  }

  if (!baseFilePath?.trim()) {
    return null;
  }

  const baseDir = dirnameOfPath(baseFilePath.trim());
  if (!baseDir) {
    return null;
  }
  const joined = baseDir.endsWith("/") ? `${baseDir}${decoded}` : `${baseDir}/${decoded}`;
  return normalizePathSegments(joined);
}

/**
 * Classifies a Markdown `![alt](src)` or HTML `<img src="...">` image source into:
 * - `direct`: safe remote (`http://`, `https://`), inline `data:image/*`, or `blob:` URLs
 * - `local`: relative (with `baseFilePath`), absolute, `~/`, or `file://` local files to load via IPC
 * - `invalid`: empty, disallowed schemes (e.g. `javascript:`), or relative paths without `baseFilePath`
 */
export function classifyMarkdownImageSrc(
  src: string | undefined,
  baseFilePath?: string,
): ClassifiedMarkdownImageSrc {
  if (!src) {
    return { kind: "invalid", raw: "", error: "画像 URL が空です。" };
  }
  const trimmed = src.trim();
  if (!trimmed) {
    return { kind: "invalid", raw: "", error: "画像 URL が空です。" };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "direct", src: trimmed };
  }

  if (/^\/\/[^/]/.test(trimmed)) {
    return { kind: "direct", src: `https:${trimmed}` };
  }

  if (DATA_IMAGE_URL_RE.test(trimmed) || /^blob:/i.test(trimmed)) {
    return { kind: "direct", src: trimmed };
  }

  if (/^file:\/\//i.test(trimmed)) {
    const resolvedPath = resolveMarkdownImagePath(trimmed);
    return {
      kind: "local",
      target: trimmed,
      resolvedPath,
      cacheKey: resolvedPath ?? trimmed,
    };
  }

  const isWindowsDrive = WINDOWS_DRIVE_PATH_RE.test(trimmed);
  if (!isWindowsDrive && URL_SCHEME_RE.test(trimmed)) {
    return { kind: "invalid", raw: trimmed, error: "対応していない画像 URL です。" };
  }

  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("~\\") ||
    isWindowsDrive
  ) {
    const resolvedPath = resolveMarkdownImagePath(trimmed);
    const trimmedBase = baseFilePath?.trim();
    return {
      kind: "local",
      target: trimmed,
      ...(trimmedBase ? { baseFilePath: trimmedBase } : {}),
      resolvedPath,
      cacheKey: resolvedPath ?? trimmed,
    };
  }

  if (baseFilePath?.trim()) {
    const resolvedPath = resolveMarkdownImagePath(trimmed, baseFilePath);
    return {
      kind: "local",
      target: trimmed,
      baseFilePath,
      resolvedPath,
      cacheKey: resolvedPath ?? `${baseFilePath}::${trimmed}`,
    };
  }

  return {
    kind: "invalid",
    raw: trimmed,
    error: "基準ファイルが不明なため相対パスの画像を解決できません。",
  };
}

export function stripQueryAndHash(raw: string): string {
  const withoutHash = raw.split("#")[0] ?? raw;
  return withoutHash.split("?")[0] ?? withoutHash;
}

export function extractHash(raw: string): string | null {
  const idx = raw.indexOf("#");
  if (idx === -1) return null;
  const fragment = raw.slice(idx + 1).trim();
  return fragment.length > 0 ? fragment : null;
}

export function isMarkdownPathOrUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  let pathPart = stripQueryAndHash(trimmed);
  try {
    pathPart = decodeURIComponent(pathPart);
  } catch {
    // keep original if malformed percent-encoding
  }
  return MARKDOWN_EXT_REGEX.test(pathPart);
}

export function classifyLinkHref(href: string | undefined, baseFilePath?: string): ClassifiedHref {
  if (!href) return { kind: "other", href: "" };
  const trimmed = href.trim();
  if (!trimmed) return { kind: "other", href: "" };

  if (trimmed.startsWith("#")) {
    const rawId = trimmed.slice(1);
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      // keep raw
    }
    return { kind: "anchor", id };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "web", url: trimmed };
  }

  if (/^file:\/\//i.test(trimmed)) {
    if (isMarkdownPathOrUrl(trimmed)) {
      return {
        kind: "markdown",
        target: trimmed,
        hash: extractHash(trimmed),
      };
    }
    return { kind: "other", href: trimmed };
  }

  // Relative or absolute filesystem path inside an open local Markdown document
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  if (!hasScheme && isMarkdownPathOrUrl(trimmed)) {
    if (trimmed.startsWith("/") || trimmed.startsWith("~/")) {
      return {
        kind: "markdown",
        target: trimmed,
        hash: extractHash(trimmed),
      };
    }
    if (baseFilePath) {
      return {
        kind: "markdown",
        target: trimmed,
        baseFilePath,
        hash: extractHash(trimmed),
      };
    }
  }

  return { kind: "other", href: trimmed };
}

export function slugifyHeading(text: string): string {
  const normalized = text
    .trim()
    .toLowerCase()
    // Strip markdown inline syntax
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]/g, "")
    // Keep unicode letters, numbers, spaces, hyphens, underscores
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "section";
}

export function uniqueSlug(text: string, counts: Map<string, number>): string {
  const base = slugifyHeading(text);
  const seen = counts.get(base) ?? 0;
  counts.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

function stripInlineMarkdown(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .trim();
}

export function extractMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const lines = markdown.split(/\r?\n/);
  const headings: MarkdownHeading[] = [];
  const slugCounts = new Map<string, number>();

  let activeFence: { char: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track fenced code blocks (``` or ~~~)
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const char = marker[0];
      if (!activeFence) {
        activeFence = { char, length: marker.length };
        continue;
      }
      if (activeFence.char === char && marker.length >= activeFence.length && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)) {
        activeFence = null;
        continue;
      }
    }
    if (activeFence) continue;

    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
    if (!headingMatch) continue;

    const level = headingMatch[1].length;
    const text = stripInlineMarkdown(headingMatch[2]);
    if (!text) continue;

    headings.push({
      level,
      text,
      id: uniqueSlug(text, slugCounts),
      line: i + 1,
    });
  }

  return headings;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function computeDocumentStats(content: string): {
  lines: number;
  words: number;
  chars: number;
} {
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  const trimmed = content.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  return { lines, words, chars: content.length };
}
