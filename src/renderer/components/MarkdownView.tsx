import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { Check, Copy, Film, FileText, FolderOpen, Image as ImageIcon, ImageOff, RotateCw, VideoOff } from "lucide-react";
import type { AgentTask, Project } from "../../shared/types.js";
import {
  defaultMarkdownImageCache,
  type LocalMarkdownImageLoader,
  type MarkdownImageCache,
} from "../lib/markdown-image-cache.js";
import {
  defaultMarkdownVideoCache,
  type LocalMarkdownVideoLoader,
  type MarkdownVideoCache,
} from "../lib/markdown-video-cache.js";
import {
  classifyLinkHref,
  classifyMarkdownImageSrc,
  classifyMarkdownVideoSrc,
  createRehypeHighlightMentions,
  isVideoPathOrUrl,
  normalizeMarkdownSpacedMediaDestinations,
  remarkSingleLineBreaks,
  transformMarkdownUrl,
  uniqueSlug,
} from "../lib/markdown-utils.js";
import { isMermaidLanguage } from "../lib/mermaid-renderer.js";
import { t, type UiLocale } from "../../shared/i18n.js";
import { MermaidBlock } from "./MermaidBlock.js";

export interface MarkdownOpenedImage {
  src: string;
  alt?: string;
  filePath?: string;
}

export interface MarkdownInlineMentionConfig {
  projects: Project[];
  tasks: AgentTask[];
  onOpenTask: (taskId: string) => void;
}

interface MarkdownViewProps {
  content: string;
  locale?: UiLocale;
  onOpenUrl: (url: string) => void;
  onOpenMarkdownFile?: (target: string, baseFilePath?: string) => void;
  onOpenImage?: (image: MarkdownOpenedImage) => void;
  baseFilePath?: string;
  variant?: "chat" | "user" | "document";
  preserveSingleLineBreaks?: boolean;
  mentionContext?: MarkdownInlineMentionConfig;
  headingIdPrefix?: string;
  onScrollToHeading?: (id: string) => void;
  imageReloadVersion?: number;
  imageCache?: MarkdownImageCache;
  loadLocalImage?: LocalMarkdownImageLoader;
  videoCache?: MarkdownVideoCache;
  loadLocalVideo?: LocalMarkdownVideoLoader;
}

export const CONDUCTOR_SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: Array.from(new Set([...(defaultSchema.tagNames ?? []), "video"])),
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file"],
    src: ["http", "https", "file", "data", "blob", "conductor-media"],
  },
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./]],
    img: [...(defaultSchema.attributes?.img ?? []), "loading", "decoding"],
    source: [
      ...(defaultSchema.attributes?.source ?? []),
      "src",
      "srcSet",
      "media",
      "type",
      "sizes",
    ],
    video: [
      "src",
      "poster",
      "controls",
      "loop",
      "muted",
      "playsInline",
      "preload",
      "width",
      "height",
      "title",
    ],
  },
};

export function conductorUrlTransform(url: string, key: string): string {
  return transformMarkdownUrl(url, key, defaultUrlTransform);
}

type LocalImageLoadState =
  | { key: string; status: "loading" }
  | { key: string; status: "loaded"; dataUrl: string; filePath: string }
  | { key: string; status: "error"; error: string; filePath?: string };

interface MarkdownImageProps {
  src?: string;
  alt?: string;
  title?: string;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: React.CSSProperties;
  baseFilePath?: string;
  onOpenImage?: (image: MarkdownOpenedImage) => void;
  imageReloadVersion: number;
  imageCache: MarkdownImageCache;
  loadLocalImage?: LocalMarkdownImageLoader;
  locale: UiLocale;
}

const MarkdownImage: React.FC<MarkdownImageProps> = React.memo(({
  src,
  alt,
  title,
  width,
  height,
  className,
  style,
  baseFilePath,
  onOpenImage,
  imageReloadVersion,
  imageCache,
  loadLocalImage,
  locale,
}) => {
  const classified = useMemo(
    () => classifyMarkdownImageSrc(src, baseFilePath),
    [src, baseFilePath],
  );
  const [retryState, setRetryState] = useState<{ cacheKey: string; nonce: number }>({
    cacheKey: "",
    nonce: 0,
  });
  const [directErrorKey, setDirectErrorKey] = useState<string | null>(null);
  const [localState, setLocalState] = useState<LocalImageLoadState | null>(null);

  const activeRetryNonce =
    classified.kind === "local" && retryState.cacheKey === classified.cacheKey
      ? retryState.nonce
      : 0;

  const requestKey =
    classified.kind === "local"
      ? `${classified.cacheKey}::${imageReloadVersion}::${activeRetryNonce}`
      : "";

  const directKey =
    classified.kind === "direct" ? `${classified.src}::${imageReloadVersion}` : "";

  useEffect(() => {
    if (classified.kind !== "local") return;

    const cached = activeRetryNonce === 0 ? imageCache.get(classified.cacheKey) : null;
    if (cached) {
      setLocalState({
        key: requestKey,
        status: "loaded",
        dataUrl: cached.dataUrl,
        filePath: cached.filePath,
      });
      return;
    }

    let cancelled = false;
    setLocalState({ key: requestKey, status: "loading" });

    void imageCache
      .load({
        target: classified.target,
        baseFilePath: classified.baseFilePath,
        cacheKey: classified.cacheKey,
        forceReload: activeRetryNonce > 0,
        loader: loadLocalImage,
      })
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.dataUrl) {
          setLocalState({
            key: requestKey,
            status: "loaded",
            dataUrl: res.dataUrl,
            filePath: res.filePath || classified.resolvedPath || classified.target,
          });
        } else {
          setLocalState({
            key: requestKey,
            status: "error",
            error: res.error ?? `${t(locale, "markdown.imageLoadFailed")}。`,
            filePath: res.filePath || classified.resolvedPath || classified.target,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [classified, imageCache, loadLocalImage, requestKey, activeRetryNonce, locale]);

  const handleOpen = (resolvedSrc: string, filePath?: string) => (e: React.MouseEvent<HTMLImageElement>) => {
    if (!onOpenImage || e.currentTarget.closest("a")) return;
    e.preventDefault();
    onOpenImage({ src: resolvedSrc, alt, filePath });
  };

  const mergedClassName = [
    "max-w-full h-auto rounded-lg",
    onOpenImage ? "cursor-zoom-in transition-opacity hover:opacity-95" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (classified.kind === "direct") {
    if (directErrorKey === directKey) {
      return (
        <span
          data-testid="markdown-image-error"
          className="inline-flex items-center gap-2 max-w-full my-1 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100/80 dark:bg-zinc-900/70 text-[11.5px] text-zinc-600 dark:text-zinc-400 align-middle"
        >
          <ImageOff className="w-3.5 h-3.5 text-rose-500 shrink-0" />
          <span className="truncate">
            {alt ? `${alt} — ` : ""}
            {t(locale, "markdown.imageLoadFailed")} ({classified.src})
          </span>
        </span>
      );
    }

    return (
      <img
        src={classified.src}
        alt={alt ?? ""}
        title={title ?? (onOpenImage ? t(locale, "markdown.imageZoomTitle") : undefined)}
        width={width}
        height={height}
        style={style}
        loading="lazy"
        data-testid="markdown-image"
        onError={() => setDirectErrorKey(directKey)}
        onClick={handleOpen(classified.src)}
        className={mergedClassName}
      />
    );
  }

  if (classified.kind === "invalid") {
    return (
      <span
        data-testid="markdown-image-error"
        className="inline-flex items-center gap-2 max-w-full my-1 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100/80 dark:bg-zinc-900/70 text-[11.5px] text-zinc-600 dark:text-zinc-400 align-middle"
      >
        <ImageOff className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        <span className="truncate">
          {alt ? `${alt}: ` : ""}
          {classified.error}
          {classified.raw ? ` (${classified.raw})` : ""}
        </span>
      </span>
    );
  }

  // Local image: prefer synchronous cache hit to avoid flicker on re-render
  const syncCached = activeRetryNonce === 0 ? imageCache.get(classified.cacheKey) : null;
  const activeState: LocalImageLoadState =
    localState && localState.key === requestKey
      ? localState
      : syncCached
        ? {
            key: requestKey,
            status: "loaded",
            dataUrl: syncCached.dataUrl,
            filePath: syncCached.filePath,
          }
        : { key: requestKey, status: "loading" };

  if (activeState.status === "loaded") {
    return (
      <img
        src={activeState.dataUrl}
        alt={alt ?? ""}
        title={title ?? (onOpenImage ? t(locale, "markdown.imageZoomTitle") : activeState.filePath)}
        width={width}
        height={height}
        style={style}
        data-testid="markdown-image"
        data-markdown-image-path={activeState.filePath}
        onError={() =>
          setLocalState({
            key: requestKey,
            status: "error",
            error: t(locale, "markdown.imageRenderFailed"),
            filePath: activeState.filePath,
          })
        }
        onClick={handleOpen(activeState.dataUrl, activeState.filePath)}
        className={mergedClassName}
      />
    );
  }

  if (activeState.status === "error") {
    const displayPath = activeState.filePath ?? classified.resolvedPath ?? classified.target;
    return (
      <span
        data-testid="markdown-image-error"
        data-markdown-image-path={displayPath}
        className="inline-flex flex-wrap items-center gap-2 max-w-full my-1 px-2.5 py-1.5 rounded-lg border border-rose-500/25 bg-rose-500/5 text-[11.5px] text-zinc-600 dark:text-zinc-300 align-middle"
      >
        <ImageOff className="w-3.5 h-3.5 text-rose-500 shrink-0" />
        <span className="min-w-0 break-all">
          {alt ? <span className="font-medium mr-1">{alt}</span> : null}
          <span className="text-rose-600 dark:text-rose-400">{activeState.error}</span>
          <span className="ml-1.5 font-mono text-[10.5px] text-zinc-400">{displayPath}</span>
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            imageCache.invalidate(classified.cacheKey);
            setRetryState((prev) => ({
              cacheKey: classified.cacheKey,
              nonce: prev.cacheKey === classified.cacheKey ? prev.nonce + 1 : 1,
            }));
          }}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-200/70 dark:bg-zinc-800 hover:bg-zinc-300/70 dark:hover:bg-zinc-700 text-[10.5px] font-medium cursor-pointer shrink-0"
        >
          <RotateCw className="w-2.5 h-2.5" />
          <span>{t(locale, "common.retry")}</span>
        </button>
      </span>
    );
  }

  return (
    <span
      data-testid="markdown-image-loading"
      data-markdown-image-path={classified.resolvedPath ?? classified.target}
      className="inline-flex items-center gap-1.5 max-w-full my-1 px-2.5 py-1.5 rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-zinc-100/70 dark:bg-zinc-900/60 text-[11.5px] text-zinc-500 dark:text-zinc-400 align-middle"
    >
      <ImageIcon className="w-3.5 h-3.5 text-zinc-400 animate-pulse shrink-0" />
      <span className="truncate">
        {t(locale, "markdown.imageLoading", { name: alt || classified.target })}
      </span>
    </span>
  );
});

type LocalVideoLoadState =
  | { key: string; status: "loading" }
  | { key: string; status: "loaded"; mediaUrl: string; filePath: string; fileName?: string }
  | { key: string; status: "error"; error: string; filePath?: string };

interface MarkdownVideoProps {
  src?: string;
  alt?: string;
  title?: string;
  poster?: string;
  loop?: boolean;
  muted?: boolean;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: React.CSSProperties;
  baseFilePath?: string;
  imageReloadVersion: number;
  videoCache: MarkdownVideoCache;
  loadLocalVideo?: LocalMarkdownVideoLoader;
  locale: UiLocale;
}

function getBaseFileName(rawPath: string | undefined): string {
  if (!rawPath) return "";
  const cleaned = rawPath.split("#")[0]?.split("?")[0] ?? rawPath;
  const parts = cleaned.split(/[/\\]/);
  return parts[parts.length - 1] || cleaned;
}

function openVideoInFinder(filePath: string): void {
  const g = globalThis as {
    window?: { conductor?: { openPathInFinder?: (targetPath: string) => Promise<void> | void } };
  };
  void g.window?.conductor?.openPathInFinder?.(filePath);
}

const MarkdownVideo: React.FC<MarkdownVideoProps> = React.memo(({
  src,
  alt,
  title,
  poster,
  loop,
  muted,
  width,
  height,
  className,
  style,
  baseFilePath,
  imageReloadVersion,
  videoCache,
  loadLocalVideo,
  locale,
}) => {
  const classified = useMemo(
    () => classifyMarkdownVideoSrc(src, baseFilePath),
    [src, baseFilePath],
  );
  const [retryState, setRetryState] = useState<{ cacheKey: string; nonce: number }>({
    cacheKey: "",
    nonce: 0,
  });
  const [directErrorKey, setDirectErrorKey] = useState<string | null>(null);
  const [localState, setLocalState] = useState<LocalVideoLoadState | null>(null);

  const activeRetryNonce =
    classified.kind === "local" && retryState.cacheKey === classified.cacheKey
      ? retryState.nonce
      : 0;

  const requestKey =
    classified.kind === "local"
      ? `${classified.cacheKey}::${imageReloadVersion}::${activeRetryNonce}`
      : "";

  const directKey =
    classified.kind === "direct" ? `${classified.src}::${imageReloadVersion}` : "";

  useEffect(() => {
    if (classified.kind !== "local") return;

    const cached = activeRetryNonce === 0 ? videoCache.get(classified.cacheKey) : null;
    if (cached) {
      setLocalState({
        key: requestKey,
        status: "loaded",
        mediaUrl: cached.mediaUrl,
        filePath: cached.filePath,
        fileName: cached.fileName,
      });
      return;
    }

    let cancelled = false;
    setLocalState({ key: requestKey, status: "loading" });

    void videoCache
      .load({
        target: classified.target,
        baseFilePath: classified.baseFilePath,
        cacheKey: classified.cacheKey,
        forceReload: activeRetryNonce > 0,
        loader: loadLocalVideo,
      })
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.mediaUrl) {
          setLocalState({
            key: requestKey,
            status: "loaded",
            mediaUrl: res.mediaUrl,
            filePath: res.filePath || classified.resolvedPath || classified.target,
            fileName: res.fileName,
          });
        } else {
          setLocalState({
            key: requestKey,
            status: "error",
            error: res.error ?? `${t(locale, "markdown.videoLoadFailed")}。`,
            filePath: res.filePath || classified.resolvedPath || classified.target,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [classified, videoCache, loadLocalVideo, requestKey, activeRetryNonce, locale]);

  const videoClassName = [
    "block max-w-full max-h-[420px] w-full bg-black",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (classified.kind === "direct") {
    if (directErrorKey === directKey) {
      return (
        <span
          data-testid="markdown-video-error"
          className="inline-flex items-center gap-2 max-w-full my-1 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100/80 dark:bg-zinc-900/70 text-[11.5px] text-zinc-600 dark:text-zinc-400 align-middle"
        >
          <VideoOff className="w-3.5 h-3.5 text-rose-500 shrink-0" />
          <span className="truncate">
            {alt ? `${alt} — ` : ""}
            {t(locale, "markdown.videoLoadFailed")} ({classified.src})
          </span>
        </span>
      );
    }

    const label = alt?.trim() || title?.trim() || getBaseFileName(classified.src);

    return (
      <span
        data-testid="markdown-video-container"
        className="block my-2 max-w-full rounded-lg overflow-hidden border border-zinc-200/80 dark:border-zinc-800 bg-zinc-950"
      >
        <video
          src={classified.src}
          controls
          playsInline
          preload="metadata"
          poster={poster}
          loop={loop}
          muted={muted}
          width={width}
          height={height}
          title={title ?? alt}
          aria-label={alt || title || label || undefined}
          style={style}
          data-testid="markdown-video"
          onError={() => setDirectErrorKey(directKey)}
          className={videoClassName}
        />
        {label && (
          <span className="flex items-center gap-1.5 px-2.5 py-1.5 bg-zinc-100/90 dark:bg-zinc-900/90 border-t border-zinc-200/70 dark:border-zinc-800 text-[11px] text-zinc-600 dark:text-zinc-400">
            <Film className="w-3 h-3 text-indigo-500 shrink-0" />
            <span className="truncate">{label}</span>
          </span>
        )}
      </span>
    );
  }

  if (classified.kind === "invalid") {
    return (
      <span
        data-testid="markdown-video-error"
        className="inline-flex items-center gap-2 max-w-full my-1 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100/80 dark:bg-zinc-900/70 text-[11.5px] text-zinc-600 dark:text-zinc-400 align-middle"
      >
        <VideoOff className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        <span className="truncate">
          {alt ? `${alt}: ` : ""}
          {classified.error}
          {classified.raw ? ` (${classified.raw})` : ""}
        </span>
      </span>
    );
  }

  // Local video: prefer synchronous cache hit to avoid flicker on re-render
  const syncCached = activeRetryNonce === 0 ? videoCache.get(classified.cacheKey) : null;
  const activeState: LocalVideoLoadState =
    localState && localState.key === requestKey
      ? localState
      : syncCached
        ? {
            key: requestKey,
            status: "loaded",
            mediaUrl: syncCached.mediaUrl,
            filePath: syncCached.filePath,
            fileName: syncCached.fileName,
          }
        : { key: requestKey, status: "loading" };

  if (activeState.status === "loaded") {
    const label =
      alt?.trim() ||
      title?.trim() ||
      activeState.fileName ||
      getBaseFileName(activeState.filePath);

    return (
      <span
        data-testid="markdown-video-container"
        className="block my-2 max-w-full rounded-lg overflow-hidden border border-zinc-200/80 dark:border-zinc-800 bg-zinc-950"
      >
        <video
          src={activeState.mediaUrl}
          controls
          playsInline
          preload="metadata"
          poster={poster}
          loop={loop}
          muted={muted}
          width={width}
          height={height}
          title={title ?? alt ?? activeState.filePath}
          aria-label={alt || title || label || undefined}
          style={style}
          data-testid="markdown-video"
          data-markdown-video-path={activeState.filePath}
          onError={() =>
            setLocalState({
              key: requestKey,
              status: "error",
              error: t(locale, "markdown.videoRenderFailed"),
              filePath: activeState.filePath,
            })
          }
          className={videoClassName}
        />
        <span className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-zinc-100/90 dark:bg-zinc-900/90 border-t border-zinc-200/70 dark:border-zinc-800 text-[11px] text-zinc-600 dark:text-zinc-400">
          <span className="inline-flex items-center gap-1.5 min-w-0">
            <Film className="w-3 h-3 text-indigo-500 shrink-0" />
            <span className="truncate" title={activeState.filePath}>
              {label}
            </span>
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openVideoInFinder(activeState.filePath);
            }}
            title={t(locale, "markdown.videoOpenInFinderTitle")}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-200/70 dark:bg-zinc-800 hover:bg-zinc-300/70 dark:hover:bg-zinc-700 text-[10.5px] font-medium text-zinc-700 dark:text-zinc-200 cursor-pointer shrink-0"
          >
            <FolderOpen className="w-2.5 h-2.5" />
            <span>{t(locale, "markdown.videoRevealInFinder")}</span>
          </button>
        </span>
      </span>
    );
  }

  if (activeState.status === "error") {
    const displayPath = activeState.filePath ?? classified.resolvedPath ?? classified.target;
    return (
      <span
        data-testid="markdown-video-error"
        data-markdown-video-path={displayPath}
        className="inline-flex flex-wrap items-center gap-2 max-w-full my-1 px-2.5 py-1.5 rounded-lg border border-rose-500/25 bg-rose-500/5 text-[11.5px] text-zinc-600 dark:text-zinc-300 align-middle"
      >
        <VideoOff className="w-3.5 h-3.5 text-rose-500 shrink-0" />
        <span className="min-w-0 break-all">
          {alt ? <span className="font-medium mr-1">{alt}</span> : null}
          <span className="text-rose-600 dark:text-rose-400">{activeState.error}</span>
          <span className="ml-1.5 font-mono text-[10.5px] text-zinc-400">{displayPath}</span>
        </span>
        {displayPath && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openVideoInFinder(displayPath);
            }}
            title={t(locale, "markdown.videoOpenInFinderTitle")}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-200/70 dark:bg-zinc-800 hover:bg-zinc-300/70 dark:hover:bg-zinc-700 text-[10.5px] font-medium cursor-pointer shrink-0"
          >
            <FolderOpen className="w-2.5 h-2.5" />
            <span>{t(locale, "markdown.videoRevealInFinder")}</span>
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            videoCache.invalidate(classified.cacheKey);
            setRetryState((prev) => ({
              cacheKey: classified.cacheKey,
              nonce: prev.cacheKey === classified.cacheKey ? prev.nonce + 1 : 1,
            }));
          }}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-zinc-200/70 dark:bg-zinc-800 hover:bg-zinc-300/70 dark:hover:bg-zinc-700 text-[10.5px] font-medium cursor-pointer shrink-0"
        >
          <RotateCw className="w-2.5 h-2.5" />
          <span>{t(locale, "common.retry")}</span>
        </button>
      </span>
    );
  }

  return (
    <span
      data-testid="markdown-video-loading"
      data-markdown-video-path={classified.resolvedPath ?? classified.target}
      className="inline-flex items-center gap-1.5 max-w-full my-1 px-2.5 py-1.5 rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-zinc-100/70 dark:bg-zinc-900/60 text-[11.5px] text-zinc-500 dark:text-zinc-400 align-middle"
    >
      <Film className="w-3.5 h-3.5 text-zinc-400 animate-pulse shrink-0" />
      <span className="truncate">
        {t(locale, "markdown.videoLoading", { name: alt || classified.target })}
      </span>
    </span>
  );
});

function extractVideoSourceFromChildren(children: React.ReactNode): string | undefined {
  for (const child of React.Children.toArray(children)) {
    if (React.isValidElement<{ src?: string; srcSet?: string }>(child)) {
      if (typeof child.props?.src === "string" && child.props.src.trim()) {
        return child.props.src;
      }
      if (typeof child.props?.srcSet === "string" && child.props.srcSet.trim()) {
        return child.props.srcSet.split(",")[0]?.trim().split(/\s+/)[0];
      }
    }
  }
  return undefined;
}

interface MarkdownPictureSourceProps extends React.SourceHTMLAttributes<HTMLSourceElement> {
  baseFilePath?: string;
  imageReloadVersion: number;
  imageCache: MarkdownImageCache;
  loadLocalImage?: LocalMarkdownImageLoader;
}

/**
 * Resolves local <source srcset="..."> entries inside GitHub-style <picture> blocks.
 * Returns null while unresolved so the fallback <img> inside <picture> renders cleanly.
 */
const MarkdownPictureSource: React.FC<MarkdownPictureSourceProps> = React.memo(({
  srcSet,
  baseFilePath,
  imageReloadVersion,
  imageCache,
  loadLocalImage,
  ...rest
}) => {
  const parsed = useMemo(() => {
    if (!srcSet) return null;
    const firstCandidate = srcSet.split(",")[0]?.trim();
    if (!firstCandidate) return null;
    const parts = firstCandidate.split(/\s+/);
    const url = parts[0];
    const descriptor = parts.slice(1).join(" ");
    return { url, descriptor };
  }, [srcSet]);

  const classified = useMemo(
    () => (parsed ? classifyMarkdownImageSrc(parsed.url, baseFilePath) : null),
    [parsed, baseFilePath],
  );

  const requestKey =
    classified?.kind === "local" ? `${classified.cacheKey}::${imageReloadVersion}` : "";

  const [loadedSrc, setLoadedSrc] = useState<{ key: string; dataUrl: string } | null>(null);

  useEffect(() => {
    if (!classified || classified.kind !== "local") return;
    const cached = imageCache.get(classified.cacheKey);
    if (cached) {
      setLoadedSrc({ key: requestKey, dataUrl: cached.dataUrl });
      return;
    }

    let cancelled = false;
    void imageCache
      .load({
        target: classified.target,
        baseFilePath: classified.baseFilePath,
        cacheKey: classified.cacheKey,
        loader: loadLocalImage,
      })
      .then((res) => {
        if (!cancelled && res.ok && res.dataUrl) {
          setLoadedSrc({ key: requestKey, dataUrl: res.dataUrl });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [classified, imageCache, loadLocalImage, requestKey]);

  if (!parsed || !classified || classified.kind === "invalid") {
    return null;
  }

  let resolvedUrl: string | null = null;
  if (classified.kind === "direct") {
    resolvedUrl = classified.src;
  } else {
    const syncCached = imageCache.get(classified.cacheKey);
    if (loadedSrc && loadedSrc.key === requestKey) {
      resolvedUrl = loadedSrc.dataUrl;
    } else if (syncCached) {
      resolvedUrl = syncCached.dataUrl;
    }
  }

  if (!resolvedUrl) {
    return null;
  }

  const finalSrcSet = parsed.descriptor ? `${resolvedUrl} ${parsed.descriptor}` : resolvedUrl;
  return <source {...rest} srcSet={finalSrcSet} />;
});

function extractNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractNodeText).join("");
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return extractNodeText(node.props.children);
  }
  return "";
}

const CodeBlock = React.memo(function CodeBlock({
  language,
  code,
  isUserBubble = false,
}: {
  language: string;
  code: string;
  isUserBubble?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const lineCount = code.length === 0 ? 0 : code.split("\n").length;

  return (
    <div
      className={`${
        isUserBubble
          ? "my-2 border-indigo-500/20 dark:border-indigo-400/25 bg-white/85 dark:bg-[#121520]/90 text-zinc-900 dark:text-zinc-100"
          : "my-2.5 border-zinc-200/80 dark:border-zinc-800 bg-zinc-50 dark:bg-[#14171f]"
      } overflow-hidden rounded-lg border`}
    >
      <div
        className={`flex items-center justify-between px-3 py-1.5 text-[11px] border-b ${
          isUserBubble
            ? "text-zinc-600 dark:text-zinc-300 bg-indigo-500/[0.07] dark:bg-indigo-950/60 border-indigo-500/15 dark:border-indigo-400/20"
            : "text-zinc-500 dark:text-zinc-400 bg-zinc-100/80 dark:bg-zinc-900/80 border-zinc-200/70 dark:border-zinc-800"
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium">{language || "code"}</span>
          {lineCount > 1 && (
            <span
              className={`text-[10px] ${
                isUserBubble
                  ? "text-zinc-500 dark:text-zinc-400"
                  : "text-zinc-400 dark:text-zinc-500"
              }`}
            >
              {lineCount} lines
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed font-mono select-text">
        <code>{code}</code>
      </pre>
    </div>
  );
});

export const MarkdownView: React.FC<MarkdownViewProps> = React.memo(({
  content,
  locale = "ja",
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenImage,
  baseFilePath,
  variant = "chat",
  preserveSingleLineBreaks,
  mentionContext,
  headingIdPrefix = "",
  onScrollToHeading,
  imageReloadVersion = 0,
  imageCache = defaultMarkdownImageCache,
  loadLocalImage,
  videoCache = defaultMarkdownVideoCache,
  loadLocalVideo,
}) => {
  const isUserBubble = variant === "user";
  const enableSingleLineBreaks = preserveSingleLineBreaks ?? isUserBubble;
  const slugCountsRef = useRef<Map<string, number>>(new Map());
  slugCountsRef.current = new Map();

  const remarkPlugins = useMemo(
    () => (enableSingleLineBreaks ? [remarkGfm, remarkSingleLineBreaks] : [remarkGfm]),
    [enableSingleLineBreaks],
  );

  const rehypePlugins = useMemo(() => {
    const plugins: NonNullable<React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]> =
      isUserBubble ? [] : [rehypeRaw, [rehypeSanitize, CONDUCTOR_SANITIZE_SCHEMA]];
    if (mentionContext) {
      plugins.push(createRehypeHighlightMentions(mentionContext.projects, mentionContext.tasks));
    }
    return plugins;
  }, [isUserBubble, mentionContext]);

  const renderImage = useCallback(
    ({
      src,
      alt,
      title,
      width,
      height,
      className,
      style,
    }: React.ImgHTMLAttributes<HTMLImageElement>) => {
      const normalizedSrc = typeof src === "string" ? src : undefined;
      if (isVideoPathOrUrl(normalizedSrc)) {
        return (
          <MarkdownVideo
            src={normalizedSrc}
            alt={alt}
            title={title}
            width={width}
            height={height}
            className={className}
            style={style}
            baseFilePath={baseFilePath}
            imageReloadVersion={imageReloadVersion}
            videoCache={videoCache}
            loadLocalVideo={loadLocalVideo}
            locale={locale}
          />
        );
      }
      return (
        <MarkdownImage
          src={normalizedSrc}
          alt={alt}
          title={title}
          width={width}
          height={height}
          className={className}
          style={style}
          baseFilePath={baseFilePath}
          onOpenImage={onOpenImage}
          imageReloadVersion={imageReloadVersion}
          imageCache={imageCache}
          loadLocalImage={loadLocalImage}
          locale={locale}
        />
      );
    },
    [
      baseFilePath,
      onOpenImage,
      imageReloadVersion,
      imageCache,
      loadLocalImage,
      videoCache,
      loadLocalVideo,
      locale,
    ],
  );

  const renderVideo = useCallback(
    ({
      src,
      title,
      poster,
      loop,
      muted,
      width,
      height,
      className,
      style,
      children,
    }: React.VideoHTMLAttributes<HTMLVideoElement>) => {
      const resolvedSrc =
        (typeof src === "string" && src.trim() ? src : undefined) ??
        extractVideoSourceFromChildren(children);
      return (
        <MarkdownVideo
          src={resolvedSrc}
          alt={title}
          title={title}
          poster={poster}
          loop={loop}
          muted={muted}
          width={width}
          height={height}
          className={className}
          style={style}
          baseFilePath={baseFilePath}
          imageReloadVersion={imageReloadVersion}
          videoCache={videoCache}
          loadLocalVideo={loadLocalVideo}
          locale={locale}
        />
      );
    },
    [baseFilePath, imageReloadVersion, videoCache, loadLocalVideo, locale],
  );

  const renderSource = useCallback(
    ({ srcSet, media, type, sizes }: React.SourceHTMLAttributes<HTMLSourceElement>) => (
      <MarkdownPictureSource
        srcSet={srcSet}
        media={media}
        type={type}
        sizes={sizes}
        baseFilePath={baseFilePath}
        imageReloadVersion={imageReloadVersion}
        imageCache={imageCache}
        loadLocalImage={loadLocalImage}
      />
    ),
    [baseFilePath, imageReloadVersion, imageCache, loadLocalImage],
  );

  const markdownComponents = useMemo<
    NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]>
  >(() => {
    const makeHeading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
      return ({ children }: { children?: React.ReactNode }) => {
        const slug = uniqueSlug(extractNodeText(children), slugCountsRef.current);
        const id = headingIdPrefix ? `${headingIdPrefix}${slug}` : undefined;
        return <Tag id={id}>{children}</Tag>;
      };
    };

    return {
      h1: makeHeading("h1"),
      h2: makeHeading("h2"),
      h3: makeHeading("h3"),
      h4: makeHeading("h4"),
      h5: makeHeading("h5"),
      h6: makeHeading("h6"),
      img: renderImage,
      video: renderVideo,
      source: renderSource,
      span(props) {
        const rawProps = props as React.HTMLAttributes<HTMLSpanElement> & {
          node?: unknown;
          "data-conductor-mention-kind"?: string;
          "data-conductor-task-id"?: string;
          "data-conductor-project-color"?: string;
          "data-conductor-mention-title"?: string;
        };
        const mentionKind = rawProps["data-conductor-mention-kind"];
        if (mentionKind === "task" && mentionContext) {
          const taskId = rawProps["data-conductor-task-id"] ?? "";
          const title = rawProps["data-conductor-mention-title"];
          return (
            <button
              type="button"
              onClick={() => mentionContext.onOpenTask(taskId)}
              title={title}
              className="inline-flex items-center px-1.5 py-0.2 mx-0.2 rounded-md font-mono text-[12.5px] font-semibold bg-indigo-500/20 text-indigo-700 dark:text-indigo-200 hover:bg-indigo-500/30 transition-colors cursor-pointer align-baseline"
            >
              {props.children}
            </button>
          );
        }
        if (mentionKind === "project") {
          const colorHex = rawProps["data-conductor-project-color"];
          const title = rawProps["data-conductor-mention-title"];
          return (
            <span
              title={title}
              className="inline-flex items-center px-1.5 py-0.2 mx-0.2 rounded-md font-medium text-[13px] align-baseline"
              style={
                colorHex
                  ? {
                      backgroundColor: `${colorHex}24`,
                      color: colorHex,
                    }
                  : undefined
              }
            >
              {props.children}
            </span>
          );
        }
        if (mentionKind === "unresolved") {
          return (
            <span className="inline-flex items-center px-1.5 py-0.2 mx-0.2 rounded-md font-mono text-[12.5px] bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 align-baseline">
              {props.children}
            </span>
          );
        }
        const { node: _node, ...rest } = rawProps;
        return <span {...rest} />;
      },
      a({ href, children }) {
        const classified = classifyLinkHref(href, baseFilePath);
        const isLocalMd = classified.kind === "markdown" && Boolean(onOpenMarkdownFile);

        return (
          <a
            href={href}
            title={isLocalMd ? t(locale, "markdown.openInViewerTitle") : undefined}
            onClick={(e) => {
              if (classified.kind === "web") {
                e.preventDefault();
                onOpenUrl(classified.url);
              } else if (classified.kind === "markdown" && onOpenMarkdownFile) {
                e.preventDefault();
                onOpenMarkdownFile(classified.target, classified.baseFilePath);
              } else if (classified.kind === "anchor") {
                e.preventDefault();
                if (onScrollToHeading) {
                  onScrollToHeading(classified.id);
                } else if (headingIdPrefix) {
                  const el = document.getElementById(`${headingIdPrefix}${classified.id}`);
                  el?.scrollIntoView({ behavior: "smooth", block: "start" });
                }
              }
            }}
          >
            {isLocalMd && (
              <FileText
                className={`inline-block w-3.5 h-3.5 mr-1 -mt-0.5 align-middle ${
                  isUserBubble ? "text-current" : "text-indigo-500"
                }`}
              />
            )}
            {children}
          </a>
        );
      },
      table({ children }) {
        return (
          <div className="conductor-md-table-wrap">
            <table>{children}</table>
          </div>
        );
      },
      pre({ children }) {
        const childArray = React.Children.toArray(children);
        const firstChild =
          childArray.length === 1 && React.isValidElement<{
            className?: string;
            children?: React.ReactNode;
          }>(childArray[0])
            ? childArray[0]
            : null;

        if (!firstChild || firstChild.type !== "code") {
          return (
            <pre
              className={`${
                isUserBubble
                  ? "my-2 border-indigo-500/20 dark:border-indigo-400/25 bg-white/85 dark:bg-[#121520]/90 text-zinc-900 dark:text-zinc-100"
                  : "my-2.5 border-zinc-200/80 dark:border-zinc-800 bg-zinc-50 dark:bg-[#14171f]"
              } overflow-x-auto p-3 rounded-lg border text-[12.5px] leading-relaxed font-mono select-text`}
            >
              {children}
            </pre>
          );
        }

        const className = firstChild.props?.className ?? "";
        const match = /language-([^\s]+)/.exec(className);
        const language = match?.[1] ?? "";
        const code = extractNodeText(firstChild.props?.children).replace(/\n$/, "");

        if (isMermaidLanguage(language)) {
          return <MermaidBlock code={code} locale={locale} />;
        }

        return <CodeBlock language={language} code={code} isUserBubble={isUserBubble} />;
      },
    };
  }, [
    headingIdPrefix,
    renderImage,
    renderVideo,
    renderSource,
    mentionContext,
    baseFilePath,
    onOpenMarkdownFile,
    locale,
    onOpenUrl,
    onScrollToHeading,
    isUserBubble,
  ]);

  const variantClass =
    variant === "document"
      ? "conductor-markdown-doc"
      : variant === "user"
        ? "conductor-markdown-user"
        : "";

  const normalizedContent = useMemo(
    () => (isUserBubble ? content : normalizeMarkdownSpacedMediaDestinations(content)),
    [content, isUserBubble],
  );

  return (
    <div
      className={`conductor-markdown ${variantClass} select-text ${
        isUserBubble ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-800 dark:text-zinc-100"
      }`}
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={conductorUrlTransform}
        components={markdownComponents}
      >
        {normalizedContent}
      </ReactMarkdown>
    </div>
  );
});
