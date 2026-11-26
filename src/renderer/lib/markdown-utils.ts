import type { AgentTask, Project } from "../../shared/types.js";
import { formatTaskCode, parseAndResolveMentions } from "../../shared/mentions.js";

export const MARKDOWN_EXT_REGEX = /\.(?:md|markdown|mdown|mkd|mdx)$/i;
export const VIDEO_EXT_REGEX = /\.(?:mp4|webm|mov)$/i;
export const IMAGE_OR_VIDEO_EXT_REGEX =
  /\.(?:png|jpe?g|jfif|webp|gif|bmp|svg|ico|avif|mp4|webm|mov)(?:[?#][^\s)]*)?$/i;

const UNWRAPPED_SPACED_MEDIA_RE =
  /!\[([^\]\r\n]*)\]\(((?:\/|~\/|~\\|\.\.?[\\/]|file:\/\/|[a-zA-Z]:[\\/])[^)\r\n<>]*?[ \t][^)\r\n<>]*?)\)/g;

/**
 * Wraps bare local image/video destinations containing spaces (such as macOS
 * `~/Library/Application Support/...` worktree paths) in CommonMark angle brackets
 * (`![alt](</path/with spaces/file.png>)`) outside fenced/inline code so react-markdown
 * parses them as real media elements instead of literal text.
 */
export function normalizeMarkdownSpacedMediaDestinations(markdown: string): string {
  if (!markdown.includes("![") || !/[ \t]/.test(markdown)) {
    return markdown;
  }

  const lines = markdown.split(/\r?\n/);
  let activeFence: { char: string; length: number } | null = null;
  let changed = false;

  const transformOutsideInlineCode = (line: string): string => {
    // Split line by backtick inline code spans so code examples stay untouched
    const parts = line.split(/(`+[^`]*`+)/g);
    let lineChanged = false;
    const nextParts = parts.map((part, idx) => {
      if (idx % 2 === 1) return part; // inside inline code
      if (!part.includes("![")) return part;
      const replaced = part.replace(
        UNWRAPPED_SPACED_MEDIA_RE,
        (fullMatch, alt: string, rawInside: string) => {
          const trimmed = rawInside.trim();
          // Split optional trailing Markdown title ("..." or '...') if present
          const titleMatch = /^(.*?\S)\s+("[^"\r\n]*"|'[^'\r\n]*')$/.exec(trimmed);
          const dest = (titleMatch ? titleMatch[1] : trimmed) ?? trimmed;
          const title = titleMatch ? titleMatch[2] : null;
          if (!/[ \t]/.test(dest)) {
            return fullMatch;
          }
          if (!IMAGE_OR_VIDEO_EXT_REGEX.test(dest)) {
            return fullMatch;
          }
          lineChanged = true;
          return title ? `![${alt}](<${dest}> ${title})` : `![${alt}](<${dest}>)`;
        },
      );
      return replaced;
    });
    if (lineChanged) {
      changed = true;
      return nextParts.join("");
    }
    return line;
  };

  const nextLines = lines.map((line) => {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const char = marker[0]!;
      if (!activeFence) {
        activeFence = { char, length: marker.length };
        return line;
      }
      if (
        activeFence.char === char &&
        marker.length >= activeFence.length &&
        /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)
      ) {
        activeFence = null;
        return line;
      }
    }
    if (activeFence) return line;
    return transformOutsideInlineCode(line);
  });

  return changed ? nextLines.join("\n") : markdown;
}

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
const DATA_VIDEO_URL_RE = /^data:video\/[a-z0-9.+-]+(?:;[^,]*)?,/i;
const CONDUCTOR_MEDIA_URL_RE = /^conductor-media:\/\//i;

export function isSafeDataImageUrl(url: string): boolean {
  return DATA_IMAGE_URL_RE.test(url.trim());
}

export function isSafeDataVideoUrl(url: string): boolean {
  return DATA_VIDEO_URL_RE.test(url.trim());
}

export function isVideoPathOrUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (DATA_VIDEO_URL_RE.test(trimmed)) return true;
  if (CONDUCTOR_MEDIA_URL_RE.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.pathname === "/video") return true;
      const targetPath = parsed.searchParams.get("path");
      if (targetPath && VIDEO_EXT_REGEX.test(targetPath)) return true;
    } catch {
      return false;
    }
  }
  const pathPart = safeDecodeURIComponent(stripQueryAndHash(trimmed));
  return VIDEO_EXT_REGEX.test(pathPart);
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
  // Allow file://, inline data:image/*, data:video/*, blob:, conductor-media://, and Windows drive
  // paths on img/video src / source srcSet so our MarkdownImage & MarkdownVideo renderers can
  // resolve and load them safely.
  if (key === "src" || key === "srcSet") {
    if (
      /^file:\/\//i.test(trimmed) ||
      DATA_IMAGE_URL_RE.test(trimmed) ||
      DATA_VIDEO_URL_RE.test(trimmed) ||
      /^blob:/i.test(trimmed) ||
      CONDUCTOR_MEDIA_URL_RE.test(trimmed) ||
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

/**
 * Classifies a Markdown `![alt](video.mp4)` or HTML `<video src="...">` source into:
 * - `direct`: safe remote (`http://`, `https://`), `data:video/*`, `blob:`, or `conductor-media://` URLs
 * - `local`: relative (with `baseFilePath`), absolute, `~/`, or `file://` local files to resolve via IPC
 * - `invalid`: empty, disallowed schemes (e.g. `javascript:`), or relative paths without `baseFilePath`
 */
export function classifyMarkdownVideoSrc(
  src: string | undefined,
  baseFilePath?: string,
): ClassifiedMarkdownImageSrc {
  if (!src) {
    return { kind: "invalid", raw: "", error: "動画 URL が空です。" };
  }
  const trimmed = src.trim();
  if (!trimmed) {
    return { kind: "invalid", raw: "", error: "動画 URL が空です。" };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "direct", src: trimmed };
  }

  if (/^\/\/[^/]/.test(trimmed)) {
    return { kind: "direct", src: `https:${trimmed}` };
  }

  if (
    DATA_VIDEO_URL_RE.test(trimmed) ||
    /^blob:/i.test(trimmed) ||
    CONDUCTOR_MEDIA_URL_RE.test(trimmed)
  ) {
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
    return { kind: "invalid", raw: trimmed, error: "対応していない動画 URL です。" };
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
    error: "基準ファイルが不明なため相対パスの動画を解決できません。",
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

interface MarkdownAstNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownAstNode[];
}

const SOFT_BREAK_RE = /[ \t]*(?:\r?\n|\r)/g;

/**
 * Remark plugin that turns single newlines inside mdast `text` nodes into
 * `break` (`<br />`) nodes so chat input line breaks are preserved without
 * touching `code`, `inlineCode`, or `html` nodes.
 */
export function remarkSingleLineBreaks() {
  const transformNode = (node: MarkdownAstNode): void => {
    if (!Array.isArray(node.children) || node.children.length === 0) return;

    const nextChildren: MarkdownAstNode[] = [];
    let modified = false;

    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string" && /[\r\n]/.test(child.value)) {
        modified = true;
        const value = child.value;
        SOFT_BREAK_RE.lastIndex = 0;
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = SOFT_BREAK_RE.exec(value)) !== null) {
          if (match.index > lastIndex) {
            nextChildren.push({ type: "text", value: value.slice(lastIndex, match.index) });
          }
          nextChildren.push({ type: "break" });
          lastIndex = match.index + match[0].length;
        }
        if (lastIndex < value.length) {
          nextChildren.push({ type: "text", value: value.slice(lastIndex) });
        }
      } else {
        transformNode(child);
        nextChildren.push(child);
      }
    }

    if (modified) {
      node.children = nextChildren;
    }
  };

  return (tree: MarkdownAstNode) => {
    transformNode(tree);
  };
}

const SKIP_MENTION_HAST_TAGS = new Set([
  "code",
  "pre",
  "a",
  "button",
  "kbd",
  "samp",
  "var",
  "script",
  "style",
]);

/**
 * Rehype plugin that wraps inline `@T#`, `@project`, and `@project/T#` tokens
 * inside prose HAST text nodes into marker `<span>` elements while skipping
 * code, links, and interactive subtrees.
 */
export function createRehypeHighlightMentions(projects: Project[], tasks: AgentTask[]) {
  return function rehypeHighlightMentions() {
    const transformNode = (node: MarkdownAstNode): void => {
      if (
        node.type === "element" &&
        typeof node.tagName === "string" &&
        SKIP_MENTION_HAST_TAGS.has(node.tagName.toLowerCase())
      ) {
        return;
      }

      if (!Array.isArray(node.children) || node.children.length === 0) return;

      const nextChildren: MarkdownAstNode[] = [];
      let modified = false;

      for (const child of node.children) {
        if (child.type === "text" && typeof child.value === "string" && child.value.includes("@")) {
          const text = child.value;
          const { mentions } = parseAndResolveMentions(text, projects, tasks);
          if (mentions.length > 0) {
            modified = true;
            let cursor = 0;
            for (const m of mentions) {
              if (m.start > cursor) {
                nextChildren.push({ type: "text", value: text.slice(cursor, m.start) });
              }
              if (m.task) {
                nextChildren.push({
                  type: "element",
                  tagName: "span",
                  properties: {
                    dataConductorMentionKind: "task",
                    dataConductorTaskId: m.task.id,
                    dataConductorMentionTitle: `${formatTaskCode(m.task.taskNumber)} · ${m.task.projectName}: ${m.task.title} (${m.task.status})`,
                  },
                  children: [{ type: "text", value: m.raw }],
                });
              } else if (m.project) {
                nextChildren.push({
                  type: "element",
                  tagName: "span",
                  properties: {
                    dataConductorMentionKind: "project",
                    dataConductorProjectColor: m.project.colorHex,
                    dataConductorMentionTitle: m.project.path,
                  },
                  children: [{ type: "text", value: m.raw }],
                });
              } else {
                nextChildren.push({
                  type: "element",
                  tagName: "span",
                  properties: {
                    dataConductorMentionKind: "unresolved",
                  },
                  children: [{ type: "text", value: m.raw }],
                });
              }
              cursor = m.end;
            }
            if (cursor < text.length) {
              nextChildren.push({ type: "text", value: text.slice(cursor) });
            }
            continue;
          }
        }

        transformNode(child);
        nextChildren.push(child);
      }

      if (modified) {
        node.children = nextChildren;
      }
    };

    return (tree: MarkdownAstNode) => {
      transformNode(tree);
    };
  };
}
