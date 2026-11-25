import type { ImageReadResult } from "../../shared/types.js";

export interface CachedMarkdownImage {
  dataUrl: string;
  filePath: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export type LocalMarkdownImageLoader = (
  filePathOrUrl: string,
  baseFilePath?: string,
) => Promise<ImageReadResult>;

export const MAX_MARKDOWN_IMAGE_CACHE_ENTRIES = 120;

function getDefaultLocalImageLoader(): LocalMarkdownImageLoader | undefined {
  const g = globalThis as {
    window?: { conductor?: { imageReadFile?: LocalMarkdownImageLoader } };
  };
  return g.window?.conductor?.imageReadFile;
}

export class MarkdownImageCache {
  private readonly maxEntries: number;
  private readonly cache = new Map<string, CachedMarkdownImage>();
  private readonly inFlight = new Map<string, Promise<ImageReadResult>>();

  constructor(maxEntries = MAX_MARKDOWN_IMAGE_CACHE_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  public get(cacheKey: string): CachedMarkdownImage | null {
    const existing = this.cache.get(cacheKey);
    if (!existing) return null;
    // Refresh LRU recency
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, existing);
    return existing;
  }

  public set(cacheKey: string, entry: CachedMarkdownImage): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  public invalidate(cacheKey?: string): void {
    if (cacheKey === undefined) {
      this.cache.clear();
      this.inFlight.clear();
      return;
    }
    this.cache.delete(cacheKey);
    this.inFlight.delete(cacheKey);
  }

  public size(): number {
    return this.cache.size;
  }

  public async load(params: {
    target: string;
    baseFilePath?: string;
    cacheKey: string;
    forceReload?: boolean;
    loader?: LocalMarkdownImageLoader;
  }): Promise<ImageReadResult> {
    const { target, baseFilePath, cacheKey, forceReload = false } = params;

    if (forceReload) {
      this.cache.delete(cacheKey);
    } else {
      const cached = this.get(cacheKey);
      if (cached) {
        return {
          ok: true,
          filePath: cached.filePath,
          fileName: cached.fileName,
          dataUrl: cached.dataUrl,
          mimeType: cached.mimeType,
          sizeBytes: cached.sizeBytes,
        };
      }
      const pending = this.inFlight.get(cacheKey);
      if (pending) {
        return pending;
      }
    }

    const loader = params.loader ?? getDefaultLocalImageLoader();

    if (!loader) {
      return {
        ok: false,
        filePath: target,
        error: "ローカル画像ローダーを利用できません。",
      };
    }

    const promise = Promise.resolve()
      .then(() => loader(target, baseFilePath))
      .then((res): ImageReadResult => {
        if (res.ok && res.dataUrl) {
          const entry: CachedMarkdownImage = {
            dataUrl: res.dataUrl,
            filePath: res.filePath || target,
            fileName: res.fileName,
            mimeType: res.mimeType,
            sizeBytes: res.sizeBytes,
          };
          this.set(cacheKey, entry);
          // Also index by canonical filePath so alternate relative paths to the same image hit cache
          if (res.filePath && res.filePath !== cacheKey) {
            this.set(res.filePath, entry);
          }
          return res;
        }
        return {
          ok: false,
          filePath: res.filePath || target,
          error: res.error ?? "画像を読み込めませんでした。",
        };
      })
      .catch((err): ImageReadResult => ({
        ok: false,
        filePath: target,
        error: err instanceof Error ? err.message : "画像を読み込めませんでした。",
      }))
      .finally(() => {
        if (this.inFlight.get(cacheKey) === promise) {
          this.inFlight.delete(cacheKey);
        }
      });

    this.inFlight.set(cacheKey, promise);
    return promise;
  }
}

export const defaultMarkdownImageCache = new MarkdownImageCache();

export function getCachedMarkdownImage(cacheKey: string): CachedMarkdownImage | null {
  return defaultMarkdownImageCache.get(cacheKey);
}

export function loadLocalMarkdownImage(params: {
  target: string;
  baseFilePath?: string;
  cacheKey: string;
  forceReload?: boolean;
  loader?: LocalMarkdownImageLoader;
}): Promise<ImageReadResult> {
  return defaultMarkdownImageCache.load(params);
}

export function invalidateMarkdownImageCache(cacheKey?: string): void {
  defaultMarkdownImageCache.invalidate(cacheKey);
}
