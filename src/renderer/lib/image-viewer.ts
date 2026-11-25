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

export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

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

export function buildImageTabFromAttachment(attachment: ChatAttachment): {
  tab: ImageViewerTab;
  localPathToLoad: string | null;
} {
  const { directSrc, localPathToLoad } = resolveImageSource(attachment);
  const fileName = extractImageFileName(attachment.imagePath);
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
