import type { VideoReadResult } from "../../shared/types.js";

export interface CachedMarkdownVideo {
  mediaUrl: string;
  filePath: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export type LocalMarkdownVideoLoader = (
  filePathOrUrl: string,
  baseFilePath?: string,
) => Promise<VideoReadResult>;

export const MAX_MARKDOWN_VIDEO_CACHE_ENTRIES = 60;

function getDefaultLocalVideoLoader(): LocalMarkdownVideoLoader | undefined {
  const g = globalThis as {
    window?: { conductor?: { mediaReadVideo?: LocalMarkdownVideoLoader } };
  };
  return g.window?.conductor?.mediaReadVideo;
}

export class MarkdownVideoCache {
  private readonly maxEntries: number;
  private readonly cache = new Map<string, CachedMarkdownVideo>();
  private readonly inFlight = new Map<string, Promise<VideoReadResult>>();

  constructor(maxEntries = MAX_MARKDOWN_VIDEO_CACHE_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  public get(cacheKey: string): CachedMarkdownVideo | null {
    const existing = this.cache.get(cacheKey);
    if (!existing) return null;
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, existing);
    return existing;
  }

  public set(cacheKey: string, entry: CachedMarkdownVideo): void {
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
    loader?: LocalMarkdownVideoLoader;
  }): Promise<VideoReadResult> {
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
          mediaUrl: cached.mediaUrl,
          mimeType: cached.mimeType,
          sizeBytes: cached.sizeBytes,
        };
      }
      const pending = this.inFlight.get(cacheKey);
      if (pending) {
        return pending;
      }
    }

    const loader = params.loader ?? getDefaultLocalVideoLoader();
    if (!loader) {
      return {
        ok: false,
        filePath: target,
        error: "ローカル動画ローダーを利用できません。",
      };
    }

    const promise = Promise.resolve()
      .then(() => loader(target, baseFilePath))
      .then((res): VideoReadResult => {
        if (res.ok && res.mediaUrl) {
          const entry: CachedMarkdownVideo = {
            mediaUrl: res.mediaUrl,
            filePath: res.filePath || target,
            fileName: res.fileName,
            mimeType: res.mimeType,
            sizeBytes: res.sizeBytes,
          };
          this.set(cacheKey, entry);
          if (res.filePath && res.filePath !== cacheKey) {
            this.set(res.filePath, entry);
          }
          return res;
        }
        return {
          ok: false,
          filePath: res.filePath || target,
          error: res.error ?? "動画を読み込めませんでした。",
        };
      })
      .catch((err): VideoReadResult => ({
        ok: false,
        filePath: target,
        error: err instanceof Error ? err.message : "動画を読み込めませんでした。",
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

export const defaultMarkdownVideoCache = new MarkdownVideoCache();
