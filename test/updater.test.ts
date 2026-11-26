import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppUpdater } from "../src/main/app-updater.js";
import {
  compareReleaseVersions,
  extractReleaseNotesExcerpt,
  formatBytes,
  formatPlatformArchLabel,
  isAllowedDownloadUrl,
  isUpdateAvailable,
  parseReleaseTag,
  selectReleaseAssetForPlatform,
  type AppUpdateState,
  type GitHubReleaseAssetDto,
  type GitHubReleaseDto,
} from "../src/shared/updater.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const FULL_RELEASE_ASSETS: GitHubReleaseAssetDto[] = [
  {
    name: "Conductor-0.1.0-mac-arm64.dmg",
    browser_download_url:
      "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-mac-arm64.dmg",
    size: 98_000_000,
    content_type: "application/x-apple-diskimage",
  },
  {
    name: "Conductor-0.1.0-mac-arm64.zip",
    browser_download_url:
      "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-mac-arm64.zip",
    size: 95_000_000,
    content_type: "application/zip",
  },
  {
    name: "Conductor-0.1.0-mac-x64.dmg",
    browser_download_url:
      "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-mac-x64.dmg",
    size: 101_000_000,
    content_type: "application/x-apple-diskimage",
  },
  {
    name: "Conductor-0.1.0-mac-x64.zip",
    browser_download_url:
      "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-mac-x64.zip",
    size: 97_000_000,
    content_type: "application/zip",
  },
  {
    name: "Conductor-0.1.0-win-x64-setup.exe",
    browser_download_url:
      "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-win-x64-setup.exe",
    size: 88_000_000,
    content_type: "application/vnd.microsoft.portable-executable",
  },
  {
    name: "Conductor-0.1.0-win-x64-portable.exe",
    browser_download_url:
      "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-win-x64-portable.exe",
    size: 86_000_000,
    content_type: "application/vnd.microsoft.portable-executable",
  },
  {
    name: "Conductor-0.1.0-linux-x64.AppImage",
    browser_download_url:
      "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-linux-x64.AppImage",
    size: 105_000_000,
    content_type: "application/octet-stream",
  },
  {
    name: "Conductor-0.1.0-linux-x64.deb",
    browser_download_url:
      "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-linux-x64.deb",
    size: 74_000_000,
    content_type: "application/vnd.debian.binary-package",
  },
  {
    name: "Conductor-0.1.0-android.apk",
    browser_download_url:
      "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/Conductor-0.1.0-android.apk",
    size: 12_000_000,
    content_type: "application/vnd.android.package-archive",
  },
  {
    name: "SHA256SUMS.txt",
    browser_download_url:
      "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0-42-1a351f7/SHA256SUMS.txt",
    size: 1024,
    content_type: "text/plain",
  },
];

describe("Version & GitHub Release tag parsing and comparison", () => {
  it("parses CI release tags from .github/workflows/release.yml and standard SemVer tags", () => {
    expect(parseReleaseTag("v0.1.0-42-1a351f7")).toEqual({
      raw: "v0.1.0-42-1a351f7",
      major: 0,
      minor: 1,
      patch: 0,
      semver: "0.1.0",
      runNumber: 42,
      commitSha: "1a351f7",
      prerelease: null,
    });

    expect(parseReleaseTag("v1.2.3")).toEqual({
      raw: "v1.2.3",
      major: 1,
      minor: 2,
      patch: 3,
      semver: "1.2.3",
      runNumber: null,
      commitSha: null,
      prerelease: null,
    });

    expect(parseReleaseTag("0.2.0-beta.2")).toEqual({
      raw: "0.2.0-beta.2",
      major: 0,
      minor: 2,
      patch: 0,
      semver: "0.2.0",
      runNumber: null,
      commitSha: null,
      prerelease: "beta.2",
    });

    expect(parseReleaseTag("not-a-version")).toBeNull();
    expect(parseReleaseTag("")).toBeNull();
  });

  it("compares SemVer major/minor/patch and prereleases accurately", () => {
    expect(compareReleaseVersions({ version: "0.1.0" }, "v0.2.0")).toBe(1);
    expect(compareReleaseVersions({ version: "0.1.0" }, "v0.1.1")).toBe(1);
    expect(compareReleaseVersions({ version: "0.1.0" }, "v1.0.0")).toBe(1);
    expect(compareReleaseVersions({ version: "0.2.0" }, "v0.2.0")).toBe(0);
    expect(compareReleaseVersions({ version: "0.2.0" }, "v0.1.9")).toBe(-1);

    // Prerelease ordering
    expect(compareReleaseVersions({ version: "0.2.0-beta.1" }, "v0.2.0")).toBe(1);
    expect(compareReleaseVersions({ version: "0.2.0-beta.1" }, "v0.2.0-beta.2")).toBe(1);
    expect(compareReleaseVersions({ version: "0.2.0" }, "v0.2.0-rc.1")).toBe(-1);
  });

  it("compares CI build tags (v<ver>-<run>-<sha>) by semver, run number, and commit SHA", () => {
    // Higher run number on same version -> update available
    expect(
      isUpdateAvailable(
        { version: "0.1.0", tag: "v0.1.0-41-aaaaaaa", runNumber: 41, commitSha: "aaaaaaa" },
        "v0.1.0-42-bbbbbbb",
      ),
    ).toBe(true);

    // Exact same tag -> up to date
    expect(
      isUpdateAvailable(
        { version: "0.1.0", tag: "v0.1.0-42-1a351f7", runNumber: 42, commitSha: "1a351f7" },
        "v0.1.0-42-1a351f7",
      ),
    ).toBe(false);

    // Older release than current run number -> up to date
    expect(
      compareReleaseVersions(
        { version: "0.1.0", tag: "v0.1.0-45-ccccccc", runNumber: 45, commitSha: "ccccccc" },
        "v0.1.0-42-1a351f7",
      ),
    ).toBe(-1);

    // Local/dev build at the exact release commit SHA (without runNumber) -> up to date
    expect(
      compareReleaseVersions(
        { version: "0.1.0", commitSha: "1a351f7" },
        "v0.1.0-42-1a351f7",
      ),
    ).toBe(0);

    // Older unnumbered 0.1.0 build (before build metadata) vs CI release -> update available
    expect(
      isUpdateAvailable({ version: "0.1.0" }, "v0.1.0-42-1a351f7"),
    ).toBe(true);

    // Higher semver overrides run number
    expect(
      isUpdateAvailable(
        { version: "0.2.0", tag: "v0.2.0-1-abcdef0" },
        "v0.1.0-999-1a351f7",
      ),
    ).toBe(false);
    expect(
      isUpdateAvailable(
        { version: "0.1.0", tag: "v0.1.0-999-1a351f7" },
        "v0.2.0-1-abcdef0",
      ),
    ).toBe(true);
  });
});

describe("OS & Architecture release asset selection", () => {
  it("selects macOS arm64 .dmg first and falls back to .zip or universal", () => {
    const picked = selectReleaseAssetForPlatform(FULL_RELEASE_ASSETS, "darwin", "arm64");
    expect(picked?.name).toBe("Conductor-0.1.0-mac-arm64.dmg");

    const withoutDmg = FULL_RELEASE_ASSETS.filter((a) => !a.name.endsWith(".dmg"));
    const zipFallback = selectReleaseAssetForPlatform(withoutDmg, "darwin", "arm64");
    expect(zipFallback?.name).toBe("Conductor-0.1.0-mac-arm64.zip");

    const universalOnly: GitHubReleaseAssetDto[] = [
      {
        name: "Conductor-0.1.0-mac-universal.dmg",
        browser_download_url:
          "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0/Conductor-0.1.0-mac-universal.dmg",
        size: 150_000_000,
      },
      {
        name: "Conductor-0.1.0-mac-x64.dmg",
        browser_download_url:
          "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0/Conductor-0.1.0-mac-x64.dmg",
        size: 100_000_000,
      },
    ];
    expect(selectReleaseAssetForPlatform(universalOnly, "darwin", "arm64")?.name).toBe(
      "Conductor-0.1.0-mac-universal.dmg",
    );

    // Never pick explicit x64 dmg for arm64 mac
    const x64Only = FULL_RELEASE_ASSETS.filter((a) => a.name.includes("mac-x64"));
    expect(selectReleaseAssetForPlatform(x64Only, "darwin", "arm64")).toBeNull();
  });

  it("selects macOS x64 .dmg first and falls back to .zip", () => {
    const picked = selectReleaseAssetForPlatform(FULL_RELEASE_ASSETS, "darwin", "x64");
    expect(picked?.name).toBe("Conductor-0.1.0-mac-x64.dmg");

    const withoutDmg = FULL_RELEASE_ASSETS.filter((a) => !a.name.endsWith(".dmg"));
    expect(selectReleaseAssetForPlatform(withoutDmg, "darwin", "x64")?.name).toBe(
      "Conductor-0.1.0-mac-x64.zip",
    );
  });

  it("selects Windows setup .exe first and falls back to portable .exe, supporting win arm64 emulation", () => {
    const winX64 = selectReleaseAssetForPlatform(FULL_RELEASE_ASSETS, "win32", "x64");
    expect(winX64?.name).toBe("Conductor-0.1.0-win-x64-setup.exe");

    const portableOnly = FULL_RELEASE_ASSETS.filter((a) => !a.name.includes("setup.exe"));
    expect(selectReleaseAssetForPlatform(portableOnly, "win32", "x64")?.name).toBe(
      "Conductor-0.1.0-win-x64-portable.exe",
    );

    // Windows on ARM falls back to x64 setup.exe when no arm64 build is published
    expect(selectReleaseAssetForPlatform(FULL_RELEASE_ASSETS, "win32", "arm64")?.name).toBe(
      "Conductor-0.1.0-win-x64-setup.exe",
    );
  });

  it("selects Linux .AppImage first and falls back to .deb (including amd64 naming)", () => {
    const linuxX64 = selectReleaseAssetForPlatform(FULL_RELEASE_ASSETS, "linux", "x64");
    expect(linuxX64?.name).toBe("Conductor-0.1.0-linux-x64.AppImage");

    const debOnly = FULL_RELEASE_ASSETS.filter((a) => !a.name.endsWith(".AppImage"));
    expect(selectReleaseAssetForPlatform(debOnly, "linux", "x64")?.name).toBe(
      "Conductor-0.1.0-linux-x64.deb",
    );

    const amd64Deb: GitHubReleaseAssetDto[] = [
      {
        name: "Conductor-0.1.0-linux-amd64.deb",
        browser_download_url:
          "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0/Conductor-0.1.0-linux-amd64.deb",
        size: 70_000_000,
      },
    ];
    expect(selectReleaseAssetForPlatform(amd64Deb, "linux", "x64")?.name).toBe(
      "Conductor-0.1.0-linux-amd64.deb",
    );
  });

  it("ignores non-desktop/checksum/untrusted URLs", () => {
    const badAssets: GitHubReleaseAssetDto[] = [
      {
        name: "Conductor-0.1.0-android.apk",
        browser_download_url:
          "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0/Conductor-0.1.0-android.apk",
      },
      {
        name: "SHA256SUMS.txt",
        browser_download_url:
          "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0/SHA256SUMS.txt",
      },
      {
        name: "Conductor-0.1.0-mac-arm64.dmg.blockmap",
        browser_download_url:
          "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0/Conductor-0.1.0-mac-arm64.dmg.blockmap",
      },
      {
        name: "Conductor-0.1.0-mac-arm64.dmg",
        browser_download_url: "https://evil.example.com/Conductor-0.1.0-mac-arm64.dmg",
      },
    ];
    expect(selectReleaseAssetForPlatform(badAssets, "darwin", "arm64")).toBeNull();
    expect(isAllowedDownloadUrl("https://github.com/goto-t-yuta/conductor/releases/download/v1/a.dmg")).toBe(true);
    expect(isAllowedDownloadUrl("https://objects.githubusercontent.com/file.dmg")).toBe(true);
    expect(isAllowedDownloadUrl("http://github.com/insecure.dmg")).toBe(false);
    expect(isAllowedDownloadUrl("https://evil.example.com/file.dmg")).toBe(false);
  });

  it("formats release notes excerpts, byte sizes, and platform labels cleanly", () => {
    const rawBody = [
      "<!-- hidden comment -->",
      "## What's Changed",
      "- Added auto-updater by [@alice](https://github.com/alice)",
      "- Fixed terminal resize bug",
      "",
      "**Full Changelog**: https://github.com/goto-t-yuta/conductor/compare/v0.1.0...v0.2.0",
    ].join("\n");

    const excerpt = extractReleaseNotesExcerpt(rawBody, 200);
    expect(excerpt).toContain("## What's Changed");
    expect(excerpt).toContain("@alice");
    expect(excerpt).not.toContain("hidden comment");
    expect(excerpt).not.toContain("Full Changelog");

    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
    expect(formatPlatformArchLabel("darwin", "arm64")).toBe("macOS (arm64)");
    expect(formatPlatformArchLabel("win32", "x64")).toBe("Windows (x64)");
    expect(formatPlatformArchLabel("linux", "x64")).toBe("Linux (x64)");
  });
});

describe("AppUpdater main-process service", () => {
  const sampleReleaseDto: GitHubReleaseDto = {
    tag_name: "v0.1.0-42-1a351f7",
    name: "Conductor v0.1.0-42-1a351f7",
    body: "## Changes\n- Added GitHub Releases updater",
    html_url: "https://github.com/goto-t-yuta/conductor/releases/tag/v0.1.0-42-1a351f7",
    published_at: "2026-11-26T00:00:00Z",
    assets: FULL_RELEASE_ASSETS,
  };

  it("silently falls back on network failure during startup check, and reports error on manual check", async () => {
    const downloadsDir = makeTempDir("conductor-upd-err-");
    const states: AppUpdateState[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("ENOTFOUND api.github.com"));

    const updater = new AppUpdater({
      currentVersion: "0.1.0",
      currentTag: "v0.1.0-41-aaaaaaa",
      currentRunNumber: 41,
      currentCommitSha: "aaaaaaa",
      isDevMode: false,
      platform: "darwin",
      arch: "arm64",
      downloadsDir,
      fetchImpl: fetchMock,
      openPath: vi.fn().mockResolvedValue(""),
      showItemInFolder: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
      onStateChange: (s) => states.push(s),
    });

    // Silent startup check should NOT emit an error state
    const silentRes = await updater.checkForUpdates({ silent: true });
    expect(silentRes.status).toBe("idle");
    expect(silentRes.error).toBeNull();
    expect(states).toHaveLength(0);

    // Manual check reports network error
    const manualRes = await updater.checkForUpdates({ silent: false });
    expect(manualRes.status).toBe("error");
    expect(manualRes.errorCode).toBe("network");
    expect(manualRes.error).toContain("ENOTFOUND");
  });

  it("detects available update, downloads installer with progress, opens it, and supports folder/release fallbacks", async () => {
    const downloadsDir = makeTempDir("conductor-upd-dl-");
    const states: AppUpdateState[] = [];
    const openPath = vi.fn().mockResolvedValue("");
    const showItemInFolder = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);

    const chunk1 = new Uint8Array(64).fill(65);
    const chunk2 = new Uint8Array(64).fill(66);

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify(sampleReleaseDto), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk1);
          controller.enqueue(chunk2);
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-length": String(chunk1.byteLength + chunk2.byteLength) },
      });
    });

    const updater = new AppUpdater({
      currentVersion: "0.1.0",
      currentTag: "v0.1.0-41-aaaaaaa",
      currentRunNumber: 41,
      currentCommitSha: "aaaaaaa",
      isDevMode: false,
      platform: "darwin",
      arch: "arm64",
      downloadsDir,
      fetchImpl: fetchMock,
      openPath,
      showItemInFolder,
      openExternal,
      onStateChange: (s) => states.push(s),
      progressThrottleMs: 0,
    });

    const checked = await updater.checkForUpdates({ silent: false });
    expect(checked.status).toBe("available");
    expect(checked.updateAvailable).toBe(true);
    expect(checked.latestRelease?.tagName).toBe("v0.1.0-42-1a351f7");
    expect(checked.latestRelease?.selectedAsset?.name).toBe("Conductor-0.1.0-mac-arm64.dmg");

    const downloaded = await updater.downloadAndOpen();
    expect(downloaded.status).toBe("downloaded");
    expect(downloaded.openedInstaller).toBe(true);
    expect(downloaded.downloadProgress?.percent).toBe(100);
    expect(downloaded.downloadedFilePath).toBe(
      path.join(downloadsDir, "Conductor-0.1.0-mac-arm64.dmg"),
    );

    // File exists atomically without leftover .part
    expect(fs.existsSync(downloaded.downloadedFilePath!)).toBe(true);
    expect(fs.existsSync(`${downloaded.downloadedFilePath!}.part`)).toBe(false);
    expect(fs.statSync(downloaded.downloadedFilePath!).size).toBe(128);
    expect(openPath).toHaveBeenCalledWith(downloaded.downloadedFilePath);

    // Show in folder and open release page
    expect(updater.showDownloadedInFolder()).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(downloaded.downloadedFilePath);

    await updater.openReleasePage();
    expect(openExternal).toHaveBeenCalledWith(sampleReleaseDto.html_url);

    // Emitted downloading progress states
    expect(states.some((s) => s.status === "downloading")).toBe(true);
  });

  it("handles openPath failure gracefully while preserving downloaded file for manual reveal", async () => {
    const downloadsDir = makeTempDir("conductor-upd-openfail-");
    const openPath = vi.fn().mockResolvedValue("Gatekeeper blocked opening");
    const showItemInFolder = vi.fn();

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify(sampleReleaseDto), { status: 200 });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-length": "4" },
      });
    });

    const updater = new AppUpdater({
      currentVersion: "0.1.0",
      isDevMode: false,
      platform: "darwin",
      arch: "arm64",
      downloadsDir,
      fetchImpl: fetchMock,
      openPath,
      showItemInFolder,
      openExternal: vi.fn().mockResolvedValue(undefined),
    });

    await updater.checkForUpdates({ silent: false });
    const res = await updater.downloadAndOpen();
    expect(res.status).toBe("downloaded");
    expect(res.openedInstaller).toBe(false);
    expect(res.errorCode).toBe("open_failed");
    expect(res.downloadedFilePath).toBeTruthy();
    expect(updater.showDownloadedInFolder()).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(res.downloadedFilePath);
  });

  it("marks up_to_date when running the exact same release tag or commit SHA", async () => {
    const downloadsDir = makeTempDir("conductor-upd-same-");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(sampleReleaseDto), { status: 200 }),
    );

    const updater = new AppUpdater({
      currentVersion: "0.1.0",
      currentTag: "v0.1.0-42-1a351f7",
      currentRunNumber: 42,
      currentCommitSha: "1a351f7",
      isDevMode: false,
      platform: "darwin",
      arch: "arm64",
      downloadsDir,
      fetchImpl: fetchMock,
      openPath: vi.fn().mockResolvedValue(""),
      showItemInFolder: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
    });

    const res = await updater.checkForUpdates({ silent: false });
    expect(res.status).toBe("up_to_date");
    expect(res.updateAvailable).toBe(false);
  });
});
