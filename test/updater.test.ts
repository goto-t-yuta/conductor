import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
import { AppUpdater } from "../src/main/app-updater.js";
import {
  findAppBundleInDirectory,
  generateMacUpdateApplyScript,
  resolveMacTargetAppBundlePath,
  shellQuote,
  validateStagedMacAppBundle,
} from "../src/main/mac-self-updater.js";
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

function createFakeMacAppBundle(
  parentDir: string,
  options?: {
    appName?: string;
    bundleId?: string;
    executableName?: string;
    versionMarker?: string;
    omitInfoPlist?: boolean;
    omitExecutable?: boolean;
    omitAsar?: boolean;
  },
): string {
  const appName = options?.appName ?? "Conductor.app";
  const bundleId = options?.bundleId ?? "com.conductor.app";
  const executableName = options?.executableName ?? "Conductor";
  const appPath = path.join(parentDir, appName);
  const contentsDir = path.join(appPath, "Contents");
  const macOsDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");

  fs.mkdirSync(macOsDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });

  if (!options?.omitInfoPlist) {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "<dict>",
      `  <key>CFBundleIdentifier</key><string>${bundleId}</string>`,
      `  <key>CFBundleExecutable</key><string>${executableName}</string>`,
      `  <key>CFBundleShortVersionString</key><string>${options?.versionMarker ?? "0.2.0"}</string>`,
      "</dict>",
      "</plist>",
    ].join("\n");
    fs.writeFileSync(path.join(contentsDir, "Info.plist"), plist, "utf8");
  }

  if (!options?.omitExecutable) {
    const execPath = path.join(macOsDir, executableName);
    fs.writeFileSync(execPath, `#!/bin/sh\necho "${options?.versionMarker ?? "0.2.0"}"\n`, "utf8");
    fs.chmodSync(execPath, 0o755);
  }

  if (!options?.omitAsar) {
    fs.writeFileSync(
      path.join(resourcesDir, "app.asar"),
      `fake-asar-${options?.versionMarker ?? "0.2.0"}`,
      "utf8",
    );
  }

  return appPath;
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
    expect(
      isUpdateAvailable(
        { version: "0.1.0", tag: "v0.1.0-41-aaaaaaa", runNumber: 41, commitSha: "aaaaaaa" },
        "v0.1.0-42-bbbbbbb",
      ),
    ).toBe(true);

    expect(
      isUpdateAvailable(
        { version: "0.1.0", tag: "v0.1.0-42-1a351f7", runNumber: 42, commitSha: "1a351f7" },
        "v0.1.0-42-1a351f7",
      ),
    ).toBe(false);

    expect(
      compareReleaseVersions(
        { version: "0.1.0", tag: "v0.1.0-45-ccccccc", runNumber: 45, commitSha: "ccccccc" },
        "v0.1.0-42-1a351f7",
      ),
    ).toBe(-1);

    expect(
      compareReleaseVersions(
        { version: "0.1.0", commitSha: "1a351f7" },
        "v0.1.0-42-1a351f7",
      ),
    ).toBe(0);

    expect(isUpdateAvailable({ version: "0.1.0" }, "v0.1.0-42-1a351f7")).toBe(true);

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
  it("selects macOS arm64 .zip first for silent background staging and falls back to .dmg or universal", () => {
    const picked = selectReleaseAssetForPlatform(FULL_RELEASE_ASSETS, "darwin", "arm64");
    expect(picked?.name).toBe("Conductor-0.1.0-mac-arm64.zip");

    const withoutZip = FULL_RELEASE_ASSETS.filter((a) => !a.name.endsWith(".zip"));
    const dmgFallback = selectReleaseAssetForPlatform(withoutZip, "darwin", "arm64");
    expect(dmgFallback?.name).toBe("Conductor-0.1.0-mac-arm64.dmg");

    const universalOnly: GitHubReleaseAssetDto[] = [
      {
        name: "Conductor-0.1.0-mac-universal.zip",
        browser_download_url:
          "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0/Conductor-0.1.0-mac-universal.zip",
        size: 150_000_000,
      },
      {
        name: "Conductor-0.1.0-mac-x64.zip",
        browser_download_url:
          "https://github.com/goto-t-yuta/conductor/releases/download/v0.1.0/Conductor-0.1.0-mac-x64.zip",
        size: 100_000_000,
      },
    ];
    expect(selectReleaseAssetForPlatform(universalOnly, "darwin", "arm64")?.name).toBe(
      "Conductor-0.1.0-mac-universal.zip",
    );

    // Never pick explicit x64 asset for arm64 mac
    const x64Only = FULL_RELEASE_ASSETS.filter((a) => a.name.includes("mac-x64"));
    expect(selectReleaseAssetForPlatform(x64Only, "darwin", "arm64")).toBeNull();
  });

  it("selects macOS x64 .zip first and falls back to .dmg", () => {
    const picked = selectReleaseAssetForPlatform(FULL_RELEASE_ASSETS, "darwin", "x64");
    expect(picked?.name).toBe("Conductor-0.1.0-mac-x64.zip");

    const withoutZip = FULL_RELEASE_ASSETS.filter((a) => !a.name.endsWith(".zip"));
    expect(selectReleaseAssetForPlatform(withoutZip, "darwin", "x64")?.name).toBe(
      "Conductor-0.1.0-mac-x64.dmg",
    );
  });

  it("selects Windows setup .exe first and falls back to portable .exe, supporting win arm64 emulation", () => {
    const winX64 = selectReleaseAssetForPlatform(FULL_RELEASE_ASSETS, "win32", "x64");
    expect(winX64?.name).toBe("Conductor-0.1.0-win-x64-setup.exe");

    const portableOnly = FULL_RELEASE_ASSETS.filter((a) => !a.name.includes("setup.exe"));
    expect(selectReleaseAssetForPlatform(portableOnly, "win32", "x64")?.name).toBe(
      "Conductor-0.1.0-win-x64-portable.exe",
    );

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
        name: "Conductor-0.1.0-mac-arm64.zip",
        browser_download_url: "https://evil.example.com/Conductor-0.1.0-mac-arm64.zip",
      },
    ];
    expect(selectReleaseAssetForPlatform(badAssets, "darwin", "arm64")).toBeNull();
    expect(isAllowedDownloadUrl("https://github.com/goto-t-yuta/conductor/releases/download/v1/a.zip")).toBe(true);
    expect(isAllowedDownloadUrl("https://objects.githubusercontent.com/file.zip")).toBe(true);
    expect(isAllowedDownloadUrl("http://github.com/insecure.zip")).toBe(false);
    expect(isAllowedDownloadUrl("https://evil.example.com/file.zip")).toBe(false);
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

describe("macOS self-update target resolution, bundle validation & apply script", () => {
  it("resolves target .app bundle safely and strictly blocks dev mode / Electron.app / node_modules", () => {
    expect(
      resolveMacTargetAppBundlePath({
        platform: "darwin",
        isPackaged: true,
        execPath: "/Applications/Conductor.app/Contents/MacOS/Conductor",
      }),
    ).toBe("/Applications/Conductor.app");

    expect(
      resolveMacTargetAppBundlePath({
        platform: "darwin",
        isPackaged: true,
        execPath: "/Users/alice/Applications/Conductor.app/Contents/MacOS/Conductor",
      }),
    ).toBe("/Users/alice/Applications/Conductor.app");

    // Mounted DMG or AppTranslocation redirects to /Applications/Conductor.app
    expect(
      resolveMacTargetAppBundlePath({
        platform: "darwin",
        isPackaged: true,
        execPath: "/Volumes/Conductor 0.1.0/Conductor.app/Contents/MacOS/Conductor",
      }),
    ).toBe("/Applications/Conductor.app");

    expect(
      resolveMacTargetAppBundlePath({
        platform: "darwin",
        isPackaged: true,
        execPath:
          "/private/var/folders/xx/yy/T/AppTranslocation/1234/d/Conductor.app/Contents/MacOS/Conductor",
      }),
    ).toBe("/Applications/Conductor.app");

    // Dev mode (!isPackaged) MUST return null
    expect(
      resolveMacTargetAppBundlePath({
        platform: "darwin",
        isPackaged: false,
        execPath: "/Applications/Conductor.app/Contents/MacOS/Conductor",
      }),
    ).toBeNull();

    // Electron.app or node_modules MUST return null even if isPackaged were true
    expect(
      resolveMacTargetAppBundlePath({
        platform: "darwin",
        isPackaged: true,
        execPath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      }),
    ).toBeNull();

    // Non-macOS returns null
    expect(
      resolveMacTargetAppBundlePath({
        platform: "win32",
        isPackaged: true,
        execPath: "C:\\Program Files\\Conductor\\Conductor.exe",
      }),
    ).toBeNull();
  });

  it("validates staged Conductor.app structure and rejects corrupt or mismatched bundles", () => {
    const dir = makeTempDir("conductor-validate-");

    const validApp = createFakeMacAppBundle(path.join(dir, "valid"));
    expect(validateStagedMacAppBundle(validApp)).toEqual({
      ok: true,
      executablePath: path.join(validApp, "Contents", "MacOS", "Conductor"),
      bundleId: "com.conductor.app",
    });

    const wrongIdApp = createFakeMacAppBundle(path.join(dir, "wrong-id"), {
      bundleId: "com.evil.otherapp",
    });
    expect(validateStagedMacAppBundle(wrongIdApp).ok).toBe(false);

    const noPlistApp = createFakeMacAppBundle(path.join(dir, "no-plist"), {
      omitInfoPlist: true,
    });
    expect(validateStagedMacAppBundle(noPlistApp).ok).toBe(false);

    const noExecApp = createFakeMacAppBundle(path.join(dir, "no-exec"), {
      omitExecutable: true,
    });
    expect(validateStagedMacAppBundle(noExecApp).ok).toBe(false);

    const noAsarApp = createFakeMacAppBundle(path.join(dir, "no-asar"), {
      omitAsar: true,
    });
    expect(validateStagedMacAppBundle(noAsarApp).ok).toBe(false);

    // findAppBundleInDirectory finds nested & root bundles while skipping __MACOSX
    const nestedRoot = path.join(dir, "extract-nested");
    fs.mkdirSync(path.join(nestedRoot, "__MACOSX"), { recursive: true });
    const nestedApp = createFakeMacAppBundle(path.join(nestedRoot, "release-dir"));
    expect(findAppBundleInDirectory(nestedRoot)).toBe(nestedApp);
  });

  it("generates a POSIX-safe macOS apply script with PID wait, atomic swap + rollback, xattr quarantine strip, and relaunch toggle", () => {
    expect(shellQuote("/tmp/O'Reilly Apps/Conductor.app")).toBe(
      "'/tmp/O'\\''Reilly Apps/Conductor.app'",
    );

    const scriptRelaunch = generateMacUpdateApplyScript({
      parentPid: 4242,
      stagedAppPath: "/tmp/conductor staging/Conductor.app",
      targetAppPath: "/Applications/Conductor.app",
      stagingRootDir: "/tmp/conductor staging",
      relaunch: true,
      logPath: "/tmp/conductor-update.log",
    });

    expect(scriptRelaunch).toContain("#!/bin/sh");
    expect(scriptRelaunch).toContain("PARENT_PID='4242'");
    expect(scriptRelaunch).toContain("RELAUNCH='1'");
    expect(scriptRelaunch).toContain('while kill -0 "$PARENT_PID" 2>/dev/null; do');
    expect(scriptRelaunch).toContain('/usr/bin/xattr -dr com.apple.quarantine "$TARGET_APP"');
    expect(scriptRelaunch).toContain('mv "$TARGET_APP" "$BACKUP_APP"');
    expect(scriptRelaunch).toContain('mv "$BACKUP_APP" "$TARGET_APP"');
    expect(scriptRelaunch).toContain('/usr/bin/open "$TARGET_APP"');

    const scriptQuitOnly = generateMacUpdateApplyScript({
      parentPid: 4242,
      stagedAppPath: "/tmp/staging/Conductor.app",
      targetAppPath: "/Applications/Conductor.app",
      stagingRootDir: "/tmp/staging",
      relaunch: false,
      logPath: "/tmp/conductor-update.log",
    });
    expect(scriptQuitOnly).toContain("RELAUNCH='0'");

    // Safety guard: refuse to generate scripts targeting Electron.app or node_modules
    expect(() =>
      generateMacUpdateApplyScript({
        parentPid: 123,
        stagedAppPath: "/tmp/Conductor.app",
        targetAppPath: "/repo/node_modules/electron/dist/Electron.app",
        stagingRootDir: "/tmp/staging",
        relaunch: true,
        logPath: "/tmp/log",
      }),
    ).toThrow(/Refusing/);
  });

  it("executes the generated /bin/sh swap script end-to-end against a temp bundle (including spaces in paths)", async () => {
    if (process.platform === "win32") return;

    const root = makeTempDir("conductor swap test ");
    const appsDir = path.join(root, "Fake Applications");
    const stagingRoot = path.join(root, "staging run 1");
    const logPath = path.join(root, "apply.log");
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(stagingRoot, { recursive: true });

    const targetApp = createFakeMacAppBundle(appsDir, { versionMarker: "0.1.0-old" });
    const stagedApp = createFakeMacAppBundle(path.join(stagingRoot, "extracted"), {
      versionMarker: "0.2.0-new",
    });

    // Spawn a short-lived dummy parent process so the script exercises its PID wait loop
    const dummyParent = spawn("/bin/sh", ["-c", "sleep 0.25"], { stdio: "ignore" });
    const parentPid = dummyParent.pid!;

    const scriptContent = generateMacUpdateApplyScript({
      parentPid,
      stagedAppPath: stagedApp,
      targetAppPath: targetApp,
      stagingRootDir: stagingRoot,
      relaunch: false,
      logPath,
      waitTimeoutSec: 10,
    });
    const scriptPath = path.join(root, "apply-update.sh");
    fs.writeFileSync(scriptPath, scriptContent, { encoding: "utf8", mode: 0o700 });

    // Run asynchronously so Node.js reaps dummyParent immediately when it exits
    await execFileAsync("/bin/sh", [scriptPath], { timeout: 10_000 });

    // Target bundle was atomically replaced with v0.2.0-new
    expect(fs.readFileSync(path.join(targetApp, "Contents", "Resources", "app.asar"), "utf8")).toBe(
      "fake-asar-0.2.0-new",
    );
    // Staging root was cleaned up and no leftover backup exists in appsDir
    expect(fs.existsSync(stagingRoot)).toBe(false);
    expect(fs.readdirSync(appsDir)).toEqual(["Conductor.app"]);
    expect(fs.readFileSync(logPath, "utf8")).toContain("Successfully replaced");
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

  function createStreamingFetchMock(releaseDto: GitHubReleaseDto = sampleReleaseDto) {
    const chunk1 = new Uint8Array(64).fill(65);
    const chunk2 = new Uint8Array(64).fill(66);
    return vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify(releaseDto), {
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
  }

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
      isPackaged: true,
      targetAppPath: "/Applications/Conductor.app",
      platform: "darwin",
      arch: "arm64",
      downloadsDir,
      fetchImpl: fetchMock,
      openPath: vi.fn().mockResolvedValue(""),
      showItemInFolder: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
      onStateChange: (s) => states.push(s),
    });

    const silentRes = await updater.checkForUpdates({ silent: true });
    expect(silentRes.status).toBe("idle");
    expect(silentRes.error).toBeNull();
    expect(states).toHaveLength(0);

    const manualRes = await updater.checkForUpdates({ silent: false });
    expect(manualRes.status).toBe("error");
    expect(manualRes.errorCode).toBe("network");
    expect(manualRes.error).toContain("ENOTFOUND");
  });

  it("downloads and stages macOS .zip in the background without blocking, then supports restart-to-apply (with cancel & confirm) and apply-on-quit", async () => {
    const root = makeTempDir("conductor-mac-stage-");
    const downloadsDir = path.join(root, "downloads");
    const stagingBaseDir = path.join(root, "staging");
    const fakeAppsDir = path.join(root, "Applications");
    fs.mkdirSync(fakeAppsDir, { recursive: true });
    const targetAppPath = createFakeMacAppBundle(fakeAppsDir, { versionMarker: "0.1.0-old" });

    const states: AppUpdateState[] = [];
    const stripQuarantineMock = vi.fn().mockResolvedValue(undefined);
    const launchScriptMock = vi.fn().mockReturnValue({ scriptPath: "/tmp/apply.sh", pid: 9999 });
    let shouldConfirmRestart = false;
    const requestRestartMock = vi.fn(
      async ({ onConfirmed }: { versionTag: string; onConfirmed: () => void }) => {
        if (!shouldConfirmRestart) return false;
        onConfirmed();
        return true;
      },
    );

    const updater = new AppUpdater({
      currentVersion: "0.1.0",
      currentTag: "v0.1.0-41-aaaaaaa",
      currentRunNumber: 41,
      currentCommitSha: "aaaaaaa",
      isDevMode: false,
      isPackaged: true,
      targetAppPath,
      platform: "darwin",
      arch: "arm64",
      downloadsDir,
      stagingBaseDir,
      parentPid: 7777,
      fetchImpl: createStreamingFetchMock(),
      openPath: vi.fn().mockResolvedValue(""),
      showItemInFolder: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
      onStateChange: (s) => states.push(s),
      progressThrottleMs: 0,
      extractZipImpl: async (_zipPath, extractDir) => {
        createFakeMacAppBundle(extractDir, { versionMarker: "0.1.0-42" });
      },
      stripQuarantineImpl: stripQuarantineMock,
      checkWritableDirImpl: () => true,
      requestRestartForUpdate: requestRestartMock,
      launchUpdateScriptImpl: launchScriptMock,
    });

    const checked = await updater.checkForUpdates({ silent: false });
    expect(checked.status).toBe("available");
    expect(checked.canSelfUpdate).toBe(true);
    expect(checked.targetAppPath).toBe(targetAppPath);
    expect(checked.latestRelease?.selectedAsset?.name).toBe("Conductor-0.1.0-mac-arm64.zip");

    // Background download + extract + verify -> ready_to_install
    const staged = await updater.downloadAndOpen();
    expect(staged.status).toBe("ready_to_install");
    expect(staged.stagedAppPath).toBeTruthy();
    expect(fs.existsSync(staged.stagedAppPath!)).toBe(true);
    expect(staged.stagedVersionTag).toBe("v0.1.0-42-1a351f7");
    expect(staged.applyOnQuit).toBe(true);
    expect(stripQuarantineMock).toHaveBeenCalledWith(staged.stagedAppPath);
    expect(states.some((s) => s.status === "downloading")).toBe(true);
    expect(states.some((s) => s.status === "staging")).toBe(true);
    // Target app has NOT been touched yet while running
    expect(launchScriptMock).not.toHaveBeenCalled();

    // 1. User clicks "Restart & Update Now" but cancels confirmation dialog (running tasks)
    shouldConfirmRestart = false;
    const cancelledRestart = await updater.installAndRestart();
    expect(cancelledRestart).toEqual({ ok: false, cancelled: true });
    expect(updater.getState().status).toBe("ready_to_install");
    expect(launchScriptMock).not.toHaveBeenCalled();

    // 2. Toggle applyOnQuit off & back on
    expect(updater.setApplyOnQuit(false).applyOnQuit).toBe(false);
    expect(updater.shouldApplyOnShutdown()).toBe(false);
    expect(updater.setApplyOnQuit(true).applyOnQuit).toBe(true);
    expect(updater.shouldApplyOnShutdown()).toBe(true);

    // 3. User confirms "Restart & Update Now" -> arms installing -> shutdown spawns helper with relaunch=1
    shouldConfirmRestart = true;
    const confirmedRestart = await updater.installAndRestart();
    expect(confirmedRestart).toEqual({ ok: true });
    expect(updater.getState().status).toBe("installing");

    const launchRes = updater.launchPendingApplyHelperOnShutdown();
    expect(launchRes.launched).toBe(true);
    expect(launchRes.ok).toBe(true);
    expect(launchRes.relaunch).toBe(true);
    expect(launchScriptMock).toHaveBeenCalledTimes(1);
    const [, scriptContent] = launchScriptMock.mock.calls[0]!;
    expect(scriptContent).toContain("PARENT_PID='7777'");
    expect(scriptContent).toContain("RELAUNCH='1'");

    // dispose() preserves staged app directory because helper was launched to swap it
    updater.dispose();
    expect(fs.existsSync(staged.stagedAppPath!)).toBe(true);
  });

  it("supports apply-on-normal-quit (RELAUNCH='0') and .dmg silent fallback extraction on macOS", async () => {
    const root = makeTempDir("conductor-mac-dmg-quit-");
    const dmgOnlyRelease: GitHubReleaseDto = {
      ...sampleReleaseDto,
      assets: FULL_RELEASE_ASSETS.filter((a) => !a.name.endsWith(".zip")),
    };
    const launchScriptMock = vi.fn().mockReturnValue({ scriptPath: "/tmp/apply.sh", pid: 8888 });
    const extractDmgMock = vi.fn(async (_dmgPath: string, extractDir: string) => {
      createFakeMacAppBundle(extractDir, { versionMarker: "0.1.0-42-dmg" });
    });

    const updater = new AppUpdater({
      currentVersion: "0.1.0",
      isDevMode: false,
      isPackaged: true,
      targetAppPath: "/Applications/Conductor.app",
      platform: "darwin",
      arch: "arm64",
      downloadsDir: path.join(root, "downloads"),
      stagingBaseDir: path.join(root, "staging"),
      fetchImpl: createStreamingFetchMock(dmgOnlyRelease),
      openPath: vi.fn().mockResolvedValue(""),
      showItemInFolder: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
      extractDmgImpl: extractDmgMock,
      stripQuarantineImpl: vi.fn().mockResolvedValue(undefined),
      launchUpdateScriptImpl: launchScriptMock,
    });

    const checked = await updater.checkForUpdates({ silent: false });
    expect(checked.latestRelease?.selectedAsset?.name).toBe("Conductor-0.1.0-mac-arm64.dmg");

    const staged = await updater.downloadAndOpen();
    expect(staged.status).toBe("ready_to_install");
    expect(extractDmgMock).toHaveBeenCalledTimes(1);

    // Normal quit (without clicking Restart & Apply) spawns helper with RELAUNCH='0'
    const launchRes = updater.launchPendingApplyHelperOnShutdown();
    expect(launchRes.launched).toBe(true);
    expect(launchRes.relaunch).toBe(false);
    const [, scriptContent] = launchScriptMock.mock.calls[0]!;
    expect(scriptContent).toContain("RELAUNCH='0'");
  });

  it("strictly guards dev mode (!app.isPackaged) from overwriting any app bundle", async () => {
    const root = makeTempDir("conductor-mac-dev-");
    const launchScriptMock = vi.fn();

    const updater = new AppUpdater({
      currentVersion: "0.1.0",
      isDevMode: true,
      isPackaged: false,
      targetAppPath: "/Applications/Conductor.app",
      platform: "darwin",
      arch: "arm64",
      downloadsDir: path.join(root, "downloads"),
      stagingBaseDir: path.join(root, "staging"),
      fetchImpl: createStreamingFetchMock(),
      openPath: vi.fn().mockResolvedValue(""),
      showItemInFolder: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
      extractZipImpl: async (_zipPath, extractDir) => {
        createFakeMacAppBundle(extractDir, { versionMarker: "0.1.0-42" });
      },
      stripQuarantineImpl: vi.fn().mockResolvedValue(undefined),
      launchUpdateScriptImpl: launchScriptMock,
    });

    expect(updater.getState().canSelfUpdate).toBe(false);
    expect(updater.getState().targetAppPath).toBeNull();

    await updater.checkForUpdates({ silent: false });
    const staged = await updater.downloadAndOpen();
    expect(staged.status).toBe("ready_to_install");
    expect(staged.applyOnQuit).toBe(false);

    // Cannot enable applyOnQuit in dev mode
    expect(updater.setApplyOnQuit(true).applyOnQuit).toBe(false);
    expect(updater.shouldApplyOnShutdown()).toBe(false);

    // installAndRestart is blocked with dev_mode_blocked
    const res = await updater.installAndRestart();
    expect(res.ok).toBe(false);
    expect(updater.getState().errorCode).toBe("dev_mode_blocked");
    expect(updater.launchPendingApplyHelperOnShutdown().launched).toBe(false);
    expect(launchScriptMock).not.toHaveBeenCalled();

    // dispose() cleans up temporary staging dir in dev mode
    const stagedPath = staged.stagedAppPath!;
    updater.dispose();
    expect(fs.existsSync(stagedPath)).toBe(false);
  });

  it("reports staging_failed without harming existing app when extracted bundle is corrupt", async () => {
    const root = makeTempDir("conductor-mac-corrupt-");
    const stagingBaseDir = path.join(root, "staging");

    const updater = new AppUpdater({
      currentVersion: "0.1.0",
      isDevMode: false,
      isPackaged: true,
      targetAppPath: "/Applications/Conductor.app",
      platform: "darwin",
      arch: "arm64",
      downloadsDir: path.join(root, "downloads"),
      stagingBaseDir,
      fetchImpl: createStreamingFetchMock(),
      openPath: vi.fn().mockResolvedValue(""),
      showItemInFolder: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
      extractZipImpl: async (_zipPath, extractDir) => {
        // Invalid bundle missing Info.plist
        createFakeMacAppBundle(extractDir, { omitInfoPlist: true });
      },
    });

    await updater.checkForUpdates({ silent: false });
    const failed = await updater.downloadAndOpen();
    expect(failed.status).toBe("error");
    expect(failed.errorCode).toBe("staging_failed");
    expect(failed.stagedAppPath).toBeNull();
    // Temp staging run directory cleaned up after failure
    expect(fs.existsSync(stagingBaseDir) ? fs.readdirSync(stagingBaseDir) : []).toEqual([]);
  });

  it("preserves external installer downloadAndOpen flow on Windows/Linux and handles openPath failure gracefully", async () => {
    const downloadsDir = makeTempDir("conductor-upd-win-");
    const openPath = vi.fn().mockResolvedValue("");
    const showItemInFolder = vi.fn();
    const openExternal = vi.fn().mockResolvedValue(undefined);

    const updater = new AppUpdater({
      currentVersion: "0.1.0",
      currentTag: "v0.1.0-41-aaaaaaa",
      currentRunNumber: 41,
      currentCommitSha: "aaaaaaa",
      isDevMode: false,
      platform: "win32",
      arch: "x64",
      downloadsDir,
      fetchImpl: createStreamingFetchMock(),
      openPath,
      showItemInFolder,
      openExternal,
      progressThrottleMs: 0,
    });

    const checked = await updater.checkForUpdates({ silent: false });
    expect(checked.status).toBe("available");
    expect(checked.latestRelease?.selectedAsset?.name).toBe("Conductor-0.1.0-win-x64-setup.exe");

    const downloaded = await updater.downloadAndOpen();
    expect(downloaded.status).toBe("downloaded");
    expect(downloaded.openedInstaller).toBe(true);
    expect(downloaded.downloadProgress?.percent).toBe(100);
    expect(downloaded.downloadedFilePath).toBe(
      path.join(downloadsDir, "Conductor-0.1.0-win-x64-setup.exe"),
    );
    expect(fs.existsSync(downloaded.downloadedFilePath!)).toBe(true);
    expect(fs.existsSync(`${downloaded.downloadedFilePath!}.part`)).toBe(false);
    expect(openPath).toHaveBeenCalledWith(downloaded.downloadedFilePath);
    expect(updater.showDownloadedInFolder()).toEqual({ ok: true });
    expect(showItemInFolder).toHaveBeenCalledWith(downloaded.downloadedFilePath);

    await updater.openReleasePage();
    expect(openExternal).toHaveBeenCalledWith(sampleReleaseDto.html_url);

    // Verify openPath failure preserves file for manual reveal
    openPath.mockResolvedValueOnce("Blocked by OS");
    const reopen = await updater.openDownloaded();
    expect(reopen.ok).toBe(false);
    expect(updater.getState().errorCode).toBe("open_failed");
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

  it("includes macOS .zip and Gatekeeper guidance in release workflow and electron-builder config", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const releaseWorkflow = fs.readFileSync(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(releaseWorkflow).toContain("release/*.zip");
    expect(releaseWorkflow).toContain("xattr -cr /Applications/Conductor.app");
    expect(releaseWorkflow).toContain("--notes");
    expect(releaseWorkflow).toContain("--generate-notes");

    const builderCfg = fs.readFileSync(path.join(repoRoot, "electron-builder.yml"), "utf8");
    expect(builderCfg).toContain("target: zip");

    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain("xattr -cr /Applications/Conductor.app");
  });
});
