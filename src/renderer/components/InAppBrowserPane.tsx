import React, { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  Code2,
  Crosshair,
  ExternalLink,
  Globe,
  RotateCw,
  X,
} from "lucide-react";
import type { BrowserTab } from "../../shared/types.js";

export interface InAppBrowserPaneProps {
  activeTab: BrowserTab | null;
  isPickingElement: boolean;
  hideNativeView: boolean;
  /** Changing value forces an immediate bounds re-sync (e.g. file tree toggle/resize) */
  layoutSyncKey?: string | number;
  onNavigate: (url: string, newTab?: boolean) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onToggleDevTools: () => void;
  onTogglePicker: () => void;
  onCaptureScreenshot: () => void;
  onAttachErrors: () => void;
  onOpenExternal: () => void;
}

export const InAppBrowserPane: React.FC<InAppBrowserPaneProps> = ({
  activeTab,
  isPickingElement,
  hideNativeView,
  layoutSyncKey,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onToggleDevTools,
  onTogglePicker,
  onCaptureScreenshot,
  onAttachErrors,
  onOpenExternal,
}) => {
  const [urlInput, setUrlInput] = useState(activeTab?.url ?? "");
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setUrlInput(activeTab?.url ?? "");
  }, [activeTab?.id, activeTab?.url]);

  // Synchronize native Chromium WebContentsView pixel bounds with this div
  useEffect(() => {
    if (typeof window === "undefined" || !window.conductor?.browserSetBounds) {
      return;
    }

    const syncBounds = () => {
      const el = canvasRef.current;
      const shouldShow = !hideNativeView && Boolean(activeTab?.url) && Boolean(el);
      if (!el || !shouldShow) {
        void window.conductor.browserSetBounds({
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          visible: false,
        });
        return;
      }
      const rect = el.getBoundingClientRect();
      void window.conductor.browserSetBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        visible: rect.width > 10 && rect.height > 10,
      });
    };

    syncBounds();
    const rafId =
      typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame(syncBounds) : null;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncBounds) : null;
    if (ro && canvasRef.current) ro.observe(canvasRef.current);
    window.addEventListener("resize", syncBounds);

    return () => {
      if (rafId !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(rafId);
      }
      ro?.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [hideNativeView, activeTab?.id, activeTab?.url, isPickingElement, layoutSyncKey]);

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && window.conductor?.browserSetBounds) {
        void window.conductor.browserSetBounds({
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          visible: false,
        });
      }
    };
  }, []);

  const totalErrors = (activeTab?.consoleErrorCount ?? 0) + (activeTab?.networkErrorCount ?? 0);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Navigation & Automation Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0">
        <button
          type="button"
          onClick={onBack}
          disabled={!activeTab?.canGoBack}
          className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-30 cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onForward}
          disabled={!activeTab?.canGoForward}
          className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-30 cursor-pointer"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onReload}
          className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
        >
          {activeTab?.isLoading ? <X className="w-3.5 h-3.5" /> : <RotateCw className="w-3.5 h-3.5" />}
        </button>

        <form
          className="flex-1 min-w-0"
          onSubmit={(e) => {
            e.preventDefault();
            if (urlInput.trim()) onNavigate(urlInput.trim(), false);
          }}
        >
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="localhost:3000 や URL を入力..."
            className="w-full px-2.5 py-1 rounded-lg text-[12px] bg-white dark:bg-[#0f1115] border border-zinc-200 dark:border-zinc-800 focus:border-indigo-500/60 outline-none select-text"
          />
        </form>

        {totalErrors > 0 && (
          <button
            type="button"
            onClick={onAttachErrors}
            title="コンソール/通信エラーをチャットへ送る"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 cursor-pointer"
          >
            <AlertTriangle className="w-3 h-3" />
            <span>{totalErrors}</span>
          </button>
        )}

        <button
          type="button"
          onClick={onTogglePicker}
          title="要素選択モード (⌘⇧P)"
          className={`p-1.5 rounded-md transition-colors cursor-pointer ${
            isPickingElement
              ? "bg-indigo-600 text-white"
              : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
          }`}
        >
          <Crosshair className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={onCaptureScreenshot}
          title="画面スクショをチャットに添付 (⌘⇧S)"
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
        >
          <Camera className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={onToggleDevTools}
          title="Chrome DevTools を開閉 (⌘⌥I)"
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
        >
          <Code2 className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={onOpenExternal}
          title="外部ブラウザで開く"
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Picker Active Banner */}
      {isPickingElement && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-indigo-600 text-white text-[11.5px] shrink-0">
          <span>要素選択モード：ページ上の要素をクリックすると HTML/CSS とスクショをチャットに添付します (Esc で終了)</span>
          <button
            type="button"
            onClick={onTogglePicker}
            className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-[11px] font-medium cursor-pointer shrink-0"
          >
            終了
          </button>
        </div>
      )}

      {/* Chromium WebContentsView Mount Canvas */}
      <div ref={canvasRef} className="flex-1 relative bg-white dark:bg-[#0f1115] overflow-hidden">
        {!activeTab?.url && (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-zinc-100 dark:bg-zinc-800/80 flex items-center justify-center">
              <Globe className="w-6 h-6 text-zinc-400" />
            </div>
            <div className="space-y-1">
              <h2 className="text-[15px] font-semibold">In-App Chromium Browser</h2>
              <p className="text-[12px] text-zinc-500 dark:text-zinc-400 max-w-xs leading-relaxed">
                CDP 直結の内蔵 Chromium。Agent がクリック・入力・コンソールエラー監視・スクショ撮影を自動実行でき、本物の Chrome DevTools も開けます。
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-1.5">
              {["localhost:3000", "localhost:5173", "localhost:8080", "github.com"].map((shortcut) => (
                <button
                  key={shortcut}
                  type="button"
                  onClick={() => onNavigate(shortcut, false)}
                  className="px-3 py-1 rounded-full text-[11.5px] font-mono bg-zinc-100 dark:bg-zinc-800 hover:bg-indigo-500/15 hover:text-indigo-500 transition-colors cursor-pointer"
                >
                  {shortcut}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
