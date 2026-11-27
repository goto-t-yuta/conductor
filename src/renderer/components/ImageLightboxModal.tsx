import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  PanelRightOpen,
  RotateCw,
  X,
} from "lucide-react";
import type { ImageViewerTab } from "../lib/image-viewer.js";
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
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);

  useEffect(() => {
    setNaturalSize(null);
    setCopiedPath(false);
  }, [image.id, image.src]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [onClose]);

  const showSecondaryFileName = Boolean(image.fileName) && image.fileName !== image.label;
  const hasFooterMeta = Boolean(image.imagePath || image.sourceUrl);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t(locale, "image.lightboxDialogAria", { label: image.label })}
      data-testid="image-lightbox-modal"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        data-testid="image-lightbox-dialog"
        className="w-full max-w-[min(92vw,1200px)] max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-[#141821] border border-zinc-200/80 dark:border-zinc-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: caption / filename + Open in Right Pane + Close */}
        <div
          data-testid="image-lightbox-header"
          className="flex items-center justify-between gap-3 px-4 py-3 border-b border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/90 dark:bg-[#171b24] shrink-0"
        >
          <div className="flex items-center gap-2 min-w-0">
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
                  className="font-mono text-[11.5px] text-zinc-500 dark:text-zinc-400 truncate hidden sm:inline"
                  title={image.fileName ?? undefined}
                >
                  {image.fileName}
                </span>
              )}
              {naturalSize && (
                <span
                  data-testid="image-lightbox-dimensions"
                  className="font-mono text-[11px] text-zinc-400 shrink-0 whitespace-nowrap hidden md:inline"
                >
                  {naturalSize.width} × {naturalSize.height} px
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              data-testid="image-lightbox-open-right-pane"
              onClick={onOpenInRightPane}
              title={t(locale, "image.lightboxOpenInRightPaneTitle")}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-500/12 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 border border-indigo-500/25 hover:bg-indigo-500/20 dark:hover:bg-indigo-500/30 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <PanelRightOpen className="w-3.5 h-3.5 shrink-0" />
              <span>{t(locale, "image.lightboxOpenInRightPane")}</span>
            </button>

            <button
              type="button"
              data-testid="image-lightbox-close"
              onClick={onClose}
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
          className="flex-1 min-h-[260px] flex items-center justify-center overflow-auto p-4 sm:p-6 conductor-image-checker"
        >
          {image.isLoading ? (
            <div className="flex items-center justify-center gap-2 text-[13px] text-zinc-500 dark:text-zinc-400">
              <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />
              <span>{t(locale, "image.loading")}</span>
            </div>
          ) : image.error || !image.src ? (
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
          ) : (
            <img
              data-testid="image-lightbox-img"
              src={image.src}
              alt={image.label}
              draggable={false}
              onLoad={(e) => {
                const el = e.currentTarget;
                if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                  setNaturalSize({ width: el.naturalWidth, height: el.naturalHeight });
                }
              }}
              onError={() => onImageLoadError?.()}
              className="max-w-full max-h-[calc(90vh-132px)] object-contain rounded-lg shadow-lg select-none"
            />
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
                      onClose();
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
