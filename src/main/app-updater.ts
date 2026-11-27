import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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
import {
  EXPECTED_MAC_BUNDLE_ID,
  extractMacDmgArchive,
  extractMacZipArchive,
  findAppBundleInDirectory,
  generateMacUpdateApplyScript,
  launchDetachedMacUpdateScript,
  resolveMacTargetAppBundlePath,
  stripMacQuarantineAttribute,
  validateStagedMacAppBundle,
  type StagedMacAppValidationResult,
} from "./mac-self-updater.js";

export interface AppUpdaterOptions {
  currentVersion: string;
  currentTag?: string | null;
  currentCommitSha?: string | null;
  currentRunNumber?: number | null;
  isDevMode: boolean;
  isPackaged?: boolean;
  execPath?: string;
  targetAppPath?: string | null;
  platform?: string;
  arch?: string;
  apiUrl?: string;
  fallbackReleasePageUrl?: string;
  downloadsDir: string;
  stagingBaseDir?: string;
  expectedMacBundleId?: string | null;
  parentPid?: number;
  fetchImpl?: typeof fetch;
  openPath: (filePath: string) => Promise<string>;
  showItemInFolder: (filePath: string) => void;
  openExternal: (url: string) => Promise<void>;
  onStateChange?: (state: AppUpdateState) => void;
  requestTimeoutMs?: number;
  progressThrottleMs?: number;
  /**
   * Called when user clicks "Restart & Update Now" after staging completes.
   * Should coordinate with `QuitGuard` (prompting if worker tasks are running),
   * invoke `onConfirmed()` right before shutdown, and trigger clean app quit.
   * Returns `true` if restart proceeded or `false` if cancelled by the user.
   */
  requestRestartForUpdate?: (params: {
    versionTag: string;
    onConfirmed: () => void;
  }) => Promise<boolean>;
  // Testable macOS staging & apply hooks
  extractZipImpl?: (zipPath: string, extractDir: string, signal?: AbortSignal) => Promise<void>;
  extractDmgImpl?: (dmgPath: string, extractDir: string, signal?: AbortSignal) => Promise<void>;
  stripQuarantineImpl?: (targetPath: string) => Promise<void>;
  validateAppBundleImpl?: (appPath: string, expectedBundleId?: string | null) => StagedMacAppValidationResult;
  checkWritableDirImpl?: (dirPath: string) => boolean;
  launchUpdateScriptImpl?: (
    scriptPath: string,
    scriptContent: string,
  ) => { scriptPath: string; pid: number | undefined };
}

function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return base || "conductor-update";
}

function sanitizeDirToken(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "release";
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
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

function safeRmDir(dirPath: string | null | undefined): void {
  if (!dirPath) return;
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup failures
  }
}

function defaultCheckWritableDir(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export class AppUpdater {
  private readonly options: Required<
    Pick<
      AppUpdaterOptions,
      | "platform"
      | "arch"
      | "apiUrl"
      | "fallbackReleasePageUrl"
      | "downloadsDir"
      | "stagingBaseDir"
      | "requestTimeoutMs"
      | "progressThrottleMs"
      | "parentPid"
    >
  > &
    AppUpdaterOptions;

  private readonly targetAppPath: string | null;
  private readonly canSelfUpdate: boolean;
  private state: AppUpdateState;
  private activeCheckPromise: Promise<AppUpdateState> | null = null;
  private checkAbortController: AbortController | null = null;
  private downloadAbortController: AbortController | null = null;
  private downloadCancelledByUser = false;
  private stagedRootDir: string | null = null;
  private pendingApplyRelaunch: boolean | null = null;
  private helperLaunched = false;

  constructor(options: AppUpdaterOptions) {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const isPackaged = options.isPackaged ?? !options.isDevMode;
    const stagingBaseDir =
      options.stagingBaseDir ?? path.join(os.tmpdir(), "conductor-updater-staging");

    this.options = {
      ...options,
      platform,
      arch,
      isPackaged,
      apiUrl: options.apiUrl ?? GITHUB_RELEASES_API_URL,
      fallbackReleasePageUrl: options.fallbackReleasePageUrl ?? GITHUB_LATEST_RELEASE_PAGE_URL,
      stagingBaseDir,
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      progressThrottleMs: options.progressThrottleMs ?? 80,
      parentPid: options.parentPid ?? process.pid,
    };

    const resolvedTarget =
      options.targetAppPath !== undefined
        ? options.isDevMode || !isPackaged
          ? null
          : options.targetAppPath
        : resolveMacTargetAppBundlePath({
            platform,
            isPackaged: isPackaged && !options.isDevMode,
            execPath: options.execPath ?? process.execPath,
          });

    this.targetAppPath = platform === "darwin" && !options.isDevMode && isPackaged ? resolvedTarget : null;
    this.canSelfUpdate = Boolean(this.targetAppPath);

    this.state = createInitialAppUpdateState({
      currentVersion: this.options.currentVersion,
      currentTag: this.options.currentTag ?? null,
      currentCommitSha: this.options.currentCommitSha ?? null,
      currentRunNumber: this.options.currentRunNumber ?? null,
      isDevMode: this.options.isDevMode,
      platform: this.options.platform,
      arch: this.options.arch,
      canSelfUpdate: this.canSelfUpdate,
      targetAppPath: this.targetAppPath,
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

  private isMacStageableAsset(assetName: string): boolean {
    if (this.options.platform !== "darwin") return false;
    const lower = assetName.toLowerCase();
    return lower.endsWith(".zip") || lower.endsWith(".dmg");
  }

  async checkForUpdates(opts?: { silent?: boolean }): Promise<AppUpdateState> {
    const silent = Boolean(opts?.silent);
    if (
      this.state.status === "downloading" ||
      this.state.status === "staging" ||
      this.state.status === "installing"
    ) {
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

        const keepStaged =
          updateAvailable &&
          prevState.stagedAppPath &&
          prevState.stagedVersionTag === tagName &&
          fs.existsSync(prevState.stagedAppPath);

        const keepDownloaded =
          !keepStaged &&
          prevState.downloadedFilePath &&
          prevState.latestRelease?.tagName === tagName &&
          fs.existsSync(prevState.downloadedFilePath);

        if (!keepStaged && this.stagedRootDir) {
          safeRmDir(this.stagedRootDir);
          this.stagedRootDir = null;
        }

        return this.setState({
          status: keepStaged
            ? "ready_to_install"
            : keepDownloaded
              ? "downloaded"
              : updateAvailable
                ? "available"
                : "up_to_date",
          lastCheckedAt: new Date().toISOString(),
          latestRelease: releaseInfo,
          updateAvailable,
          downloadProgress: keepStaged || keepDownloaded ? prevState.downloadProgress : null,
          downloadedFilePath: keepDownloaded ? prevState.downloadedFilePath : null,
          openedInstaller: keepDownloaded ? prevState.openedInstaller : false,
          stagedAppPath: keepStaged ? prevState.stagedAppPath : null,
          stagedVersionTag: keepStaged ? prevState.stagedVersionTag : null,
          applyOnQuit: keepStaged ? prevState.applyOnQuit : false,
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

  /**
   * Downloads the selected release asset in the background.
   *
   * - On macOS with a `.zip` or `.dmg` asset, downloads to a temp staging directory,
   *   extracts and validates `Conductor.app` without blocking the running app, and
   *   transitions to `ready_to_install` so the user can restart & apply on demand
   *   (or apply automatically on normal quit).
   * - On Windows/Linux (or macOS `.pkg`), downloads to `downloadsDir` and opens the
   *   installer via `openPath`.
   */
  async downloadAndOpen(): Promise<AppUpdateState> {
    if (
      this.state.status === "downloading" ||
      this.state.status === "staging" ||
      this.state.status === "installing"
    ) {
      return this.getState();
    }

    const release = this.state.latestRelease;
    const asset = release?.selectedAsset;
    if (!release || !asset) {
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

    if (this.isMacStageableAsset(asset.name)) {
      return this.downloadAndStageMacUpdate(release.tagName, asset);
    }

    return this.downloadAndOpenExternalInstaller(asset);
  }

  private async streamDownloadToFile(
    downloadUrl: string,
    destPath: string,
    initialTotal: number | null,
    controller: AbortController,
  ): Promise<{ downloadedBytes: number; totalBytes: number }> {
    const partPath = `${destPath}.part`;
    const fetchFn = this.options.fetchImpl ?? globalThis.fetch;
    let writeStream: fs.WriteStream | null = null;

    try {
      const res = await fetchFn(downloadUrl, {
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
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
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
      return {
        downloadedBytes,
        totalBytes: totalBytes ?? downloadedBytes,
      };
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
      throw err;
    }
  }

  private async downloadAndStageMacUpdate(
    releaseTag: string,
    asset: NonNullable<AppUpdateState["latestRelease"]>["selectedAsset"] & {},
  ): Promise<AppUpdateState> {
    const safeName = sanitizeFileName(asset.name);
    const runToken = `${sanitizeDirToken(releaseTag)}-${crypto.randomBytes(4).toString("hex")}`;
    const newStagingRoot = path.join(this.options.stagingBaseDir, runToken);
    const archivePath = path.join(newStagingRoot, "archive", safeName);
    const extractDir = path.join(newStagingRoot, "extracted");

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

    let phase: "download" | "stage" = "download";

    try {
      const { downloadedBytes, totalBytes } = await this.streamDownloadToFile(
        asset.downloadUrl,
        archivePath,
        initialTotal,
        controller,
      );

      // Move to non-blocking background extraction & verification
      phase = "stage";
      this.setState({
        status: "staging",
        downloadProgress: {
          downloadedBytes,
          totalBytes,
          percent: 100,
        },
        error: null,
        errorCode: null,
      });

      const lowerName = safeName.toLowerCase();
      if (lowerName.endsWith(".zip")) {
        const extractZip = this.options.extractZipImpl ?? extractMacZipArchive;
        await extractZip(archivePath, extractDir, controller.signal);
      } else if (lowerName.endsWith(".dmg")) {
        const extractDmg = this.options.extractDmgImpl ?? extractMacDmgArchive;
        await extractDmg(archivePath, extractDir, controller.signal);
      } else {
        throw new Error(`Unsupported macOS archive format: ${safeName}`);
      }

      if (this.downloadCancelledByUser || controller.signal.aborted) {
        const abortErr = new Error("Update preparation cancelled.");
        abortErr.name = "AbortError";
        throw abortErr;
      }

      const foundAppPath = findAppBundleInDirectory(extractDir);
      if (!foundAppPath) {
        throw new Error("Could not locate Conductor.app inside the downloaded archive.");
      }

      const validate = this.options.validateAppBundleImpl ?? validateStagedMacAppBundle;
      const expectedBundleId =
        this.options.expectedMacBundleId === undefined
          ? EXPECTED_MAC_BUNDLE_ID
          : this.options.expectedMacBundleId;
      const validation = validate(foundAppPath, expectedBundleId);
      if (!validation.ok) {
        throw new Error(validation.error || "Staged Conductor.app failed verification.");
      }

      // Clear quarantine early in the background so swap at restart is instantaneous
      const stripQuarantine = this.options.stripQuarantineImpl ?? stripMacQuarantineAttribute;
      await stripQuarantine(foundAppPath);

      // Remove archive file after successful extraction to save disk space
      safeRmDir(path.dirname(archivePath));

      // Clean up any previous staged directory now that the new one is verified
      if (this.stagedRootDir && this.stagedRootDir !== newStagingRoot) {
        safeRmDir(this.stagedRootDir);
      }
      this.stagedRootDir = newStagingRoot;

      return this.setState({
        status: "ready_to_install",
        downloadProgress: {
          downloadedBytes,
          totalBytes,
          percent: 100,
        },
        stagedAppPath: foundAppPath,
        stagedVersionTag: releaseTag,
        applyOnQuit: this.canSelfUpdate && !this.options.isDevMode,
        downloadedFilePath: null,
        openedInstaller: false,
        error: null,
        errorCode: null,
      });
    } catch (err) {
      safeRmDir(newStagingRoot);

      if (this.downloadCancelledByUser || isAbortError(err)) {
        return this.setState({
          status: this.state.stagedAppPath && fs.existsSync(this.state.stagedAppPath)
            ? "ready_to_install"
            : this.state.updateAvailable
              ? "available"
              : "up_to_date",
          downloadProgress: null,
          error: null,
          errorCode: null,
        });
      }

      return this.setState({
        status: "error",
        downloadProgress: null,
        error: toErrorMessage(
          err,
          phase === "stage"
            ? "Failed to extract or verify the update package."
            : "Failed to download update.",
        ),
        errorCode: phase === "stage" ? "staging_failed" : "download_failed",
      });
    } finally {
      if (this.downloadAbortController === controller) {
        this.downloadAbortController = null;
      }
      this.downloadCancelledByUser = false;
    }
  }

  private async downloadAndOpenExternalInstaller(
    asset: NonNullable<AppUpdateState["latestRelease"]>["selectedAsset"] & {},
  ): Promise<AppUpdateState> {
    const safeName = sanitizeFileName(asset.name);
    fs.mkdirSync(this.options.downloadsDir, { recursive: true });
    const destPath = path.join(this.options.downloadsDir, safeName);

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

    try {
      const { downloadedBytes, totalBytes } = await this.streamDownloadToFile(
        asset.downloadUrl,
        destPath,
        initialTotal,
        controller,
      );

      if (this.options.platform === "linux" && destPath.toLowerCase().endsWith(".appimage")) {
        try {
          fs.chmodSync(destPath, 0o755);
        } catch {
          // ignore chmod failure on unsupported filesystems
        }
      }

      let openError = "";
      try {
        openError = (await this.options.openPath(destPath)) || "";
      } catch (err) {
        openError = toErrorMessage(err, "Failed to open downloaded installer.");
      }

      return this.setState({
        status: "downloaded",
        downloadProgress: {
          downloadedBytes,
          totalBytes,
          percent: 100,
        },
        downloadedFilePath: destPath,
        openedInstaller: !openError,
        error: openError || null,
        errorCode: openError ? "open_failed" : null,
      });
    } catch (err) {
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

  /**
   * Toggles whether a staged macOS update should be automatically applied on normal app quit.
   * Always remains `false` in development mode or when self-update is unavailable.
   */
  setApplyOnQuit(enabled: boolean): AppUpdateState {
    const allowed = this.canSelfUpdate && !this.options.isDevMode;
    return this.setState({
      applyOnQuit: allowed ? Boolean(enabled) : false,
    });
  }

  /**
   * One-click "Restart & Update Now" for a staged macOS `.app` update.
   * Guards strictly against dev mode, verifies write permissions, prompts if tasks
   * are running via `requestRestartForUpdate`, and only arms the swap helper after
   * shutdown is confirmed.
   */
  async installAndRestart(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
    if (this.options.isDevMode || !this.canSelfUpdate || !this.targetAppPath) {
      const msg =
        "Automatic in-app replacement is disabled in development mode (only packaged Conductor.app builds can self-update).";
      this.setState({
        error: msg,
        errorCode: "dev_mode_blocked",
      });
      return { ok: false, error: msg };
    }

    if (
      this.state.status !== "ready_to_install" ||
      !this.state.stagedAppPath ||
      !fs.existsSync(this.state.stagedAppPath)
    ) {
      const msg = "No verified staged update is ready to install.";
      this.setState({
        status: "error",
        error: msg,
        errorCode: "install_failed",
      });
      return { ok: false, error: msg };
    }

    const targetDir = path.dirname(this.targetAppPath);
    const checkWritable = this.options.checkWritableDirImpl ?? defaultCheckWritableDir;
    if (!checkWritable(targetDir)) {
      const msg = `Cannot write to ${targetDir}. Move Conductor.app to a writable Applications folder or update manually.`;
      this.setState({
        error: msg,
        errorCode: "install_failed",
      });
      return { ok: false, error: msg };
    }

    const versionTag =
      this.state.stagedVersionTag ?? this.state.latestRelease?.tagName ?? "latest";

    const armForRelaunch = () => {
      this.pendingApplyRelaunch = true;
      this.setState({
        status: "installing",
        error: null,
        errorCode: null,
      });
    };

    if (this.options.requestRestartForUpdate) {
      const proceeded = await this.options.requestRestartForUpdate({
        versionTag,
        onConfirmed: armForRelaunch,
      });
      if (!proceeded) {
        return { ok: false, cancelled: true };
      }
      return { ok: true };
    }

    // Direct mode (primarily used in unit tests without Electron QuitGuard)
    armForRelaunch();
    const launched = this.launchPendingApplyHelperOnShutdown();
    if (!launched.ok) {
      this.pendingApplyRelaunch = null;
      this.setState({
        status: "ready_to_install",
        error: launched.error ?? "Failed to launch update helper.",
        errorCode: "install_failed",
      });
      return { ok: false, error: launched.error };
    }
    return { ok: true };
  }

  /**
   * Returns whether a staged macOS update should be applied during the current shutdown.
   */
  shouldApplyOnShutdown(): boolean {
    if (this.options.isDevMode || !this.canSelfUpdate || !this.targetAppPath) {
      return false;
    }
    if (!this.state.stagedAppPath || !fs.existsSync(this.state.stagedAppPath)) {
      return false;
    }
    if (this.pendingApplyRelaunch === true) {
      return true;
    }
    return this.state.status === "ready_to_install" && this.state.applyOnQuit;
  }

  /**
   * Invoked from the confirmed shutdown path right before `app.quit()`.
   * Spawns the independent detached shell helper so `.app` replacement runs safely
   * immediately after the Electron process exits.
   */
  launchPendingApplyHelperOnShutdown(): {
    launched: boolean;
    ok: boolean;
    relaunch?: boolean;
    scriptPath?: string;
    error?: string;
  } {
    if (this.helperLaunched) {
      return { launched: true, ok: true };
    }
    if (!this.shouldApplyOnShutdown()) {
      return { launched: false, ok: true };
    }
    if (!this.targetAppPath || !this.state.stagedAppPath || !this.stagedRootDir) {
      return { launched: false, ok: false, error: "Missing staged update paths." };
    }

    const relaunch = this.pendingApplyRelaunch === true;
    const scriptPath = path.join(this.stagedRootDir, "apply-update.sh");
    const logPath = path.join(this.options.stagingBaseDir, "last-update.log");

    try {
      const scriptContent = generateMacUpdateApplyScript({
        parentPid: this.options.parentPid,
        stagedAppPath: this.state.stagedAppPath,
        targetAppPath: this.targetAppPath,
        stagingRootDir: this.stagedRootDir,
        relaunch,
        logPath,
      });
      const launch = this.options.launchUpdateScriptImpl ?? launchDetachedMacUpdateScript;
      launch(scriptPath, scriptContent);
      this.helperLaunched = true;
      return {
        launched: true,
        ok: true,
        relaunch,
        scriptPath,
      };
    } catch (err) {
      return {
        launched: false,
        ok: false,
        error: toErrorMessage(err, "Failed to launch macOS update script."),
      };
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
    // Preserve staging directory if the detached apply helper was spawned to swap it on exit
    if (!this.helperLaunched && this.stagedRootDir) {
      safeRmDir(this.stagedRootDir);
      this.stagedRootDir = null;
    }
  }
}
