import type { MermaidConfig, RenderResult } from "mermaid";

export type MermaidThemeMode = "light" | "dark";

export interface MermaidLike {
  initialize: (config: MermaidConfig) => void;
  render: (id: string, text: string) => Promise<RenderResult>;
}

const MAX_MERMAID_CACHE_ENTRIES = 100;
const svgCache = new Map<string, string>();
let renderCounter = 0;
let renderQueue: Promise<void> = Promise.resolve();

export function isMermaidLanguage(language: string | undefined): boolean {
  return language?.trim().toLowerCase() === "mermaid";
}

export function getMermaidConfig(theme: MermaidThemeMode): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: theme === "dark" ? "dark" : "default",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Hiragino Sans", "Segoe UI", sans-serif',
  };
}

export function extractMermaidErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message.trim();
  }
  if (typeof err === "string" && err.trim()) {
    return err.trim();
  }
  if (err && typeof err === "object" && "str" in err && typeof (err as { str?: unknown }).str === "string") {
    const str = (err as { str: string }).str.trim();
    if (str) return str;
  }
  return "Mermaid 構文の解析または描画に失敗しました。";
}

function getCachedSvg(key: string): string | null {
  const cached = svgCache.get(key);
  if (!cached) return null;
  svgCache.delete(key);
  svgCache.set(key, cached);
  return cached;
}

function setCachedSvg(key: string, svg: string): void {
  if (svgCache.has(key)) {
    svgCache.delete(key);
  }
  svgCache.set(key, svg);
  while (svgCache.size > MAX_MERMAID_CACHE_ENTRIES) {
    const oldestKey = svgCache.keys().next().value;
    if (oldestKey === undefined) break;
    svgCache.delete(oldestKey);
  }
}

export function clearMermaidRenderCache(): void {
  svgCache.clear();
}

async function defaultLoadMermaid(): Promise<MermaidLike> {
  const mod = await import("mermaid");
  return mod.default;
}

function cleanupTempElement(id: string): void {
  if (typeof document === "undefined") return;
  document.getElementById(id)?.remove();
  document.getElementById(`d${id}`)?.remove();
}

/**
 * Renders a Mermaid diagram to an SVG string with serialized initialize/render calls
 * so concurrent diagrams on the same page never race themes or DOM IDs.
 */
export async function renderMermaidDiagram(
  code: string,
  theme: MermaidThemeMode,
  options?: { loader?: () => Promise<MermaidLike>; skipCache?: boolean },
): Promise<string> {
  const trimmed = code.trim();
  if (!trimmed) {
    throw new Error("Mermaid 図の定義が空です。");
  }

  const cacheKey = `${theme}\0${trimmed}`;
  if (!options?.skipCache) {
    const cached = getCachedSvg(cacheKey);
    if (cached) return cached;
  }

  const runTask = async (): Promise<string> => {
    if (!options?.skipCache) {
      const cached = getCachedSvg(cacheKey);
      if (cached) return cached;
    }

    const loader = options?.loader ?? defaultLoadMermaid;
    const mermaid = await loader();
    renderCounter += 1;
    const renderId = `conductor-mermaid-${renderCounter}`;

    try {
      mermaid.initialize(getMermaidConfig(theme));
      const result = await mermaid.render(renderId, trimmed);
      const svg = result?.svg?.trim() ?? "";
      if (!svg) {
        throw new Error("Mermaid から空の SVG が返されました。");
      }
      if (!options?.skipCache) {
        setCachedSvg(cacheKey, svg);
      }
      return svg;
    } finally {
      cleanupTempElement(renderId);
    }
  };

  const next = renderQueue.then(runTask, runTask);
  renderQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
