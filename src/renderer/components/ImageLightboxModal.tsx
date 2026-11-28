import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  PanelRightOpen,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  shouldDismissLightboxOnBackdropClick,
  type ImageViewerTab,
  type LightboxPointerOrigin,
} from "../lib/image-viewer.js";
import { useImageZoomPan } from "../lib/use-image-zoom-pan.js";
import { t, type UiLocale } from "../../shared/i18n.js";

export interface ImageLightboxModalProps {
  image: ImageViewerTab;
  locale?: UiLocale;
  onClose: () => void;
  onOpenInRightPane: () => void;
  onRetryLoad?: () => void;
  onImageLoadError?: () => void;
  onOpenUrl?: (url: string) => void;
  onRevealInFinder?: (filePath: string) => void;
}

export const ImageLightboxModal: React.FC<ImageLightboxModalProps> = ({
  image,
  locale = "ja",
  onClose,
  onOpenInRightPane,
  onRetryLoad,
  onImageLoadError,
  onOpenUrl,
  onRevealInFinder,
}) => {
  const [copiedPath, setCopiedPath] = useState(false);

  const pointerDownOriginRef = useRef<LightboxPointerOrigin>(null);
  const suppressNextBackdropClickRef = useRef(false);

  const hasVisibleImage = Boolean(!image.isLoading && !image.error && image.src);

  const handlePanDragEnd = useCallback((didMove: boolean) => {
    if (didMove) {
      suppressNextBackdropClickRef.current = true;
    }
  }, []);

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
    resetZoom,
    handleActualSize,
    handleZoomIn,
    handleZoomOut,
    handleImageLoad,
    handleImageDoubleClick,
    handleViewportPointerDown,
    handleViewportPointerMove,
    endViewportDragPan,
  } = useImageZoomPan({
    resetKey: `${image.id}\0${image.src ?? ""}`,
    hasVisibleImage,
    enableKeyboardShortcuts: true,
    captureKeyboardShortcuts: true,
    onPanDragEnd: handlePanDragEnd,
  });

  useEffect(() => {
    setCopiedPath(false);
    pointerDownOriginRef.current = null;
    suppressNextBackdropClickRef.current = false;
  }, [image.id, image.src]);

  useEffect(() => {
    return () => {
      resetZoom();
    };
  }, [resetZoom]);

  const handleClose = useCallback(() => {
    pointerDownOriginRef.current = null;
    suppressNextBackdropClickRef.current = false;
    resetZoom();
    onClose();
  }, [onClose, resetZoom]);

  const handleOpenInRightPane = useCallback(() => {
    pointerDownOriginRef.current = null;
    suppressNextBackdropClickRef.current = false;
    resetZoom();
    onOpenInRightPane();
  }, [onOpenInRightPane, resetZoom]);

  const handleBackdropPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    suppressNextBackdropClickRef.current = false;
    pointerDownOriginRef.current = e.target === e.currentTarget ? "backdrop" : "dialog";
  }, []);

  const handleBackdropPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerDownOriginRef.current === "backdrop" && e.target !== e.currentTarget) {
      suppressNextBackdropClickRef.current = true;
    }
  }, []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const shouldDismiss = shouldDismissLightboxOnBackdropClick({
        isTargetBackdrop: e.target === e.currentTarget,
        pointerDownOrigin: pointerDownOriginRef.current,
        isDraggingPan,
        suppressNextBackdropClick: suppressNextBackdropClickRef.current,
      });
      pointerDownOriginRef.current = null;
      suppressNextBackdropClickRef.current = false;
      if (shouldDismiss) {
        handleClose();
      }
    },
    [handleClose, isDraggingPan],
  );

  const handleDialogClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.stopPropagation();
    pointerDownOriginRef.current = null;
    suppressNextBackdropClickRef.current = false;
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [handleClose]);

  const showSecondaryFileName = Boolean(image.fileName) && image.fileName !== image.label;
  const hasFooterMeta = Boolean(image.imagePath || image.sourceUrl);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t(locale, "image.lightboxDialogAria", { label: image.label })}
      data-testid="image-lightbox-modal"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 sm:p-6"
      onPointerDown={handleBackdropPointerDown}
      onPointerUp={handleBackdropPointerUp}
      onClick={handleBackdropClick}
    >
      <div
        data-testid="image-lightbox-dialog"
        className="w-full max-w-[min(92vw,1200px)] h-[min(88vh,860px)] max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-[#141821] border border-zinc-200/80 dark:border-zinc-800 shadow-2xl overflow-hidden"
        onClick={handleDialogClick}
      >
        {/* Header: caption / filename + Zoom Controls + Open in Right Pane + Close */}
        <div
          data-testid="image-lightbox-header"
          className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/90 dark:bg-[#171b24] shrink-0"
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/12 flex items-center justify-center shrink-0">
              <ImageIcon className="w-4 h-4 text-indigo-500" />
            </div>
            <div className="flex items-baseline gap-2 min-w-0">
              <h2
                data-testid="image-lightbox-title"
                className="text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100 truncate"
                title={image.label}
              >
                {image.label}
              </h2>
              {showSecondaryFileName && (
                <span
                  data-testid="image-lightbox-filename"
                  className="font-mono text-[11.5px] text-zinc-500 dark:text-zinc-400 truncate hidden lg:inline"
                  title={image.fileName ?? undefined}
                >
                  {image.fileName}
                </span>
              )}
              {naturalSize && (
                <span
                  data-testid="image-lightbox-dimensions"
                  className="font-mono text-[11px] text-zinc-400 shrink-0 whitespace-nowrap hidden xl:inline"
                >
                  {naturalSize.width} × {naturalSize.height} px
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Zoom Controls: Fit / 100% toggle + Zoom Out / Label / Zoom In */}
            <div
              data-testid="image-lightbox-zoom-controls"
              className="flex items-center gap-1 shrink-0"
            >
              <div className="inline-flex items-center p-0.5 rounded-md bg-zinc-200/70 dark:bg-zinc-800 shrink-0">
                <button
                  type="button"
                  data-testid="image-lightbox-fit"
                  onClick={handleFit}
                  disabled={!hasVisibleImage}
                  aria-pressed={zoomMode === "fit"}
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
                  data-testid="image-lightbox-actual-size"
                  onClick={handleActualSize}
                  disabled={!hasVisibleImage}
                  aria-pressed={isActualSizeActive}
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

              <button
                type="button"
                data-testid="image-lightbox-zoom-out"
                onClick={handleZoomOut}
                disabled={!hasVisibleImage || !canZoomOut}
                title={t(locale, "image.zoomOutTitle")}
                aria-label={t(locale, "image.zoomOutAria")}
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>

              <span
                data-testid="image-lightbox-zoom-label"
                className="min-w-[42px] text-center font-mono text-[11px] text-zinc-600 dark:text-zinc-300 select-none whitespace-nowrap shrink-0"
              >
                {zoomLabel}
              </span>

              <button
                type="button"
                data-testid="image-lightbox-zoom-in"
                onClick={handleZoomIn}
                disabled={!hasVisibleImage || !canZoomIn}
                title={t(locale, "image.zoomInTitle")}
                aria-label={t(locale, "image.zoomInAria")}
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-35 disabled:cursor-not-allowed transition-colors cursor-pointer shrink-0"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>

            <div
              className="w-px h-5 bg-zinc-200/80 dark:bg-zinc-700/80 shrink-0"
              aria-hidden="true"
            />

            <button
              type="button"
              data-testid="image-lightbox-open-right-pane"
              onClick={handleOpenInRightPane}
              title={t(locale, "image.lightboxOpenInRightPaneTitle")}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-500/12 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 border border-indigo-500/25 hover:bg-indigo-500/20 dark:hover:bg-indigo-500/30 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <PanelRightOpen className="w-3.5 h-3.5 shrink-0" />
              <span>{t(locale, "image.lightboxOpenInRightPane")}</span>
            </button>

            <button
              type="button"
              data-testid="image-lightbox-close"
              onClick={handleClose}
              title={t(locale, "image.lightboxCloseTitle")}
              aria-label={t(locale, "image.lightboxCloseAria")}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Main Image Viewport */}
        <div
          data-testid="image-lightbox-body"
          className="flex-1 min-h-0 flex flex-col overflow-hidden conductor-image-checker"
        >
          {image.isLoading ? (
            <div className="flex-1 flex items-center justify-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400">
              <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
              <span>{t(locale, "image.loading")}</span>
            </div>
          ) : image.error || !image.src ? (
            <div className="flex-1 flex flex-col items-center justify-center p-6">
              <div className="flex flex-col items-center justify-center p-6 text-center space-y-3 rounded-xl bg-white/95 dark:bg-[#141821]/95 border border-zinc-200/80 dark:border-zinc-800 max-w-md">
                <div className="w-11 h-11 rounded-2xl bg-rose-500/12 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-rose-500" />
                </div>
                <div className="space-y-1">
                  <div className="text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                    {t(locale, "image.errorHeading")}
                  </div>
                  <div className="text-[12px] text-rose-600 dark:text-rose-400">
                    {image.error ?? t(locale, "image.missingData")}
                  </div>
                  {image.imagePath && (
                    <div className="text-[11px] font-mono text-zinc-400 break-all pt-1">
                      {image.imagePath}
                    </div>
                  )}
                </div>
                {image.imagePath && onRetryLoad && (
                  <button
                    type="button"
                    onClick={onRetryLoad}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    <span>{t(locale, "common.reload")}</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div
              ref={viewportRef}
              data-testid="image-lightbox-viewport"
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
                  data-testid="image-lightbox-img"
                  src={image.src}
                  alt={image.label}
                  draggable={false}
                  onDoubleClick={handleImageDoubleClick}
                  onLoad={handleImageLoad}
                  onError={() => onImageLoadError?.()}
                  title={
                    zoomMode === "fit"
                      ? t(locale, "image.dblClickActualSizeTitle")
                      : t(locale, "image.dblClickFitTitle")
                  }
                  style={imageStyle}
                  className={
                    zoomMode === "fit"
                      ? `max-w-full max-h-full object-contain rounded-lg shadow-lg select-none ${imageCursorClass}`
                      : `rounded-lg shadow-lg select-none shrink-0 ${imageCursorClass}`
                  }
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer: path / source metadata + Esc hint */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-zinc-200/70 dark:border-zinc-800/80 bg-zinc-50/85 dark:bg-[#171b24] text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {hasFooterMeta ? (
              <>
                {image.imagePath && (
                  <>
                    <span
                      className="font-mono truncate max-w-[520px]"
                      title={image.imagePath}
                    >
                      {image.imagePath}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(image.imagePath!);
                        setCopiedPath(true);
                        setTimeout(() => setCopiedPath(false), 1500);
                      }}
                      title={t(locale, "common.copyPathWith", { path: image.imagePath })}
                      aria-label={t(locale, "image.copyPathAria")}
                      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded hover:bg-zinc-200/80 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
                    >
                      {copiedPath ? (
                        <Check className="w-3 h-3 text-emerald-500" />
                      ) : (
                        <Copy className="w-3 h-3" />
                      )}
                    </button>
                    {onRevealInFinder && (
                      <button
                        type="button"
                        onClick={() => onRevealInFinder(image.imagePath!)}
                        title={t(locale, "common.revealInFinder")}
                        className="text-[11px] hover:text-indigo-500 hover:underline cursor-pointer shrink-0"
                      >
                        {t(locale, "common.finder")}
                      </button>
                    )}
                  </>
                )}
                {image.sourceUrl && onOpenUrl && (
                  <button
                    type="button"
                    onClick={() => {
                      onOpenUrl(image.sourceUrl!);
                      handleClose();
                    }}
                    title={t(locale, "image.sourcePageTitle", { url: image.sourceUrl })}
                    className="inline-flex items-center gap-0.5 text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer shrink-0"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span>{t(locale, "image.sourcePageBtn")}</span>
                  </button>
                )}
              </>
            ) : (
              <span className="truncate">{image.fileName ?? image.label}</span>
            )}
          </div>
          <span className="text-[10.5px] text-zinc-400 whitespace-nowrap shrink-0">
            {t(locale, "image.lightboxEscHint")}
          </span>
        </div>
      </div>
    </div>
  );
};
