import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Code2, Copy, Eye, Loader2, Network } from "lucide-react";
import {
  extractMermaidErrorMessage,
  renderMermaidDiagram,
  type MermaidThemeMode,
} from "../lib/mermaid-renderer.js";

function detectDarkTheme(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  if (document.documentElement.classList.contains("dark")) {
    return true;
  }
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return false;
}

function useMermaidTheme(): MermaidThemeMode {
  const [isDark, setIsDark] = useState<boolean>(() => detectDarkTheme());

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    const update = () => setIsDark(detectDarkTheme());
    update();

    const mql =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : null;
    mql?.addEventListener?.("change", update);

    const observer =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(update)
        : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => {
      mql?.removeEventListener?.("change", update);
      observer?.disconnect();
    };
  }, []);

  return isDark ? "dark" : "light";
}

export interface MermaidBlockProps {
  code: string;
}

export const MermaidBlock: React.FC<MermaidBlockProps> = ({ code }) => {
  const theme = useMermaidTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState<boolean>(true);
  const [viewMode, setViewMode] = useState<"diagram" | "code">("diagram");
  const [copied, setCopied] = useState(false);

  const hasMountedRef = useRef(false);
  const prevThemeRef = useRef<MermaidThemeMode>(theme);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let cancelled = false;
    const isThemeChange = prevThemeRef.current !== theme;
    prevThemeRef.current = theme;

    // Render immediately on first mount or theme change; debounce rapid code updates (e.g. streaming chat)
    const delayMs = !hasMountedRef.current || isThemeChange ? 0 : 150;
    hasMountedRef.current = true;

    setIsRendering(true);

    const timer = setTimeout(() => {
      void renderMermaidDiagram(code, theme)
        .then((renderedSvg) => {
          if (cancelled) return;
          setSvg(renderedSvg);
          setError(null);
          setIsRendering(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setSvg(null);
          setError(extractMermaidErrorMessage(err));
          setIsRendering(false);
        });
    }, delayMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, theme]);

  const showCodeOnly = viewMode === "code";

  return (
    <div
      data-testid="mermaid-block"
      className="my-2.5 overflow-hidden rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50 dark:bg-[#14171f]"
    >
      {/* Header Bar */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 bg-zinc-100/80 dark:bg-zinc-900/80 border-b border-zinc-200/70 dark:border-zinc-800">
        <div className="flex items-center gap-1.5">
          <Network className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span className="font-mono font-medium">mermaid</span>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex items-center p-0.5 rounded bg-zinc-200/70 dark:bg-zinc-800">
            <button
              type="button"
              onClick={() => setViewMode("diagram")}
              title="Mermaid 図を表示"
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-medium transition-colors cursor-pointer ${
                viewMode === "diagram"
                  ? "bg-white dark:bg-[#1d222d] text-zinc-900 dark:text-zinc-100 shadow-xs"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              <Eye className="w-3 h-3" />
              <span>Diagram</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("code")}
              title="Mermaid ソースを表示"
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-medium transition-colors cursor-pointer ${
                viewMode === "code"
                  ? "bg-white dark:bg-[#1d222d] text-zinc-900 dark:text-zinc-100 shadow-xs"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              <Code2 className="w-3 h-3" />
              <span>Code</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
        </div>
      </div>

      {/* Body */}
      {showCodeOnly ? (
        <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed font-mono select-text">
          <code>{code}</code>
        </pre>
      ) : error ? (
        <div data-testid="mermaid-error" className="divide-y divide-zinc-200/70 dark:divide-zinc-800">
          <div className="flex items-start gap-2 px-3 py-2 text-[11.5px] bg-amber-500/10 text-amber-700 dark:text-amber-300">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="font-medium">Mermaid 図のレンダリングに失敗しました</div>
              <div className="font-mono text-[11px] opacity-90 whitespace-pre-wrap break-words">
                {error}
              </div>
            </div>
          </div>
          <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed font-mono select-text">
            <code>{code}</code>
          </pre>
        </div>
      ) : svg ? (
        <div
          data-testid="mermaid-diagram"
          className="conductor-mermaid-svg overflow-x-auto p-4 bg-white dark:bg-[#10131a]"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div
          data-testid="mermaid-loading"
          className="flex items-center justify-center gap-2 p-4 text-[12px] text-zinc-500 dark:text-zinc-400 bg-white dark:bg-[#10131a]"
        >
          {isRendering && <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin" />}
          <span>Mermaid 図をレンダリング中...</span>
        </div>
      )}
    </div>
  );
};
