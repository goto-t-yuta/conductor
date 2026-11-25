import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, FileText, Image as ImageIcon, ImageOff, RotateCw } from "lucide-react";
import {
  defaultMarkdownImageCache,
  type LocalMarkdownImageLoader,
  type MarkdownImageCache,
} from "../lib/markdown-image-cache.js";
import {
  classifyLinkHref,
  classifyMarkdownImageSrc,
  transformMarkdownUrl,
  uniqueSlug,
} from "../lib/markdown-utils.js";

export interface MarkdownOpenedImage {
  src: string;
  alt?: string;
  filePath?: string;
}

interface MarkdownViewProps {
  content: string;
  onOpenUrl: (url: string) => void;
  onOpenMarkdownFile?: (target: string, baseFilePath?: string) => void;
  onOpenImage?: (image: MarkdownOpenedImage) => void;
  baseFilePath?: string;
  variant?: "chat" | "document";
  headingIdPrefix?: string;
  onScrollToHeading?: (id: string) => void;
  imageReloadVersion?: number;
  imageCache?: MarkdownImageCache;
  loadLocalImage?: LocalMarkdownImageLoader;
}

function conductorUrlTransform(url: string, key: string): string {
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
  baseFilePath?: string;
  onOpenImage?: (image: MarkdownOpenedImage) => void;
  imageReloadVersion: number;
  imageCache: MarkdownImageCache;
  loadLocalImage?: LocalMarkdownImageLoader;
}

const MarkdownImage: React.FC<MarkdownImageProps> = ({
  src,
  alt,
  title,
  baseFilePath,
  onOpenImage,
  imageReloadVersion,
  imageCache,
  loadLocalImage,
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
            error: res.error ?? "画像を読み込めませんでした。",
            filePath: res.filePath || classified.resolvedPath || classified.target,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [classified, imageCache, loadLocalImage, requestKey, activeRetryNonce]);

  const handleOpen = (resolvedSrc: string, filePath?: string) => (e: React.MouseEvent<HTMLImageElement>) => {
    if (!onOpenImage || e.currentTarget.closest("a")) return;
    e.preventDefault();
    onOpenImage({ src: resolvedSrc, alt, filePath });
  };

  if (classified.kind === "direct") {
    if (directErrorKey === directKey) {
      return (
        <span
          data-testid="markdown-image-error"
          className="inline-flex items-center gap-2 max-w-full my-1 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-100/80 dark:bg-zinc-900/70 text-[11.5px] text-zinc-600 dark:text-zinc-400 align-middle"
        >
          <ImageOff className="w-3.5 h-3.5 text-rose-500 shrink-0" />
          <span className="truncate">
            {alt ? `${alt} — ` : ""}画像を読み込めませんでした ({classified.src})
          </span>
        </span>
      );
    }

    return (
      <img
        src={classified.src}
        alt={alt ?? ""}
        title={title ?? (onOpenImage ? "クリックで Image Viewer で拡大表示" : undefined)}
        loading="lazy"
        onError={() => setDirectErrorKey(directKey)}
        onClick={handleOpen(classified.src)}
        className={`max-w-full h-auto rounded-lg ${
          onOpenImage ? "cursor-zoom-in transition-opacity hover:opacity-95" : ""
        }`}
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
        title={title ?? (onOpenImage ? "クリックで Image Viewer で拡大表示" : activeState.filePath)}
        data-markdown-image-path={activeState.filePath}
        onError={() =>
          setLocalState({
            key: requestKey,
            status: "error",
            error: "画像データの表示に失敗しました。",
            filePath: activeState.filePath,
          })
        }
        onClick={handleOpen(activeState.dataUrl, activeState.filePath)}
        className={`max-w-full h-auto rounded-lg ${
          onOpenImage ? "cursor-zoom-in transition-opacity hover:opacity-95" : ""
        }`}
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
          <span>再試行</span>
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
      <span className="truncate">{alt || classified.target} を読み込み中...</span>
    </span>
  );
};

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

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const lineCount = code.length === 0 ? 0 : code.split("\n").length;

  return (
    <div className="my-2.5 overflow-hidden rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50 dark:bg-[#14171f]">
      <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 bg-zinc-100/80 dark:bg-zinc-900/80 border-b border-zinc-200/70 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium">{language || "code"}</span>
          {lineCount > 1 && (
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{lineCount} lines</span>
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
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({
  content,
  onOpenUrl,
  onOpenMarkdownFile,
  onOpenImage,
  baseFilePath,
  variant = "chat",
  headingIdPrefix = "",
  onScrollToHeading,
  imageReloadVersion = 0,
  imageCache = defaultMarkdownImageCache,
  loadLocalImage,
}) => {
  const slugCounts = new Map<string, number>();

  const makeHeading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
    return ({ children }: { children?: React.ReactNode }) => {
      const slug = uniqueSlug(extractNodeText(children), slugCounts);
      const id = headingIdPrefix ? `${headingIdPrefix}${slug}` : undefined;
      return <Tag id={id}>{children}</Tag>;
    };
  };

  const renderImage = useCallback(
    ({ src, alt, title }: React.ImgHTMLAttributes<HTMLImageElement>) => (
      <MarkdownImage
        src={typeof src === "string" ? src : undefined}
        alt={alt}
        title={title}
        baseFilePath={baseFilePath}
        onOpenImage={onOpenImage}
        imageReloadVersion={imageReloadVersion}
        imageCache={imageCache}
        loadLocalImage={loadLocalImage}
      />
    ),
    [baseFilePath, onOpenImage, imageReloadVersion, imageCache, loadLocalImage],
  );

  return (
    <div
      className={`conductor-markdown ${
        variant === "document" ? "conductor-markdown-doc" : ""
      } select-text text-zinc-800 dark:text-zinc-100`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={conductorUrlTransform}
        components={{
          h1: makeHeading("h1"),
          h2: makeHeading("h2"),
          h3: makeHeading("h3"),
          h4: makeHeading("h4"),
          h5: makeHeading("h5"),
          h6: makeHeading("h6"),
          img: renderImage,
          a({ href, children }) {
            const classified = classifyLinkHref(href, baseFilePath);
            const isLocalMd = classified.kind === "markdown" && Boolean(onOpenMarkdownFile);

            return (
              <a
                href={href}
                title={isLocalMd ? "Markdown Viewer で開く" : undefined}
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
                  <FileText className="inline-block w-3.5 h-3.5 mr-1 -mt-0.5 text-indigo-500 align-middle" />
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
            const child = React.Children.only(children) as React.ReactElement<{
              className?: string;
              children?: React.ReactNode;
            }>;
            const className = child?.props?.className ?? "";
            const match = /language-([^\s]+)/.exec(className);
            const code = String(child?.props?.children ?? "").replace(/\n$/, "");
            return <CodeBlock language={match?.[1] ?? ""} code={code} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
