import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import {
  clampZoom,
  computeCursorAnchoredScroll,
  computeDragPanScroll,
  computeFitScale,
  computeWheelZoomUpdate,
  formatZoomLabel,
  IMAGE_VIEWPORT_PADDING_PX,
  isEditableEventTarget,
  isImageOverflowingViewport,
  isPinchOrZoomWheelEvent,
  MAX_ZOOM,
  MIN_ZOOM,
  resolveImageZoomCursorClass,
  stepZoom,
  type DragPanSession,
  type ImageDimensions,
  type ImageZoomCursorClass,
  type ImageZoomMode,
} from "./image-viewer.js";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface UseImageZoomPanOptions {
  /** Key identifying the currently displayed image; changing it resets zoom to fit. */
  resetKey: string;
  /** Whether a renderable image is currently shown in the viewport. */
  hasVisibleImage: boolean;
  /** Uniform inner padding around the image inside the viewport (px). */
  padding?: number;
  /** Enable window keyboard shortcuts (`0`, `1`, `+`, `=`, `-`). Defaults to true. */
  enableKeyboardShortcuts?: boolean;
  /** Handle keyboard shortcuts in capture phase and stop propagation (for modal overlays). */
  captureKeyboardShortcuts?: boolean;
  /** Optional callback fired when a drag-pan gesture finishes. */
  onPanDragEnd?: (didMove: boolean) => void;
}

export interface UseImageZoomPanResult {
  zoomMode: ImageZoomMode;
  zoomScale: number;
  zoomLabel: string;
  naturalSize: ImageDimensions | null;
  isDraggingPan: boolean;
  isActualSizeActive: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  isOverflowingViewport: boolean;
  imageCursorClass: ImageZoomCursorClass;
  imageStyle: React.CSSProperties | undefined;
  viewportRef: React.RefObject<HTMLDivElement | null>;
  imgRef: React.RefObject<HTMLImageElement | null>;
  handleFit: () => void;
  resetZoom: () => void;
  handleActualSize: () => void;
  handleZoomIn: () => void;
  handleZoomOut: () => void;
  applyCustomZoom: (nextScaleRaw: number, anchor?: { x: number; y: number }) => void;
  handleImageLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
  handleImageDoubleClick: (e: React.MouseEvent<HTMLImageElement>) => void;
  handleViewportPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  handleViewportPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  endViewportDragPan: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export function useImageZoomPan({
  resetKey,
  hasVisibleImage,
  padding = IMAGE_VIEWPORT_PADDING_PX,
  enableKeyboardShortcuts = true,
  captureKeyboardShortcuts = false,
  onPanDragEnd,
}: UseImageZoomPanOptions): UseImageZoomPanResult {
  const [zoomMode, setZoomMode] = useState<ImageZoomMode>("fit");
  const [zoomScale, setZoomScale] = useState<number>(1);
  const [naturalSize, setNaturalSize] = useState<ImageDimensions | null>(null);
  const [isDraggingPan, setIsDraggingPan] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const zoomStateRef = useRef<{ mode: ImageZoomMode; scale: number }>({ mode: "fit", scale: 1 });
  const naturalSizeRef = useRef<ImageDimensions | null>(null);
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
  const dragPanRef = useRef<DragPanSession | null>(null);

  // Reset zoom, scroll position, and dimensions whenever the displayed image changes
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
  }, [resetKey]);

  // Apply cursor-anchored scroll offsets synchronously after React updates image dimensions
  useIsomorphicLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const viewport = viewportRef.current;
    if (!pending || !viewport) return;
    viewport.scrollLeft = pending.left;
    viewport.scrollTop = pending.top;
    pendingScrollRef.current = null;
  }, [zoomMode, zoomScale]);

  const getNaturalDimensions = useCallback((): ImageDimensions | null => {
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
        Math.max(1, viewport.clientWidth - padding * 2),
        Math.max(1, viewport.clientHeight - padding * 2),
      );
    }

    return 1;
  }, [getNaturalDimensions, padding]);

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
          padding,
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
    [getCurrentRenderedScale, getNaturalDimensions, padding],
  );

  const resetZoom = useCallback(() => {
    zoomStateRef.current = { mode: "fit", scale: 1 };
    pendingScrollRef.current = { left: 0, top: 0 };
    dragPanRef.current = null;
    setIsDraggingPan(false);
    setZoomMode("fit");
    setZoomScale(1);
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
      viewportRef.current.scrollTop = 0;
    }
  }, []);

  const handleFit = resetZoom;

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

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      const loaded = { width: img.naturalWidth, height: img.naturalHeight };
      naturalSizeRef.current = loaded;
      setNaturalSize(loaded);
    }
  }, []);

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
      event.stopPropagation();

      const natural = getNaturalDimensions();
      if (!natural) return;

      const prevMode = zoomStateRef.current.mode;
      const prevScale = getCurrentRenderedScale();
      const rect = viewport.getBoundingClientRect();
      const currentScrollLeft = pendingScrollRef.current
        ? pendingScrollRef.current.left
        : viewport.scrollLeft;
      const currentScrollTop = pendingScrollRef.current
        ? pendingScrollRef.current.top
        : viewport.scrollTop;

      const update = computeWheelZoomUpdate({
        prevMode,
        prevScale,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        naturalWidth: natural.width,
        naturalHeight: natural.height,
        viewportWidth: viewport.clientWidth,
        viewportHeight: viewport.clientHeight,
        scrollLeft: currentScrollLeft,
        scrollTop: currentScrollTop,
        cursorX: event.clientX - rect.left,
        cursorY: event.clientY - rect.top,
        padding,
      });

      if (!update) return;

      zoomStateRef.current = { mode: update.mode, scale: update.scale };
      pendingScrollRef.current = {
        left: update.scrollLeft,
        top: update.scrollTop,
      };
      setZoomMode(update.mode);
      setZoomScale(update.scale);
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      viewport.removeEventListener("wheel", handleWheel);
    };
  }, [hasVisibleImage, getCurrentRenderedScale, getNaturalDimensions, padding]);

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
      hasMoved: false,
    };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setIsDraggingPan(true);
  }, []);

  const handleViewportPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragPanRef.current;
    const viewport = viewportRef.current;
    if (!drag || !viewport || drag.pointerId !== e.pointerId) return;

    const next = computeDragPanScroll(drag, e.clientX, e.clientY);
    if (next.hasMoved) {
      drag.hasMoved = true;
    }
    viewport.scrollLeft = next.scrollLeft;
    viewport.scrollTop = next.scrollTop;
  }, []);

  const endViewportDragPan = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragPanRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      const didMove = drag.hasMoved;
      dragPanRef.current = null;
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }
      setIsDraggingPan(false);
      onPanDragEnd?.(didMove);
    },
    [onPanDragEnd],
  );

  // Lightweight keyboard shortcuts when not typing in an editable element
  useEffect(() => {
    if (!enableKeyboardShortcuts || !hasVisibleImage) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target as HTMLElement | null)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      let handled = false;
      if (e.key === "0") {
        handleFit();
        handled = true;
      } else if (e.key === "1") {
        handleActualSize();
        handled = true;
      } else if (e.key === "+" || e.key === "=") {
        handleZoomIn();
        handled = true;
      } else if (e.key === "-") {
        handleZoomOut();
        handled = true;
      }

      if (handled && captureKeyboardShortcuts) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, captureKeyboardShortcuts);
    return () => window.removeEventListener("keydown", onKeyDown, captureKeyboardShortcuts);
  }, [
    enableKeyboardShortcuts,
    captureKeyboardShortcuts,
    hasVisibleImage,
    handleFit,
    handleActualSize,
    handleZoomIn,
    handleZoomOut,
  ]);

  const isActualSizeActive = zoomMode === "custom" && Math.abs(zoomScale - 1) < 0.01;
  const canZoomIn = zoomMode === "fit" || zoomScale < MAX_ZOOM - 0.001;
  const canZoomOut = zoomMode === "fit" || zoomScale > MIN_ZOOM + 0.001;
  const isOverflowingViewport = isImageOverflowingViewport({
    zoomMode,
    zoomScale,
    naturalSize,
    viewportWidth: viewportRef.current?.clientWidth ?? 0,
    viewportHeight: viewportRef.current?.clientHeight ?? 0,
    padding,
  });
  const imageCursorClass = resolveImageZoomCursorClass({
    zoomMode,
    isDraggingPan,
    isOverflowingViewport,
  });
  const zoomLabel = formatZoomLabel(zoomMode, zoomScale);
  const imageStyle: React.CSSProperties | undefined =
    zoomMode === "custom"
      ? naturalSize
        ? {
            width: `${Math.max(1, Math.round(naturalSize.width * zoomScale))}px`,
            height: `${Math.max(1, Math.round(naturalSize.height * zoomScale))}px`,
            maxWidth: "none",
            maxHeight: "none",
          }
        : { maxWidth: "none", maxHeight: "none" }
      : undefined;

  return {
    zoomMode,
    zoomScale,
    zoomLabel,
    naturalSize,
    isDraggingPan,
    isActualSizeActive,
    canZoomIn,
    canZoomOut,
    isOverflowingViewport,
    imageCursorClass,
    imageStyle,
    viewportRef,
    imgRef,
    handleFit,
    resetZoom,
    handleActualSize,
    handleZoomIn,
    handleZoomOut,
    applyCustomZoom,
    handleImageLoad,
    handleImageDoubleClick,
    handleViewportPointerDown,
    handleViewportPointerMove,
    endViewportDragPan,
  };
}
