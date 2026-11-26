import fs from "node:fs";
import path from "node:path";
import {
  GITHUB_LATEST_RELEASE_PAGE_URL,
  GITHUB_RELEASES_API_URL,
  createInitialAppUpdateState,
  extractReleaseNotesExcerpt,
  isAllowedDownloadUrl,
  isUpdateAvailable,
  parseReleaseTag,
  selectReleaseAssetForPlatform,
  type AppUpdateErrorCode,
  type AppUpdateState,
  type GitHubReleaseDto,
} from "../shared/updater.js";

export interface AppUpdaterOptions {
  currentVersion: string;
  currentTag?: string | null;
  currentCommitSha?: string | null;
  currentRunNumber?: number | null;
  isDevMode: boolean;
  platform?: string;
  arch?: string;
  apiUrl?: string;
  fallbackReleasePageUrl?: string;
  downloadsDir: string;
  fetchImpl?: typeof fetch;
  openPath: (filePath: string) => Promise<string>;
  showItemInFolder: (filePath: string) => void;
  openExternal: (url: string) => Promise<void>;
  onStateChange?: (state: AppUpdateState) => void;
  requestTimeoutMs?: number;
  progressThrottleMs?: number;
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return base || "conductor-update";
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { name?: string }).name === "AbortError";
}

function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  return fallback;
}

function safeUnlink(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore cleanup failures
  }
}

export class AppUpdater {
  private readonly options: Required<
    Pick<
      AppUpdaterOptions,
      "platform" | "arch" | "apiUrl" | "fallbackReleasePageUrl" | "downloadsDir" | "requestTimeoutMs" | "progressThrottleMs"
    >
  > &
    AppUpdaterOptions;

  private state: AppUpdateState;
  private activeCheckPromise: Promise<AppUpdateState> | null = null;
  private checkAbortController: AbortController | null = null;
  private downloadAbortController: AbortController | null = null;
  private downloadCancelledByUser = false;

  constructor(options: AppUpdaterOptions) {
    this.options = {
      ...options,
      platform: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      apiUrl: options.apiUrl ?? GITHUB_RELEASES_API_URL,
      fallbackReleasePageUrl: options.fallbackReleasePageUrl ?? GITHUB_LATEST_RELEASE_PAGE_URL,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      progressThrottleMs: options.progressThrottleMs ?? 80,
    };

    this.state = createInitialAppUpdateState({
      currentVersion: this.options.currentVersion,
      currentTag: this.options.currentTag ?? null,
      currentCommitSha: this.options.currentCommitSha ?? null,
      currentRunNumber: this.options.currentRunNumber ?? null,
      isDevMode: this.options.isDevMode,
      platform: this.options.platform,
      arch: this.options.arch,
    });
  }

  getState(): AppUpdateState {
    return {
      ...this.state,
      latestRelease: this.state.latestRelease
        ? {
            ...this.state.latestRelease,
            selectedAsset: this.state.latestRelease.selectedAsset
              ? { ...this.state.latestRelease.selectedAsset }
              : null,
          }
        : null,
      downloadProgress: this.state.downloadProgress ? { ...this.state.downloadProgress } : null,
    };
  }

  private setState(patch: Partial<AppUpdateState>): AppUpdateState {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    this.options.onStateChange?.(snapshot);
    return snapshot;
  }

  async checkForUpdates(opts?: { silent?: boolean }): Promise<AppUpdateState> {
    const silent = Boolean(opts?.silent);
    if (this.state.status === "downloading") {
      return this.getState();
    }
    if (this.activeCheckPromise) {
      return this.activeCheckPromise;
    }

    const prevState = this.getState();
    const run = (async (): Promise<AppUpdateState> => {
      if (!silent) {
        this.setState({
          status: "checking",
          error: null,
          errorCode: null,
        });
      }

      const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
      const controller = new AbortController();
      this.checkAbortController = controller;
      const timeoutHandle = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
      timeoutHandle.unref?.();

      try {
        const res = await fetchFn(this.options.apiUrl, {
          method: "GET",
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": `Conductor/${this.options.currentVersion}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: controller.signal,
        });

        if (!res.ok) {
          let errorCode: AppUpdateErrorCode = "network";
          let message = `GitHub API returned HTTP ${res.status}`;
          if (res.status === 404) {
            errorCode = "no_release";
            message = "No published release found yet.";
          } else if (
            res.status === 429 ||
            (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
          ) {
            errorCode = "rate_limit";
            message = "GitHub API rate limit exceeded. Please try again later.";
          }

          if (silent) {
            // Silent fallback: keep previous non-error state without disturbing the user
            return prevState;
          }
          return this.setState({
            status: "error",
            lastCheckedAt: new Date().toISOString(),
            error: message,
            errorCode,
          });
        }

        const dto = (await res.json()) as GitHubReleaseDto;
        const tagName = typeof dto.tag_name === "string" ? dto.tag_name.trim() : "";
        if (!tagName) {
          if (silent) return prevState;
          return this.setState({
            status: "error",
            lastCheckedAt: new Date().toISOString(),
            error: "Release tag_name is missing in GitHub API response.",
            errorCode: "no_release",
          });
        }

        const parsedTag = parseReleaseTag(tagName);
        const assets = Array.isArray(dto.assets) ? dto.assets : [];
        const selectedAsset = selectReleaseAssetForPlatform(
          assets,
          this.options.platform,
          this.options.arch,
        );
        const htmlUrl =
          typeof dto.html_url === "string" && dto.html_url.startsWith("https://")
            ? dto.html_url
            : this.options.fallbackReleasePageUrl;
        const body = typeof dto.body === "string" ? dto.body : "";
        const releaseInfo = {
          tagName,
          version: parsedTag?.semver ?? tagName.replace(/^v/i, ""),
          name: (typeof dto.name === "string" && dto.name.trim()) || tagName,
          body,
          notesExcerpt: extractReleaseNotesExcerpt(body),
          htmlUrl,
          publishedAt: typeof dto.published_at === "string" ? dto.published_at : null,
          selectedAsset,
          allAssetsCount: assets.length,
        };

        const updateAvailable = isUpdateAvailable(
          {
            version: this.options.currentVersion,
            tag: this.options.currentTag,
            commitSha: this.options.currentCommitSha,
            runNumber: this.options.currentRunNumber,
          },
          tagName,
          dto.target_commitish,
        );

        const keepDownloaded =
          prevState.downloadedFilePath &&
          prevState.latestRelease?.tagName === tagName &&
          fs.existsSync(prevState.downloadedFilePath);

        return this.setState({
          status: keepDownloaded
            ? "downloaded"
            : updateAvailable
              ? "available"
              : "up_to_date",
          lastCheckedAt: new Date().toISOString(),
          latestRelease: releaseInfo,
          updateAvailable,
          downloadProgress: keepDownloaded ? prevState.downloadProgress : null,
          downloadedFilePath: keepDownloaded ? prevState.downloadedFilePath : null,
          openedInstaller: keepDownloaded ? prevState.openedInstaller : false,
          error: null,
          errorCode: null,
        });
      } catch (err) {
        if (silent) {
          return prevState;
        }
        return this.setState({
          status: "error",
          lastCheckedAt: new Date().toISOString(),
          error: isAbortError(err)
            ? "Update check timed out."
            : toErrorMessage(err, "Failed to check for updates."),
          errorCode: "network",
        });
      } finally {
        clearTimeout(timeoutHandle);
        if (this.checkAbortController === controller) {
          this.checkAbortController = null;
        }
      }
    })();

    this.activeCheckPromise = run;
    try {
      return await run;
    } finally {
      if (this.activeCheckPromise === run) {
        this.activeCheckPromise = null;
      }
    }
  }

  async downloadAndOpen(): Promise<AppUpdateState> {
    if (this.state.status === "downloading") {
      return this.getState();
    }

    const asset = this.state.latestRelease?.selectedAsset;
    if (!asset) {
      return this.setState({
        status: "error",
        error: `No compatible installer asset found for ${this.options.platform} (${this.options.arch}).`,
        errorCode: "no_asset",
      });
    }

    if (!isAllowedDownloadUrl(asset.downloadUrl)) {
      return this.setState({
        status: "error",
        error: "Blocked untrusted update download URL.",
        errorCode: "download_failed",
      });
    }

    const safeName = sanitizeFileName(asset.name);
    fs.mkdirSync(this.options.downloadsDir, { recursive: true });
    const destPath = path.join(this.options.downloadsDir, safeName);
    const partPath = `${destPath}.part`;

    const controller = new AbortController();
    this.downloadAbortController = controller;
    this.downloadCancelledByUser = false;

    const initialTotal = asset.size > 0 ? asset.size : null;
    this.setState({
      status: "downloading",
      downloadProgress: {
        downloadedBytes: 0,
        totalBytes: initialTotal,
        percent: initialTotal ? 0 : null,
      },
      downloadedFilePath: null,
      openedInstaller: false,
      error: null,
      errorCode: null,
    });

    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    let writeStream: fs.WriteStream | null = null;

    try {
      const res = await fetchFn(asset.downloadUrl, {
        method: "GET",
        headers: {
          "User-Agent": `Conductor/${this.options.currentVersion}`,
          Accept: "application/octet-stream",
        },
        redirect: "follow",
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Download failed with HTTP ${res.status}`);
      }

      if (res.url && !isAllowedDownloadUrl(res.url)) {
        throw new Error("Blocked redirected download URL outside GitHub.");
      }

      const contentLengthHeader = res.headers.get("content-length");
      const headerLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
      const totalBytes =
        Number.isFinite(headerLength) && headerLength > 0 ? headerLength : initialTotal;

      safeUnlink(partPath);
      writeStream = fs.createWriteStream(partPath);

      let downloadedBytes = 0;
      let lastEmitAt = 0;
      let lastPercent = -1;

      const emitProgress = (force = false) => {
        const now = Date.now();
        const percent =
          totalBytes && totalBytes > 0
            ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
            : null;
        if (
          !force &&
          now - lastEmitAt < this.options.progressThrottleMs &&
          percent === lastPercent
        ) {
          return;
        }
        lastEmitAt = now;
        lastPercent = percent ?? -1;
        this.setState({
          downloadProgress: {
            downloadedBytes,
            totalBytes,
            percent,
          },
        });
      };

      const writeChunk = async (chunk: Uint8Array): Promise<void> => {
        if (!writeStream) return;
        const ok = writeStream.write(chunk);
        if (!ok) {
          await new Promise<void>((resolve, reject) => {
            writeStream!.once("drain", resolve);
            writeStream!.once("error", reject);
          });
        }
      };

      if (res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await writeChunk(value);
            downloadedBytes += value.byteLength;
            emitProgress(false);
          }
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        await writeChunk(buf);
        downloadedBytes = buf.byteLength;
        emitProgress(true);
      }

      await new Promise<void>((resolve, reject) => {
        writeStream!.once("finish", resolve);
        writeStream!.once("error", reject);
        writeStream!.end();
      });
      writeStream = null;

      fs.renameSync(partPath, destPath);

      if (this.options.platform === "linux" && destPath.toLowerCase().endsWith(".appimage")) {
        try {
          fs.chmodSync(destPath, 0o755);
        } catch {
          // ignore chmod failure on unsupported filesystems
        }
      }

      // Open the downloaded installer (works for unsigned macOS .dmg/.zip, Windows .exe, Linux .AppImage/.deb)
      let openError = "";
      try {
        openError = (await this.options.openPath(destPath)) || "";
      } catch (err) {
        openError = toErrorMessage(err, "Failed to open downloaded installer.");
      }

      const finalTotal = totalBytes ?? downloadedBytes;
      return this.setState({
        status: "downloaded",
        downloadProgress: {
          downloadedBytes,
          totalBytes: finalTotal,
          percent: 100,
        },
        downloadedFilePath: destPath,
        openedInstaller: !openError,
        error: openError || null,
        errorCode: openError ? "open_failed" : null,
      });
    } catch (err) {
      if (writeStream) {
        try {
          writeStream.destroy();
        } catch {
          // ignore
        }
        writeStream = null;
      }
      safeUnlink(partPath);

      if (this.downloadCancelledByUser || isAbortError(err)) {
        return this.setState({
          status: this.state.updateAvailable ? "available" : "up_to_date",
          downloadProgress: null,
          error: null,
          errorCode: null,
        });
      }

      return this.setState({
        status: "error",
        downloadProgress: null,
        error: toErrorMessage(err, "Failed to download update."),
        errorCode: "download_failed",
      });
    } finally {
      if (this.downloadAbortController === controller) {
        this.downloadAbortController = null;
      }
      this.downloadCancelledByUser = false;
    }
  }

  cancelDownload(): AppUpdateState {
    if (this.downloadAbortController) {
      this.downloadCancelledByUser = true;
      this.downloadAbortController.abort();
    }
    return this.getState();
  }

  async openDownloaded(): Promise<{ ok: boolean; error?: string }> {
    const filePath = this.state.downloadedFilePath;
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: "Downloaded installer file was not found." };
    }
    try {
      const errMsg = (await this.options.openPath(filePath)) || "";
      if (errMsg) {
        this.setState({ openedInstaller: false, error: errMsg, errorCode: "open_failed" });
        return { ok: false, error: errMsg };
      }
      this.setState({ openedInstaller: true, error: null, errorCode: null });
      return { ok: true };
    } catch (err) {
      const msg = toErrorMessage(err, "Failed to open installer.");
      this.setState({ openedInstaller: false, error: msg, errorCode: "open_failed" });
      return { ok: false, error: msg };
    }
  }

  showDownloadedInFolder(): { ok: boolean; error?: string } {
    const filePath = this.state.downloadedFilePath;
    if (!filePath || !fs.existsSync(filePath)) {
      return { ok: false, error: "Downloaded installer file was not found." };
    }
    try {
      this.options.showItemInFolder(filePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: toErrorMessage(err, "Failed to reveal file in folder.") };
    }
  }

  async openReleasePage(url?: string): Promise<void> {
    const candidate =
      (typeof url === "string" && url.startsWith("https://github.com/") ? url : null) ??
      this.state.latestRelease?.htmlUrl ??
      this.options.fallbackReleasePageUrl;
    await this.options.openExternal(candidate);
  }

  dispose(): void {
    this.checkAbortController?.abort();
    this.checkAbortController = null;
    if (this.downloadAbortController) {
      this.downloadCancelledByUser = true;
      this.downloadAbortController.abort();
      this.downloadAbortController = null;
    }
  }
}
