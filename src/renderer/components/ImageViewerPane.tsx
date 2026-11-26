import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
  clampZoom,
  computeCursorAnchoredScroll,
  computeFitScale,
  computeNextWheelZoom,
  formatZoomLabel,
  IMAGE_VIEWPORT_PADDING_PX,
  isPinchOrZoomWheelEvent,
  MAX_ZOOM,
  MIN_ZOOM,
  stepZoom,
  type ImageCanvasBackground,
  type ImageViewerTab,
  type ImageZoomMode,
} from "../lib/image-viewer.js";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface ImageViewerPaneProps {
  activeTab: ImageViewerTab | null;
  onCloseActiveTab: () => void;
  onRetryLoadTab: (tabId: string) => void;
  onImageLoadError: (tabId: string) => void;
  onOpenUrl: (url: string) => void;
  onRevealInFinder: (filePath: string) => void;
}

interface DragPanState {
  pointerId: number;
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
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
  const [isDraggingPan, setIsDraggingPan] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const zoomStateRef = useRef<{ mode: ImageZoomMode; scale: number }>({ mode: "fit", scale: 1 });
  const naturalSizeRef = useRef<{ width: number; height: number } | null>(null);
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
  const dragPanRef = useRef<DragPanState | null>(null);

  const hasVisibleImage = Boolean(
    activeTab && !activeTab.isLoading && !activeTab.error && activeTab.src,
  );

  // Reset zoom, scroll position, and dimensions when switching to another image tab or source
  useEffect(() => {
    zoomStateRef.current = { mode: "fit", scale: 1 };
    pendingScrollRef.current = null;
    dragPanRef.current = null;
    setIsDraggingPan(false);
    setZoomMode("fit");
    setZoomScale(1);

    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
      viewportRef.current.scrollTop = 0;
    }

    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const nextNatural = { width: img.naturalWidth, height: img.naturalHeight };
      naturalSizeRef.current = nextNatural;
      setNaturalSize(nextNatural);
    } else {
      naturalSizeRef.current = null;
      setNaturalSize(null);
    }
  }, [activeTab?.id, activeTab?.src]);

  // Apply cursor-anchored scroll offsets synchronously after React updates image dimensions
  useIsomorphicLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const viewport = viewportRef.current;
    if (!pending || !viewport) return;
    viewport.scrollLeft = pending.left;
    viewport.scrollTop = pending.top;
    pendingScrollRef.current = null;
  }, [zoomMode, zoomScale]);

  const getNaturalDimensions = useCallback((): { width: number; height: number } | null => {
    if (naturalSizeRef.current) return naturalSizeRef.current;
    const img = imgRef.current;
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const measured = { width: img.naturalWidth, height: img.naturalHeight };
      naturalSizeRef.current = measured;
      return measured;
    }
    return null;
  }, []);

  const getCurrentRenderedScale = useCallback((): number => {
    const current = zoomStateRef.current;
    if (current.mode === "custom") return current.scale;

    const natural = getNaturalDimensions();
    if (!natural) return 1;

    const img = imgRef.current;
    if (img) {
      const rect = img.getBoundingClientRect();
      if (rect.width > 0) {
        return rect.width / natural.width;
      }
    }

    const viewport = viewportRef.current;
    if (viewport && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
      return computeFitScale(
        natural.width,
        natural.height,
        Math.max(1, viewport.clientWidth - IMAGE_VIEWPORT_PADDING_PX * 2),
        Math.max(1, viewport.clientHeight - IMAGE_VIEWPORT_PADDING_PX * 2),
      );
    }

    return 1;
  }, [getNaturalDimensions]);

  const applyCustomZoom = useCallback(
    (nextScaleRaw: number, anchor?: { x: number; y: number }) => {
      const viewport = viewportRef.current;
      const natural = getNaturalDimensions();
      const prevScale = getCurrentRenderedScale();
      const nextScale = clampZoom(nextScaleRaw);

      if (viewport && natural && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
        const currentScrollLeft = pendingScrollRef.current
          ? pendingScrollRef.current.left
          : viewport.scrollLeft;
        const currentScrollTop = pendingScrollRef.current
          ? pendingScrollRef.current.top
          : viewport.scrollTop;

        const targetScroll = computeCursorAnchoredScroll({
          prevScale,
          nextScale,
          naturalWidth: natural.width,
          naturalHeight: natural.height,
          viewportWidth: viewport.clientWidth,
          viewportHeight: viewport.clientHeight,
          scrollLeft: currentScrollLeft,
          scrollTop: currentScrollTop,
          cursorX: anchor?.x ?? viewport.clientWidth / 2,
          cursorY: anchor?.y ?? viewport.clientHeight / 2,
          padding: IMAGE_VIEWPORT_PADDING_PX,
        });

        pendingScrollRef.current = {
          left: targetScroll.scrollLeft,
          top: targetScroll.scrollTop,
        };
      }

      zoomStateRef.current = { mode: "custom", scale: nextScale };
      setZoomMode("custom");
      setZoomScale(nextScale);
    },
    [getCurrentRenderedScale, getNaturalDimensions],
  );

  const handleFit = useCallback(() => {
    zoomStateRef.current = { mode: "fit", scale: 1 };
    pendingScrollRef.current = { left: 0, top: 0 };
    dragPanRef.current = null;
    setIsDraggingPan(false);
    setZoomMode("fit");
    setZoomScale(1);
  }, []);

  const handleActualSize = useCallback(() => {
    applyCustomZoom(1);
  }, [applyCustomZoom]);

  const handleZoomIn = useCallback(() => {
    const baseScale = getCurrentRenderedScale();
    applyCustomZoom(stepZoom(baseScale, "in"));
  }, [applyCustomZoom, getCurrentRenderedScale]);

  const handleZoomOut = useCallback(() => {
    const baseScale = getCurrentRenderedScale();
    applyCustomZoom(stepZoom(baseScale, "out"));
  }, [applyCustomZoom, getCurrentRenderedScale]);

  const handleImageDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      if (zoomStateRef.current.mode === "fit") {
        const viewport = viewportRef.current;
        if (viewport) {
          const rect = viewport.getBoundingClientRect();
          applyCustomZoom(1, { x: e.clientX - rect.left, y: e.clientY - rect.top });
        } else {
          applyCustomZoom(1);
        }
        return;
      }
      handleFit();
    },
    [applyCustomZoom, handleFit],
  );

  // Native non-passive wheel listener for smooth macOS trackpad pinch-to-zoom & Cmd/Ctrl+scroll
  useEffect(() => {
    if (!hasVisibleImage) return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const handleWheel = (event: WheelEvent) => {
      if (!isPinchOrZoomWheelEvent(event)) {
        // Leave normal two-finger trackpad scroll untouched so panning works natively.
        return;
      }

      event.preventDefault();

      const natural = getNaturalDimensions();
      if (!natural) return;

      const prevMode = zoomStateRef.current.mode;
      const prevScale = getCurrentRenderedScale();

      // If an oversized image is already fitted below MIN_ZOOM and the user pinches out,
      // stay in Fit mode rather than jumping larger to MIN_ZOOM.
      if (prevMode === "fit" && prevScale < MIN_ZOOM && event.deltaY > 0) {
        return;
      }

      const nextScale = computeNextWheelZoom(prevScale, event.deltaY, {
        deltaMode: event.deltaMode,
      });

      if (prevMode === "custom" && Math.abs(nextScale - prevScale) < 1e-6) {
        return;
      }

      const rect = viewport.getBoundingClientRect();
      const cursorX = event.clientX - rect.left;
      const cursorY = event.clientY - rect.top;

      const currentScrollLeft = pendingScrollRef.current
        ? pendingScrollRef.current.left
        : viewport.scrollLeft;
      const currentScrollTop = pendingScrollRef.current
        ? pendingScrollRef.current.top
        : viewport.scrollTop;

      const targetScroll = computeCursorAnchoredScroll({
        prevScale,
        nextScale,
        naturalWidth: natural.width,
        naturalHeight: natural.height,
        viewportWidth: viewport.clientWidth,
        viewportHeight: viewport.clientHeight,
        scrollLeft: currentScrollLeft,
        scrollTop: currentScrollTop,
        cursorX,
        cursorY,
        padding: IMAGE_VIEWPORT_PADDING_PX,
      });

      zoomStateRef.current = { mode: "custom", scale: nextScale };
      pendingScrollRef.current = {
        left: targetScroll.scrollLeft,
        top: targetScroll.scrollTop,
      };
      setZoomMode("custom");
      setZoomScale(nextScale);
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, [hasVisibleImage, getCurrentRenderedScale, getNaturalDimensions]);

  // Click-and-drag panning when the zoomed image extends beyond the viewport
  const handleViewportPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || zoomStateRef.current.mode !== "custom") return;
    const viewport = viewportRef.current;
    if (!viewport) return;

    const canPan =
      viewport.scrollWidth > viewport.clientWidth + 1 ||
      viewport.scrollHeight > viewport.clientHeight + 1;
    if (!canPan) return;

    dragPanRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startScrollLeft: viewport.scrollLeft,
      startScrollTop: viewport.scrollTop,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setIsDraggingPan(true);
  }, []);

  const handleViewportPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragPanRef.current;
    const viewport = viewportRef.current;
    if (!drag || !viewport || drag.pointerId !== e.pointerId) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    viewport.scrollLeft = drag.startScrollLeft - dx;
    viewport.scrollTop = drag.startScrollTop - dy;
  }, []);

  const endViewportDragPan = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragPanRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragPanRef.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    setIsDraggingPan(false);
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
  const isOverflowingViewport = Boolean(
    zoomMode === "custom" &&
      naturalSize &&
      viewportRef.current &&
      (naturalSize.width * zoomScale + IMAGE_VIEWPORT_PADDING_PX * 2 >
        viewportRef.current.clientWidth + 1 ||
        naturalSize.height * zoomScale + IMAGE_VIEWPORT_PADDING_PX * 2 >
          viewportRef.current.clientHeight + 1),
  );
  const imageCursorClass =
    zoomMode === "fit"
      ? "cursor-zoom-in"
      : isDraggingPan
        ? "cursor-grabbing"
        : isOverflowingViewport
          ? "cursor-grab"
          : "cursor-zoom-out";

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
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    const loaded = { width: img.naturalWidth, height: img.naturalHeight };
                    naturalSizeRef.current = loaded;
                    setNaturalSize(loaded);
                  }
                }}
                onError={() => onImageLoadError(activeTab.id)}
                title={
                  zoomMode === "fit"
                    ? "ダブルクリックで原寸大 (100%) に切替 / ピンチでズーム"
                    : "ダブルクリックでペインに合わせる (Fit) / スクロール・ドラッグで移動"
                }
                style={
                  zoomMode === "custom"
                    ? naturalSize
                      ? {
                          width: `${Math.max(1, Math.round(naturalSize.width * zoomScale))}px`,
                          height: `${Math.max(1, Math.round(naturalSize.height * zoomScale))}px`,
                          maxWidth: "none",
                          maxHeight: "none",
                        }
                      : { maxWidth: "none", maxHeight: "none" }
                    : undefined
                }
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
