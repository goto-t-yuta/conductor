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
