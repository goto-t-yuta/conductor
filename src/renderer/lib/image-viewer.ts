import type { ChatAttachment } from "../../shared/types.js";

export type ImageZoomMode = "fit" | "custom";
export type ImageCanvasBackground = "checker" | "dark" | "light";

export interface ImageViewerTab {
  id: string;
  label: string;
  fileName: string | null;
  src: string | null;
  imagePath?: string;
  sourceUrl?: string;
  isLoading: boolean;
  error: string | null;
}

export interface ResolvedImageSource {
  directSrc: string | null;
  localPathToLoad: string | null;
}

export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5] as const;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
export const WHEEL_ZOOM_SENSITIVITY = 0.01;
export const IMAGE_VIEWPORT_PADDING_PX = 16;

export interface CursorAnchoredScrollParams {
  prevScale: number;
  nextScale: number;
  naturalWidth: number;
  naturalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollLeft: number;
  scrollTop: number;
  /** Cursor X coordinate relative to the viewport's left edge. */
  cursorX: number;
  /** Cursor Y coordinate relative to the viewport's top edge. */
  cursorY: number;
  /** Uniform inner padding around the image inside the scroll content wrapper. */
  padding?: number;
}

const WINDOWS_DRIVE_PATH_RE = /^[a-zA-Z]:[\\/]/;
const DIRECT_URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function isFileUrl(value: string): boolean {
  return /^file:\/\//i.test(value);
}

/**
 * Returns true for URLs that can be rendered directly in an <img> tag:
 * data:, blob:, http:, https:, or custom Electron protocol schemes (e.g. app://, conductor://).
 * Excludes file:// URLs (blocked on http://localhost dev origin) and Windows drive paths (C:\...).
 */
export function isDirectRenderableImageUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (WINDOWS_DRIVE_PATH_RE.test(trimmed)) return false;
  if (isFileUrl(trimmed)) return false;
  return DIRECT_URL_SCHEME_RE.test(trimmed);
}

/**
 * Returns true for local file paths or file:// URLs that should be loaded via main-process IPC.
 */
export function isLocalImagePathOrFileUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isFileUrl(trimmed)) return true;
  if (trimmed.startsWith("/") || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return true;
  if (WINDOWS_DRIVE_PATH_RE.test(trimmed)) return true;
  return false;
}

export function extractImageFileName(imagePath?: string): string | null {
  if (!imagePath) return null;
  const trimmed = imagePath.trim();
  if (!trimmed) return null;
  if (/^(data|blob):/i.test(trimmed)) return null;
  const withoutQuery = trimmed.split(/[?#]/)[0] ?? trimmed;
  const segments = withoutQuery.split(/[/\\]/).filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export function resolveImageSource(
  attachment: Pick<ChatAttachment, "kind" | "imageDataUrl" | "imagePath" | "url">,
): ResolvedImageSource {
  let directSrc: string | null = null;
  let localPathToLoad: string | null = null;

  const dataUrl = attachment.imageDataUrl?.trim();
  if (dataUrl) {
    if (isDirectRenderableImageUrl(dataUrl)) {
      directSrc = dataUrl;
    } else if (isLocalImagePathOrFileUrl(dataUrl)) {
      localPathToLoad = dataUrl;
    }
  }

  const imagePath = attachment.imagePath?.trim();
  if (imagePath) {
    if (isDirectRenderableImageUrl(imagePath)) {
      if (!directSrc) directSrc = imagePath;
    } else if (isLocalImagePathOrFileUrl(imagePath)) {
      if (!localPathToLoad) localPathToLoad = imagePath;
    }
  }

  if (!directSrc && !localPathToLoad && attachment.kind === "image") {
    const url = attachment.url?.trim();
    if (url) {
      if (isDirectRenderableImageUrl(url)) {
        directSrc = url;
      } else if (isLocalImagePathOrFileUrl(url)) {
        localPathToLoad = url;
      }
    }
  }

  return { directSrc, localPathToLoad };
}

export function isViewableImageAttachment(
  attachment: Pick<ChatAttachment, "kind" | "imageDataUrl" | "imagePath" | "url">,
): boolean {
  const { directSrc, localPathToLoad } = resolveImageSource(attachment);
  return Boolean(directSrc || localPathToLoad);
}

export interface MarkdownImageLike {
  src: string;
  alt?: string;
  filePath?: string;
}

export function buildAttachmentFromMarkdownImage(image: MarkdownImageLike): ChatAttachment {
  const fileName = extractImageFileName(image.filePath ?? image.src);
  const label = image.alt?.trim() || fileName || "Image";
  const id = image.filePath
    ? `md-image:${image.filePath}`
    : `md-image:${image.src.slice(0, 120)}`;
  return {
    id,
    kind: "image",
    label,
    imagePath: image.filePath,
    imageDataUrl: image.src,
  };
}

export function buildImageTabFromAttachment(attachment: ChatAttachment): {
  tab: ImageViewerTab;
  localPathToLoad: string | null;
} {
  const { directSrc, localPathToLoad } = resolveImageSource(attachment);
  const fileName =
    extractImageFileName(attachment.imagePath) ?? extractImageFileName(attachment.imageDataUrl);
  const label = attachment.label?.trim() || fileName || "Image";

  return {
    tab: {
      id: attachment.id,
      label,
      fileName,
      src: directSrc,
      imagePath: attachment.imagePath?.trim() || undefined,
      sourceUrl: attachment.url?.trim() || undefined,
      isLoading: !directSrc && Boolean(localPathToLoad),
      error: !directSrc && !localPathToLoad ? "表示できる画像ソースがありません。" : null,
    },
    localPathToLoad,
  };
}

export function mergeLoadedImageIntoAttachment(
  attachment: ChatAttachment,
  tab: Pick<ImageViewerTab, "src" | "imagePath" | "label">,
): ChatAttachment {
  return {
    ...attachment,
    label: tab.label || attachment.label,
    imageDataUrl: tab.src ?? attachment.imageDataUrl,
    imagePath: tab.imagePath ?? attachment.imagePath,
  };
}

export function upsertImageTab(
  tabs: ImageViewerTab[],
  nextTab: ImageViewerTab,
): { tabs: ImageViewerTab[]; activeTabId: string } {
  const existingIdx = tabs.findIndex(
    (t) =>
      t.id === nextTab.id ||
      Boolean(nextTab.imagePath && t.imagePath && t.imagePath === nextTab.imagePath) ||
      Boolean(!nextTab.imagePath && nextTab.src && t.src === nextTab.src),
  );

  if (existingIdx >= 0) {
    const existing = tabs[existingIdx];
    const merged: ImageViewerTab = {
      ...existing,
      label: nextTab.label || existing.label,
      fileName: nextTab.fileName ?? existing.fileName,
      src: nextTab.src ?? existing.src,
      imagePath: nextTab.imagePath ?? existing.imagePath,
      sourceUrl: nextTab.sourceUrl ?? existing.sourceUrl,
      isLoading: nextTab.src || existing.src ? false : nextTab.isLoading,
      error: nextTab.src || existing.src ? null : nextTab.error,
    };
    const copy = [...tabs];
    copy[existingIdx] = merged;
    return { tabs: copy, activeTabId: merged.id };
  }

  return {
    tabs: [...tabs, nextTab],
    activeTabId: nextTab.id,
  };
}

export function closeImageTab(
  tabs: ImageViewerTab[],
  activeTabId: string | null,
  closingTabId: string,
): { tabs: ImageViewerTab[]; activeTabId: string | null } {
  const idx = tabs.findIndex((t) => t.id === closingTabId);
  if (idx === -1) {
    return { tabs, activeTabId };
  }
  const nextTabs = tabs.filter((t) => t.id !== closingTabId);
  if (activeTabId !== closingTabId) {
    return { tabs: nextTabs, activeTabId };
  }
  if (nextTabs.length === 0) {
    return { tabs: nextTabs, activeTabId: null };
  }
  const nextActive = nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? nextTabs[0].id;
  return { tabs: nextTabs, activeTabId: nextActive };
}

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

export function stepZoom(currentScale: number, direction: "in" | "out"): number {
  const clamped = clampZoom(currentScale);
  const eps = 0.001;
  if (direction === "in") {
    for (const step of ZOOM_STEPS) {
      if (step > clamped + eps) return step;
    }
    return MAX_ZOOM;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    if (ZOOM_STEPS[i] < clamped - eps) return ZOOM_STEPS[i];
  }
  return MIN_ZOOM;
}

export function formatZoomLabel(mode: ImageZoomMode, scale: number): string {
  if (mode === "fit") return "Fit";
  return `${Math.round(clampZoom(scale) * 100)}%`;
}

/**
 * macOS Chromium/Electron dispatches trackpad pinch-to-zoom gestures as wheel events with
 * `ctrlKey === true`. Also supports Cmd/Ctrl + wheel for mouse-wheel zooming.
 */
export function isPinchOrZoomWheelEvent(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return Boolean(event.ctrlKey || event.metaKey);
}

/**
 * Normalizes WheelEvent.deltaY into CSS pixel units across pixel, line, and page delta modes.
 */
export function normalizeWheelDeltaY(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * 400;
  return deltaY;
}

/**
 * Computes the rendered scale of an image in "fit" mode (`max-w-full max-h-full object-contain`),
 * which shrinks large images to fit inside the available area without upscaling small images past 1x.
 */
export function computeFitScale(
  naturalWidth: number,
  naturalHeight: number,
  availableWidth: number,
  availableHeight: number,
): number {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(availableHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    availableWidth <= 0 ||
    availableHeight <= 0
  ) {
    return 1;
  }
  return Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
}

/**
 * Computes the next smooth zoom scale from a wheel/pinch `deltaY` using an exponential factor
 * (`Math.exp(-deltaY * sensitivity)`), clamped cleanly to `[MIN_ZOOM, MAX_ZOOM]`.
 */
export function computeNextWheelZoom(
  currentScale: number,
  deltaY: number,
  options?: { deltaMode?: number; sensitivity?: number },
): number {
  if (!Number.isFinite(currentScale) || currentScale <= 0) return 1;
  const normalizedDelta = normalizeWheelDeltaY(deltaY, options?.deltaMode ?? 0);
  if (normalizedDelta === 0) return clampZoom(currentScale);

  const sensitivity =
    options?.sensitivity !== undefined &&
    Number.isFinite(options.sensitivity) &&
    options.sensitivity > 0
      ? options.sensitivity
      : WHEEL_ZOOM_SENSITIVITY;

  // Cap exponent so extreme deltas never overflow Math.exp to Infinity before clamping.
  const exponent = Math.max(-10, Math.min(10, -normalizedDelta * sensitivity));
  return clampZoom(currentScale * Math.exp(exponent));
}

/**
 * Computes the scroll offsets that keep the image pixel currently under `(cursorX, cursorY)`
 * anchored in place after scaling from `prevScale` to `nextScale`.
 */
export function computeCursorAnchoredScroll(
  params: CursorAnchoredScrollParams,
): { scrollLeft: number; scrollTop: number } {
  const {
    prevScale,
    nextScale,
    naturalWidth,
    naturalHeight,
    viewportWidth,
    viewportHeight,
    scrollLeft,
    scrollTop,
    cursorX,
    cursorY,
    padding = IMAGE_VIEWPORT_PADDING_PX,
  } = params;

  const fallbackLeft = Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0;
  const fallbackTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;

  if (
    !Number.isFinite(prevScale) ||
    !Number.isFinite(nextScale) ||
    prevScale <= 0 ||
    nextScale <= 0 ||
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return { scrollLeft: fallbackLeft, scrollTop: fallbackTop };
  }

  const pad = Number.isFinite(padding) ? Math.max(0, padding) : 0;
  const safeCursorX = Number.isFinite(cursorX) ? cursorX : viewportWidth / 2;
  const safeCursorY = Number.isFinite(cursorY) ? cursorY : viewportHeight / 2;

  const prevImgW = naturalWidth * prevScale;
  const prevImgH = naturalHeight * prevScale;
  const nextImgW = naturalWidth * nextScale;
  const nextImgH = naturalHeight * nextScale;

  const prevOffsetX = Math.max(pad, (viewportWidth - prevImgW) / 2);
  const prevOffsetY = Math.max(pad, (viewportHeight - prevImgH) / 2);
  const nextOffsetX = Math.max(pad, (viewportWidth - nextImgW) / 2);
  const nextOffsetY = Math.max(pad, (viewportHeight - nextImgH) / 2);

  const ratio = nextScale / prevScale;
  const pointInImgX = fallbackLeft + safeCursorX - prevOffsetX;
  const pointInImgY = fallbackTop + safeCursorY - prevOffsetY;

  const rawNextScrollLeft = nextOffsetX + pointInImgX * ratio - safeCursorX;
  const rawNextScrollTop = nextOffsetY + pointInImgY * ratio - safeCursorY;

  const maxScrollLeft = Math.max(0, nextImgW + pad * 2 - viewportWidth);
  const maxScrollTop = Math.max(0, nextImgH + pad * 2 - viewportHeight);

  return {
    scrollLeft: Math.min(maxScrollLeft, Math.max(0, rawNextScrollLeft)),
    scrollTop: Math.min(maxScrollTop, Math.max(0, rawNextScrollTop)),
  };
}
