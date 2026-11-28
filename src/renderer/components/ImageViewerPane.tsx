import React, { useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { ImageCanvasBackground, ImageViewerTab } from "../lib/image-viewer.js";
import { useImageZoomPan } from "../lib/use-image-zoom-pan.js";
import { t, type UiLocale } from "../../shared/i18n.js";

export interface ImageViewerPaneProps {
  activeTab: ImageViewerTab | null;
  locale?: UiLocale;
  onCloseActiveTab: () => void;
  onRetryLoadTab: (tabId: string) => void;
  onImageLoadError: (tabId: string) => void;
  onOpenUrl: (url: string) => void;
  onRevealInFinder: (filePath: string) => void;
}

export const ImageViewerPane: React.FC<ImageViewerPaneProps> = ({
  activeTab,
  locale = "ja",
  onCloseActiveTab,
  onRetryLoadTab,
  onImageLoadError,
  onOpenUrl,
  onRevealInFinder,
}) => {
  const [canvasBg, setCanvasBg] = useState<ImageCanvasBackground>("checker");
  const [copiedPath, setCopiedPath] = useState(false);

  const hasVisibleImage = Boolean(
    activeTab && !activeTab.isLoading && !activeTab.error && activeTab.src,
  );

  const {
    zoomMode,
    zoomLabel,
    naturalSize,
    isDraggingPan,
    isActualSizeActive,
    canZoomIn,
    canZoomOut,
    imageCursorClass,
    imageStyle,
    viewportRef,
    imgRef,
    handleFit,
    handleActualSize,
    handleZoomIn,
    handleZoomOut,
    handleImageLoad,
    handleImageDoubleClick,
    handleViewportPointerDown,
    handleViewportPointerMove,
    endViewportDragPan,
  } = useImageZoomPan({
    resetKey: `${activeTab?.id ?? ""}\0${activeTab?.src ?? ""}`,
    hasVisibleImage,
    enableKeyboardShortcuts: true,
    captureKeyboardShortcuts: false,
  });

  const canvasBgClass =
    canvasBg === "checker"
      ? "conductor-image-checker"
      : canvasBg === "dark"
        ? "bg-[#0c0e13]"
        : "bg-zinc-100";

  const showFileNameSecondary =
    Boolean(activeTab?.fileName) && activeTab?.fileName !== activeTab?.label;

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Viewer Controls Toolbar */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0 overflow-x-auto">
        <div className="flex items-center gap-1 shrink-0">
          {/* Fit / Actual Size Toggle */}
          <div className="inline-flex items-center p-0.5 rounded-md bg-zinc-200/70 dark:bg-zinc-800 shrink-0">
            <button
              type="button"
              onClick={handleFit}
              disabled={!activeTab?.src}
              title={t(locale, "image.fitTitle")}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap shrink-0 ${
                zoomMode === "fit"
                  ? "bg-white dark:bg-[#1d222d] text-zinc-900 dark:text-zinc-100 shadow-xs"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              <Maximize2 className="w-3 h-3 shrink-0" />
              <span>Fit</span>
            </button>
            <button
              type="button"
              onClick={handleActualSize}
              disabled={!activeTab?.src}
              title={t(locale, "image.actualSizeTitle")}
              className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap shrink-0 ${
                isActualSizeActive
                  ? "bg-white dark:bg-[#1d222d] text-zinc-900 dark:text-zinc-100 shadow-xs"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              <span>100%</span>
            </button>
          </div>

          {/* Step Zoom Controls */}
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={!activeTab?.src || !canZoomOut}
            title={t(locale, "image.zoomOutTitle")}
            aria-label={t(locale, "image.zoomOutAria")}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>

          <span className="min-w-[40px] text-center font-mono text-[11px] text-zinc-600 dark:text-zinc-300 select-none whitespace-nowrap shrink-0">
            {zoomLabel}
          </span>

          <button
            type="button"
            onClick={handleZoomIn}
            disabled={!activeTab?.src || !canZoomIn}
            title={t(locale, "image.zoomInTitle")}
            aria-label={t(locale, "image.zoomInAria")}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Canvas background switcher (helpful for transparent PNGs) */}
          <div
            className="inline-flex items-center p-0.5 rounded-md bg-zinc-200/70 dark:bg-zinc-800 shrink-0"
            role="group"
            aria-label={t(locale, "image.bgGroupAria")}
          >
            {(
              [
                { id: "checker", label: t(locale, "image.bgChecker") },
                { id: "dark", label: t(locale, "image.bgDark") },
                { id: "light", label: t(locale, "image.bgLight") },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setCanvasBg(opt.id)}
                className={`px-1.5 py-0.5 rounded text-[10.5px] font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  canvasBg === opt.id
                    ? "bg-white dark:bg-[#1d222d] text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onCloseActiveTab}
            title={t(locale, "image.closeTabTitle")}
            aria-label={t(locale, "image.closeTabTitle")}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Image Metadata Header Strip */}
      {activeTab && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] bg-zinc-100/70 dark:bg-[#171b24] border-b border-zinc-200/70 dark:border-zinc-800/80 text-zinc-500 dark:text-zinc-400 shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-semibold text-zinc-700 dark:text-zinc-200 truncate">
              {activeTab.label}
            </span>
            {showFileNameSecondary && (
              <span className="font-mono text-[10.5px] text-zinc-400 truncate hidden sm:inline">
                ({activeTab.fileName})
              </span>
            )}
            {activeTab.imagePath && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(activeTab.imagePath!);
                    setCopiedPath(true);
                    setTimeout(() => setCopiedPath(false), 1500);
                  }}
                  title={t(locale, "common.copyPathWith", { path: activeTab.imagePath })}
                  aria-label={t(locale, "image.copyPathAria")}
                  className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded hover:bg-zinc-200/80 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
                >
                  {copiedPath ? (
                    <Check className="w-3 h-3 text-emerald-500" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onRevealInFinder(activeTab.imagePath!)}
                  title={t(locale, "common.revealInFinder")}
                  className="text-[10.5px] hover:text-indigo-500 hover:underline cursor-pointer shrink-0"
                >
                  {t(locale, "common.finder")}
                </button>
              </>
            )}
            {activeTab.sourceUrl && (
              <button
                type="button"
                onClick={() => onOpenUrl(activeTab.sourceUrl!)}
                title={t(locale, "image.sourcePageTitle", { url: activeTab.sourceUrl })}
                className="inline-flex items-center gap-0.5 text-[10.5px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer shrink-0"
              >
                <ExternalLink className="w-3 h-3" />
                <span>{t(locale, "image.sourcePageBtn")}</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0 font-mono text-[10.5px]">
            {naturalSize && (
              <span>
                {naturalSize.width} × {naturalSize.height} px
              </span>
            )}
          </div>
        </div>
      )}

      {/* Main Image Canvas */}
      <div className={`flex-1 min-h-0 flex flex-col overflow-hidden ${canvasBgClass}`}>
        {!activeTab ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-white dark:bg-[#0f1115]">
            <div className="max-w-xs space-y-3">
              <div className="mx-auto w-12 h-12 rounded-2xl bg-indigo-500/12 flex items-center justify-center">
                <ImageIcon className="w-6 h-6 text-indigo-500" />
              </div>
              <h2 className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
                Image Viewer
              </h2>
              <p className="text-[12px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                {t(locale, "image.emptyDesc")}
              </p>
            </div>
          </div>
        ) : activeTab.isLoading ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-[12.5px] text-zinc-500 dark:text-zinc-400 bg-white/80 dark:bg-[#0f1115]/80">
            <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
            <span>{t(locale, "image.loading")}</span>
          </div>
        ) : activeTab.error || !activeTab.src ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-white dark:bg-[#0f1115] space-y-3">
            <div className="w-11 h-11 rounded-2xl bg-rose-500/12 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-rose-500" />
            </div>
            <div className="space-y-1 max-w-sm">
              <div className="text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                {t(locale, "image.errorHeading")}
              </div>
              <div className="text-[12px] text-rose-600 dark:text-rose-400">
                {activeTab.error ?? t(locale, "image.missingData")}
              </div>
              {activeTab.imagePath && (
                <div className="text-[11px] font-mono text-zinc-400 break-all pt-1">
                  {activeTab.imagePath}
                </div>
              )}
            </div>
            {activeTab.imagePath && (
              <button
                type="button"
                onClick={() => onRetryLoadTab(activeTab.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>{t(locale, "common.reload")}</span>
              </button>
            )}
          </div>
        ) : (
          <div
            ref={viewportRef}
            data-testid="image-viewer-viewport"
            onPointerDown={handleViewportPointerDown}
            onPointerMove={handleViewportPointerMove}
            onPointerUp={endViewportDragPan}
            onPointerCancel={endViewportDragPan}
            className={`flex-1 min-h-0 ${
              zoomMode === "fit" ? "overflow-hidden" : "overflow-auto"
            } ${isDraggingPan ? "select-none" : ""}`}
          >
            <div
              className={
                zoomMode === "fit"
                  ? "w-full h-full p-4 flex items-center justify-center"
                  : "min-w-full min-h-full w-max p-4 flex items-center justify-center"
              }
            >
              <img
                ref={imgRef}
                data-testid="image-viewer-img"
                src={activeTab.src}
                alt={activeTab.label}
                draggable={false}
                onDoubleClick={handleImageDoubleClick}
                onLoad={handleImageLoad}
                onError={() => onImageLoadError(activeTab.id)}
                title={
                  zoomMode === "fit"
                    ? t(locale, "image.dblClickActualSizeTitle")
                    : t(locale, "image.dblClickFitTitle")
                }
                style={imageStyle}
                className={
                  zoomMode === "fit"
                    ? `max-w-full max-h-full object-contain rounded-lg shadow-sm select-none ${imageCursorClass}`
                    : `rounded-lg shadow-sm select-none shrink-0 ${imageCursorClass}`
                }
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
