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
  Link2,
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
  onAttachUrl?: () => void;
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
  onAttachUrl,
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
      {/* Navigation Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0">
        <button
          type="button"
          onClick={onBack}
          disabled={!activeTab?.canGoBack}
          title="戻る"
          aria-label="戻る"
          className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-30 cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onForward}
          disabled={!activeTab?.canGoForward}
          title="進む"
          aria-label="進む"
          className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-30 cursor-pointer"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onReload}
          title={activeTab?.isLoading ? "読み込みを中止" : "再読み込み"}
          aria-label={activeTab?.isLoading ? "読み込みを中止" : "再読み込み"}
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

        <button
          type="button"
          onClick={onToggleDevTools}
          title="Chrome DevTools を開閉 (⌘⌥I)"
          aria-label="Chrome DevTools を開閉"
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
        >
          <Code2 className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={onOpenExternal}
          title="外部ブラウザで開く"
          aria-label="外部ブラウザで開く"
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Browser Inspection & Chat-Attach Toolbar */}
      <div
        data-testid="browser-inspection-toolbar"
        className="flex items-center gap-1 px-2 py-1 bg-zinc-100/70 dark:bg-[#171b24] border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0 overflow-x-auto"
      >
        <button
          type="button"
          data-testid="browser-toolbar-screenshot-btn"
          onClick={onCaptureScreenshot}
          title="画面スクショをチャットに添付 (⌘⇧S)"
          aria-label="画面スクショをチャットに添付"
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
        >
          <Camera className="w-3.5 h-3.5" />
          <span>スクショ</span>
        </button>

        <button
          type="button"
          data-testid="browser-toolbar-element-picker-btn"
          onClick={onTogglePicker}
          title="ページ上の要素を選択してチャットに添付 (⌘⇧P)"
          aria-label="要素選択モード"
          aria-pressed={isPickingElement}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer shrink-0 ${
            isPickingElement
              ? "bg-indigo-600 text-white"
              : "text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800"
          }`}
        >
          <Crosshair className="w-3.5 h-3.5" />
          <span>要素選択</span>
        </button>

        {onAttachUrl && (
          <button
            type="button"
            data-testid="browser-toolbar-attach-url-btn"
            onClick={onAttachUrl}
            disabled={!activeTab?.url}
            title={
              activeTab?.url
                ? "現在のブラウザURLをチャットに添付"
                : "URL を開くとチャットに添付できます"
            }
            aria-label="現在のブラウザURLをチャットに添付"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
          >
            <Link2 className="w-3.5 h-3.5" />
            <span>URL添付</span>
          </button>
        )}

        <button
          type="button"
          data-testid="browser-toolbar-attach-errors-btn"
          onClick={onAttachErrors}
          disabled={totalErrors === 0}
          title={
            totalErrors > 0
              ? `コンソール/通信エラー (${totalErrors}件) をチャットへ添付`
              : "コンソール/通信エラーをチャットへ添付（現在エラーはありません）"
          }
          aria-label="コンソール/通信エラーをチャットへ添付"
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors shrink-0 ${
            totalErrors > 0
              ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 cursor-pointer font-semibold"
              : "text-zinc-400 dark:text-zinc-500 opacity-55 cursor-not-allowed"
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>エラー添付</span>
          {totalErrors > 0 && (
            <span className="px-1 py-0.5 rounded-full text-[10px] leading-none bg-rose-500/20 text-rose-700 dark:text-rose-300">
              {totalErrors}
            </span>
          )}
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
