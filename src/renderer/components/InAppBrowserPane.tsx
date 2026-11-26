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
import { t, type UiLocale } from "../../shared/i18n.js";
import { hideBrowserBounds, syncBrowserBounds } from "../lib/browser-bounds-client.js";

export interface InAppBrowserPaneProps {
  activeTab: BrowserTab | null;
  isPickingElement: boolean;
  hideNativeView: boolean;
  locale?: UiLocale;
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

export const InAppBrowserPane: React.FC<InAppBrowserPaneProps> = React.memo(({
  activeTab,
  isPickingElement,
  hideNativeView,
  locale = "ja",
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

    let pendingRafId: number | null = null;

    const syncBounds = () => {
      const el = canvasRef.current;
      const shouldShow = !hideNativeView && Boolean(activeTab?.url) && Boolean(el);
      if (!el || !shouldShow) {
        hideBrowserBounds();
        return;
      }
      const rect = el.getBoundingClientRect();
      syncBrowserBounds({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
        visible: rect.width > 10 && rect.height > 10,
      });
    };

    const scheduleSync = () => {
      if (typeof requestAnimationFrame === "undefined") {
        syncBounds();
        return;
      }
      if (pendingRafId !== null) return;
      pendingRafId = requestAnimationFrame(() => {
        pendingRafId = null;
        syncBounds();
      });
    };

    syncBounds();
    scheduleSync();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleSync) : null;
    if (ro && canvasRef.current) ro.observe(canvasRef.current);
    window.addEventListener("resize", scheduleSync);

    return () => {
      if (pendingRafId !== null && typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(pendingRafId);
      }
      ro?.disconnect();
      window.removeEventListener("resize", scheduleSync);
    };
  }, [hideNativeView, activeTab?.id, activeTab?.url, isPickingElement, layoutSyncKey]);

  useEffect(() => {
    return () => {
      hideBrowserBounds();
    };
  }, []);

  const totalErrors = (activeTab?.consoleErrorCount ?? 0) + (activeTab?.networkErrorCount ?? 0);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Navigation Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0 min-w-0">
        <button
          type="button"
          onClick={onBack}
          disabled={!activeTab?.canGoBack}
          title={t(locale, "browser.back")}
          aria-label={t(locale, "browser.back")}
          className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-30 cursor-pointer shrink-0"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onForward}
          disabled={!activeTab?.canGoForward}
          title={t(locale, "browser.forward")}
          aria-label={t(locale, "browser.forward")}
          className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-30 cursor-pointer shrink-0"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={onReload}
          title={activeTab?.isLoading ? t(locale, "browser.stopLoading") : t(locale, "browser.reload")}
          aria-label={
            activeTab?.isLoading ? t(locale, "browser.stopLoading") : t(locale, "browser.reload")
          }
          className="p-1.5 rounded-md text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer shrink-0"
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
            placeholder={t(locale, "browser.urlPlaceholder")}
            className="w-full px-2.5 py-1 rounded-lg text-[12px] bg-white dark:bg-[#0f1115] border border-zinc-200 dark:border-zinc-800 focus:border-indigo-500/60 outline-none select-text"
          />
        </form>

        <button
          type="button"
          onClick={onToggleDevTools}
          title={t(locale, "browser.devToolsTitle")}
          aria-label={t(locale, "browser.devToolsAria")}
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer shrink-0"
        >
          <Code2 className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={onOpenExternal}
          title={t(locale, "browser.openExternal")}
          aria-label={t(locale, "browser.openExternal")}
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer shrink-0"
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
          title={t(locale, "browser.screenshotTitle")}
          aria-label={t(locale, "browser.screenshotAria")}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0 whitespace-nowrap"
        >
          <Camera className="w-3.5 h-3.5 shrink-0" />
          <span>{t(locale, "browser.screenshotBtn")}</span>
        </button>

        <button
          type="button"
          data-testid="browser-toolbar-element-picker-btn"
          onClick={onTogglePicker}
          title={t(locale, "browser.pickerTitle")}
          aria-label={t(locale, "browser.pickerAria")}
          aria-pressed={isPickingElement}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer shrink-0 whitespace-nowrap ${
            isPickingElement
              ? "bg-indigo-600 text-white"
              : "text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800"
          }`}
        >
          <Crosshair className="w-3.5 h-3.5 shrink-0" />
          <span>{t(locale, "browser.pickerBtn")}</span>
        </button>

        {onAttachUrl && (
          <button
            type="button"
            data-testid="browser-toolbar-attach-url-btn"
            onClick={onAttachUrl}
            disabled={!activeTab?.url}
            title={
              activeTab?.url
                ? t(locale, "browser.attachUrlTitle")
                : t(locale, "browser.attachUrlDisabledTitle")
            }
            aria-label={t(locale, "browser.attachUrlTitle")}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0 whitespace-nowrap"
          >
            <Link2 className="w-3.5 h-3.5 shrink-0" />
            <span>{t(locale, "browser.attachUrlBtn")}</span>
          </button>
        )}

        <button
          type="button"
          data-testid="browser-toolbar-attach-errors-btn"
          onClick={onAttachErrors}
          disabled={totalErrors === 0}
          title={
            totalErrors > 0
              ? t(locale, "browser.attachErrorsTitleWithCount", { count: totalErrors })
              : t(locale, "browser.attachErrorsEmptyTitle")
          }
          aria-label={t(locale, "browser.attachErrorsAria")}
          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors shrink-0 whitespace-nowrap ${
            totalErrors > 0
              ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 cursor-pointer font-semibold"
              : "text-zinc-400 dark:text-zinc-500 opacity-55 cursor-not-allowed"
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>{t(locale, "browser.attachErrorsBtn")}</span>
          {totalErrors > 0 && (
            <span className="px-1 py-0.5 rounded-full text-[10px] leading-none bg-rose-500/20 text-rose-700 dark:text-rose-300">
              {totalErrors}
            </span>
          )}
        </button>
      </div>

      {/* Picker Active Banner */}
      {isPickingElement && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-indigo-600 text-white text-[11.5px] shrink-0 min-w-0">
          <span className="truncate">{t(locale, "browser.pickerBanner")}</span>
          <button
            type="button"
            onClick={onTogglePicker}
            className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30 text-[11px] font-medium cursor-pointer shrink-0 whitespace-nowrap"
          >
            {t(locale, "browser.pickerDone")}
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
                {t(locale, "browser.emptyDesc")}
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
});
