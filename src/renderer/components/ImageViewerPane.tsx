import React, { useCallback, useEffect, useState } from "react";
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
import {
  formatZoomLabel,
  MAX_ZOOM,
  MIN_ZOOM,
  stepZoom,
  type ImageCanvasBackground,
  type ImageViewerTab,
  type ImageZoomMode,
} from "../lib/image-viewer.js";

export interface ImageViewerPaneProps {
  activeTab: ImageViewerTab | null;
  onCloseActiveTab: () => void;
  onRetryLoadTab: (tabId: string) => void;
  onImageLoadError: (tabId: string) => void;
  onOpenUrl: (url: string) => void;
  onRevealInFinder: (filePath: string) => void;
}

export const ImageViewerPane: React.FC<ImageViewerPaneProps> = ({
  activeTab,
  onCloseActiveTab,
  onRetryLoadTab,
  onImageLoadError,
  onOpenUrl,
  onRevealInFinder,
}) => {
  const [zoomMode, setZoomMode] = useState<ImageZoomMode>("fit");
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [canvasBg, setCanvasBg] = useState<ImageCanvasBackground>("checker");
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);

  // Reset zoom and dimensions when switching to another image tab or source
  useEffect(() => {
    setZoomMode("fit");
    setZoomScale(1);
    setNaturalSize(null);
  }, [activeTab?.id, activeTab?.src]);

  const handleFit = useCallback(() => {
    setZoomMode("fit");
    setZoomScale(1);
  }, []);

  const handleActualSize = useCallback(() => {
    setZoomMode("custom");
    setZoomScale(1);
  }, []);

  const handleZoomIn = useCallback(() => {
    setZoomMode((prevMode) => {
      setZoomScale((prevScale) => stepZoom(prevMode === "fit" ? 1 : prevScale, "in"));
      return "custom";
    });
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomMode((prevMode) => {
      setZoomScale((prevScale) => stepZoom(prevMode === "fit" ? 1 : prevScale, "out"));
      return "custom";
    });
  }, []);

  const handleToggleFitActual = useCallback(() => {
    setZoomMode((prev) => {
      if (prev === "fit") {
        setZoomScale(1);
        return "custom";
      }
      setZoomScale(1);
      return "fit";
    });
  }, []);

  // Lightweight keyboard shortcuts when not typing in an editable element
  useEffect(() => {
    if (!activeTab?.src) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "0") {
        handleFit();
      } else if (e.key === "1") {
        handleActualSize();
      } else if (e.key === "+" || e.key === "=") {
        handleZoomIn();
      } else if (e.key === "-") {
        handleZoomOut();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab?.src, handleFit, handleActualSize, handleZoomIn, handleZoomOut]);

  const isActualSizeActive = zoomMode === "custom" && Math.abs(zoomScale - 1) < 0.01;
  const canZoomIn = zoomMode === "fit" || zoomScale < MAX_ZOOM - 0.001;
  const canZoomOut = zoomMode === "fit" || zoomScale > MIN_ZOOM + 0.001;

  const canvasBgClass =
    canvasBg === "checker"
      ? "conductor-image-checker"
      : canvasBg === "dark"
        ? "bg-[#0c0e13]"
        : "bg-zinc-100";

  const showFileNameSecondary =
    Boolean(activeTab?.fileName) && activeTab?.fileName !== activeTab?.label;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Viewer Controls Toolbar */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0">
        <div className="flex items-center gap-1 min-w-0">
          {/* Fit / Actual Size Toggle */}
          <div className="inline-flex items-center p-0.5 rounded-md bg-zinc-200/70 dark:bg-zinc-800 shrink-0">
            <button
              type="button"
              onClick={handleFit}
              disabled={!activeTab?.src}
              title="ペインに合わせる (0)"
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                zoomMode === "fit"
                  ? "bg-white dark:bg-[#1d222d] text-zinc-900 dark:text-zinc-100 shadow-xs"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              <Maximize2 className="w-3 h-3" />
              <span>Fit</span>
            </button>
            <button
              type="button"
              onClick={handleActualSize}
              disabled={!activeTab?.src}
              title="原寸大 100% で表示 (1)"
              className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
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
            title="縮小 (-)"
            aria-label="縮小"
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>

          <span className="min-w-[40px] text-center font-mono text-[11px] text-zinc-600 dark:text-zinc-300 select-none">
            {formatZoomLabel(zoomMode, zoomScale)}
          </span>

          <button
            type="button"
            onClick={handleZoomIn}
            disabled={!activeTab?.src || !canZoomIn}
            title="拡大 (+)"
            aria-label="拡大"
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Canvas background switcher (helpful for transparent PNGs) */}
          <div
            className="inline-flex items-center p-0.5 rounded-md bg-zinc-200/70 dark:bg-zinc-800"
            role="group"
            aria-label="背景スタイル"
          >
            {(
              [
                { id: "checker", label: "透過" },
                { id: "dark", label: "暗" },
                { id: "light", label: "明" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setCanvasBg(opt.id)}
                className={`px-1.5 py-0.5 rounded text-[10.5px] font-medium transition-colors cursor-pointer ${
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
            title="この画像タブを閉じる"
            aria-label="この画像タブを閉じる"
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
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
                  title={`パスをコピー: ${activeTab.imagePath}`}
                  aria-label="画像パスをコピー"
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
                  title="Finder で表示"
                  className="text-[10.5px] hover:text-indigo-500 hover:underline cursor-pointer shrink-0"
                >
                  Finder
                </button>
              </>
            )}
            {activeTab.sourceUrl && (
              <button
                type="button"
                onClick={() => onOpenUrl(activeTab.sourceUrl!)}
                title={`元ページをブラウザで開く: ${activeTab.sourceUrl}`}
                className="inline-flex items-center gap-0.5 text-[10.5px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer shrink-0"
              >
                <ExternalLink className="w-3 h-3" />
                <span>元ページ</span>
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
                チャットに貼り付けた画像や添付サムネイルをクリックすると、この右ペインで拡大表示できます。
              </p>
            </div>
          </div>
        ) : activeTab.isLoading ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-[12.5px] text-zinc-500 dark:text-zinc-400 bg-white/80 dark:bg-[#0f1115]/80">
            <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
            <span>画像を読み込み中...</span>
          </div>
        ) : activeTab.error || !activeTab.src ? (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-white dark:bg-[#0f1115] space-y-3">
            <div className="w-11 h-11 rounded-2xl bg-rose-500/12 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-rose-500" />
            </div>
            <div className="space-y-1 max-w-sm">
              <div className="text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                画像を表示できませんでした
              </div>
              <div className="text-[12px] text-rose-600 dark:text-rose-400">
                {activeTab.error ?? "画像データが見つかりません。"}
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
                <span>再読み込み</span>
              </button>
            )}
          </div>
        ) : zoomMode === "fit" ? (
          <div className="flex-1 min-h-0 flex items-center justify-center p-4 overflow-hidden">
            <img
              src={activeTab.src}
              alt={activeTab.label}
              onClick={handleToggleFitActual}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
                }
              }}
              onError={() => onImageLoadError(activeTab.id)}
              title="クリックで原寸大 (100%) に切替"
              className="max-w-full max-h-full object-contain rounded-lg shadow-sm cursor-zoom-in select-none"
            />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto p-4">
            <div className="min-w-full min-h-full flex items-center justify-center">
              <img
                src={activeTab.src}
                alt={activeTab.label}
                onClick={handleToggleFitActual}
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
                  }
                }}
                onError={() => onImageLoadError(activeTab.id)}
                title="クリックでペインに合わせる (Fit)"
                style={
                  naturalSize
                    ? {
                        width: `${Math.max(1, Math.round(naturalSize.width * zoomScale))}px`,
                        height: `${Math.max(1, Math.round(naturalSize.height * zoomScale))}px`,
                        maxWidth: "none",
                        maxHeight: "none",
                      }
                    : { maxWidth: "none", maxHeight: "none" }
                }
                className="rounded-lg shadow-sm cursor-zoom-out select-none shrink-0"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
