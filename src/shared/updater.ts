/**
 * Shared types and pure logic for checking & downloading Conductor releases
 * from GitHub Releases (`goto-t-yuta/conductor`).
 */

export const GITHUB_REPO_OWNER = "goto-t-yuta";
export const GITHUB_REPO_NAME = "conductor";
export const GITHUB_RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;
export const GITHUB_RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases`;
export const GITHUB_LATEST_RELEASE_PAGE_URL = `https://github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;

export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "up_to_date"
  | "downloading"
  | "downloaded"
  | "error";

export type AppUpdateErrorCode =
  | "network"
  | "rate_limit"
  | "no_release"
  | "no_asset"
  | "download_failed"
  | "open_failed"
  | "cancelled";

export interface AppUpdateReleaseAsset {
  name: string;
  downloadUrl: string;
  size: number;
  contentType: string;
}

export interface AppUpdateReleaseInfo {
  tagName: string;
  version: string;
  name: string;
  body: string;
  notesExcerpt: string;
  htmlUrl: string;
  publishedAt: string | null;
  selectedAsset: AppUpdateReleaseAsset | null;
  allAssetsCount: number;
}

export interface AppUpdateDownloadProgress {
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string;
  currentTag: string | null;
  currentCommitSha: string | null;
  currentRunNumber: number | null;
  isDevMode: boolean;
  platform: string;
  arch: string;
  lastCheckedAt: string | null;
  latestRelease: AppUpdateReleaseInfo | null;
  updateAvailable: boolean;
  downloadProgress: AppUpdateDownloadProgress | null;
  downloadedFilePath: string | null;
  openedInstaller: boolean;
  error: string | null;
  errorCode: AppUpdateErrorCode | null;
}

export interface GitHubReleaseAssetDto {
  name: string;
  browser_download_url: string;
  size?: number;
  content_type?: string;
}

export interface GitHubReleaseDto {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url?: string | null;
  published_at?: string | null;
  target_commitish?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubReleaseAssetDto[];
}

export interface ParsedReleaseTag {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  semver: string;
  runNumber: number | null;
  commitSha: string | null;
  prerelease: string | null;
}

export interface CurrentBuildInfo {
  version: string;
  tag?: string | null;
  commitSha?: string | null;
  runNumber?: number | null;
}

const CI_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)-(\d+)-([0-9a-f]{7,40})(?:\+.*)?$/i;
const SEMVER_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?(?:\+([0-9a-z.-]+))?$/i;

/**
 * Parses either a CI release tag (`v0.1.0-42-1a351f7`) or a standard SemVer tag (`v0.2.0`, `0.2.0-beta.1`).
 */
export function parseReleaseTag(rawTagOrVersion: string | null | undefined): ParsedReleaseTag | null {
  if (!rawTagOrVersion) return null;
  const trimmed = rawTagOrVersion.trim();
  if (!trimmed) return null;

  const ciMatch = CI_TAG_RE.exec(trimmed);
  if (ciMatch) {
    const major = Number(ciMatch[1]);
    const minor = Number(ciMatch[2]);
    const patch = Number(ciMatch[3]);
    const runNumber = Number(ciMatch[4]);
    const commitSha = ciMatch[5].toLowerCase();
    return {
      raw: trimmed,
      major,
      minor,
      patch,
      semver: `${major}.${minor}.${patch}`,
      runNumber: Number.isFinite(runNumber) ? runNumber : null,
      commitSha,
      prerelease: null,
    };
  }

  const semverMatch = SEMVER_TAG_RE.exec(trimmed);
  if (semverMatch) {
    const major = Number(semverMatch[1]);
    const minor = Number(semverMatch[2]);
    const patch = Number(semverMatch[3]);
    const prerelease = semverMatch[4] ? semverMatch[4].toLowerCase() : null;
    return {
      raw: trimmed,
      major,
      minor,
      patch,
      semver: `${major}.${minor}.${patch}`,
      runNumber: null,
      commitSha: null,
      prerelease,
    };
  }

  return null;
}

function comparePrerelease(a: string | null, b: string | null): -1 | 0 | 1 {
  if (a === b) return 0;
  // Release without prerelease has higher precedence than prerelease (SemVer 2.0.0)
  if (a === null) return 1;
  if (b === null) return -1;

  const aParts = a.split(".");
  const bParts = b.split(".");
  const len = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < len; i += 1) {
    const aPart = aParts[i];
    const bPart = bParts[i];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;

    const aNum = /^\d+$/.test(aPart) ? Number(aPart) : null;
    const bNum = /^\d+$/.test(bPart) ? Number(bPart) : null;

    if (aNum !== null && bNum !== null) {
      return aNum > bNum ? 1 : -1;
    }
    if (aNum !== null && bNum === null) return -1;
    if (aNum === null && bNum !== null) return 1;
    return aPart > bPart ? 1 : -1;
  }

  return 0;
}

function normalizeSha(sha: string | null | undefined): string | null {
  if (!sha) return null;
  const cleaned = sha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(cleaned)) return null;
  return cleaned;
}

function shasMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const minLen = Math.min(a.length, b.length);
  if (minLen < 7) return false;
  return a.startsWith(b.slice(0, minLen)) || b.startsWith(a.slice(0, minLen));
}

function resolveCurrentParsed(current: CurrentBuildInfo): ParsedReleaseTag | null {
  const fromTag = parseReleaseTag(current.tag);
  const fromVersion = parseReleaseTag(current.version);
  const base = fromTag ?? fromVersion;
  if (!base) return null;

  const commitSha = normalizeSha(current.commitSha) ?? base.commitSha;
  const runNumber =
    typeof current.runNumber === "number" && Number.isFinite(current.runNumber) && current.runNumber > 0
      ? Math.floor(current.runNumber)
      : base.runNumber;

  return {
    ...base,
    commitSha,
    runNumber,
  };
}

/**
 * Compares the latest GitHub release against the currently running build.
 * Returns:
 *  - `1`  if `latestTag` is newer than `current` (update available)
 *  - `0`  if `latestTag` is the same version/build/commit as `current`
 *  - `-1` if `current` is newer than `latestTag`
 */
export function compareReleaseVersions(
  current: CurrentBuildInfo,
  latestTag: string,
  latestTargetCommitish?: string | null,
): -1 | 0 | 1 {
  const parsedCurrent = resolveCurrentParsed(current);
  const parsedLatest = parseReleaseTag(latestTag);

  if (!parsedLatest) {
    // Fallback string comparison if tag isn't semver-like
    const currentTagNorm = (current.tag || current.version || "").trim().toLowerCase();
    const latestTagNorm = latestTag.trim().toLowerCase();
    if (!latestTagNorm || currentTagNorm === latestTagNorm) return 0;
    return 1;
  }

  if (!parsedCurrent) {
    return 1;
  }

  // 1. Compare core semver: major.minor.patch
  if (parsedLatest.major !== parsedCurrent.major) {
    return parsedLatest.major > parsedCurrent.major ? 1 : -1;
  }
  if (parsedLatest.minor !== parsedCurrent.minor) {
    return parsedLatest.minor > parsedCurrent.minor ? 1 : -1;
  }
  if (parsedLatest.patch !== parsedCurrent.patch) {
    return parsedLatest.patch > parsedCurrent.patch ? 1 : -1;
  }

  // 2. Compare standard SemVer prerelease (e.g. 0.2.0-beta.1 vs 0.2.0)
  const preCmp = comparePrerelease(parsedLatest.prerelease, parsedCurrent.prerelease);
  if (preCmp !== 0) {
    return preCmp;
  }

  // 3. Same semver core & prerelease — compare CI build tag metadata (runNumber & commitSha)
  const latestSha = parsedLatest.commitSha ?? normalizeSha(latestTargetCommitish);
  const currentSha = parsedCurrent.commitSha;

  // Exact commit match always means we're already running that release commit
  if (shasMatch(currentSha, latestSha)) {
    return 0;
  }

  if (parsedLatest.runNumber !== null && parsedCurrent.runNumber !== null) {
    if (parsedLatest.runNumber !== parsedCurrent.runNumber) {
      return parsedLatest.runNumber > parsedCurrent.runNumber ? 1 : -1;
    }
    return 0;
  }

  // Current is an unnumbered build (e.g. older 0.1.0 release before build metadata),
  // while latest is a CI build release `v0.1.0-<run>-<sha>` with a different/unknown SHA.
  if (parsedLatest.runNumber !== null && parsedCurrent.runNumber === null) {
    return 1;
  }

  // Current has a CI run number, latest is a plain semver tag of the same version
  if (parsedLatest.runNumber === null && parsedCurrent.runNumber !== null) {
    return 0;
  }

  return 0;
}

export function isUpdateAvailable(
  current: CurrentBuildInfo,
  latestTag: string,
  latestTargetCommitish?: string | null,
): boolean {
  return compareReleaseVersions(current, latestTag, latestTargetCommitish) > 0;
}

const IGNORED_ASSET_RE =
  /(?:^sha256sums(?:\.txt)?$|\.(?:blockmap|txt|sha256|sha512|sig|asc|yml|yaml|json|apk|aab|pdb|dsym)$)/i;

type NormalizedArch = "arm64" | "x64" | "ia32" | "universal" | "unknown";

function detectAssetArch(lowerName: string): NormalizedArch {
  if (/(?:^|[-_.])universal(?:[-_.]|$)/.test(lowerName)) {
    return "universal";
  }
  if (/(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/.test(lowerName)) {
    return "arm64";
  }
  if (/(?:^|[-_.])(x64|amd64|x86_64|x86-64)(?:[-_.]|$)/.test(lowerName)) {
    return "x64";
  }
  if (/(?:^|[-_.])(ia32|x86|win32)(?:[-_.]|$)/.test(lowerName)) {
    return "ia32";
  }
  return "unknown";
}

function normalizeRuntimeArch(arch: string): NormalizedArch {
  const lower = arch.trim().toLowerCase();
  if (lower === "arm64" || lower === "aarch64") return "arm64";
  if (lower === "x64" || lower === "amd64" || lower === "x86_64") return "x64";
  if (lower === "ia32" || lower === "x86") return "ia32";
  return "unknown";
}

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "codeload.github.com",
]);

export function isAllowedDownloadUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      ALLOWED_DOWNLOAD_HOSTS.has(host) ||
      host.endsWith(".githubusercontent.com") ||
      host.endsWith(".github.com")
    );
  } catch {
    return false;
  }
}

function scoreAssetForPlatform(
  name: string,
  platform: string,
  runtimeArch: NormalizedArch,
): number {
  const lower = name.trim().toLowerCase();
  if (!lower || IGNORED_ASSET_RE.test(lower)) return -1;

  const assetArch = detectAssetArch(lower);

  if (platform === "darwin") {
    const isDmg = lower.endsWith(".dmg");
    const isZip = lower.endsWith(".zip");
    const isPkg = lower.endsWith(".pkg");
    if (!isDmg && !isZip && !isPkg) return -1;

    // Exclude explicitly Windows/Linux zip archives
    if (/(?:^|[-_.])(win|windows|linux|ubuntu|debian|android)(?:[-_.]|$)/.test(lower)) {
      return -1;
    }

    // Strict arch compatibility for macOS (arm64 vs x64)
    let archScore = 0;
    if (runtimeArch === "arm64") {
      if (assetArch === "arm64") archScore = 100;
      else if (assetArch === "universal") archScore = 80;
      else if (assetArch === "unknown") archScore = 40;
      else return -1;
    } else if (runtimeArch === "x64") {
      if (assetArch === "x64") archScore = 100;
      else if (assetArch === "universal") archScore = 80;
      else if (assetArch === "unknown") archScore = 40;
      else return -1;
    } else {
      archScore = assetArch === "universal" ? 80 : 40;
    }

    // Prefer .dmg > .pkg > .zip (dmg is smoothest for unsigned macOS installs)
    const extScore = isDmg ? 30 : isPkg ? 20 : 10;
    const osBonus = /(?:^|[-_.])(mac|macos|darwin|osx)(?:[-_.]|$)/.test(lower) ? 5 : 0;
    return archScore + extScore + osBonus;
  }

  if (platform === "win32") {
    const isExe = lower.endsWith(".exe");
    const isMsi = lower.endsWith(".msi");
    const isWinZip =
      lower.endsWith(".zip") && /(?:^|[-_.])(win|windows)(?:[-_.]|$)/.test(lower);
    if (!isExe && !isMsi && !isWinZip) return -1;

    if (/(?:^|[-_.])(mac|macos|darwin|linux|android)(?:[-_.]|$)/.test(lower)) {
      return -1;
    }

    let archScore = 0;
    if (runtimeArch === "x64") {
      if (assetArch === "x64") archScore = 100;
      else if (assetArch === "unknown") archScore = 50;
      else if (assetArch === "ia32") archScore = 20;
      else return -1;
    } else if (runtimeArch === "arm64") {
      if (assetArch === "arm64") archScore = 100;
      else if (assetArch === "x64") archScore = 70; // Windows on ARM emulates x64 installers
      else if (assetArch === "unknown") archScore = 50;
      else return -1;
    } else if (runtimeArch === "ia32") {
      if (assetArch === "ia32") archScore = 100;
      else if (assetArch === "unknown") archScore = 40;
      else return -1;
    } else {
      archScore = 40;
    }

    // Prefer NSIS setup .exe > generic .exe > portable .exe > .msi > .zip
    let kindScore = 0;
    if (isExe) {
      if (/(?:^|[-_.])(setup|installer)(?:[-_.]|$)/.test(lower)) kindScore = 40;
      else if (/(?:^|[-_.])portable(?:[-_.]|$)/.test(lower)) kindScore = 20;
      else kindScore = 30;
    } else if (isMsi) {
      kindScore = 25;
    } else {
      kindScore = 10;
    }

    const osBonus = /(?:^|[-_.])(win|windows)(?:[-_.]|$)/.test(lower) ? 5 : 0;
    return archScore + kindScore + osBonus;
  }

  if (platform === "linux") {
    const isAppImage = lower.endsWith(".appimage");
    const isDeb = lower.endsWith(".deb");
    const isRpm = lower.endsWith(".rpm");
    if (!isAppImage && !isDeb && !isRpm) return -1;

    if (/(?:^|[-_.])(mac|macos|darwin|win|windows|android)(?:[-_.]|$)/.test(lower)) {
      return -1;
    }

    let archScore = 0;
    if (runtimeArch === "x64") {
      if (assetArch === "x64") archScore = 100;
      else if (assetArch === "unknown") archScore = 40;
      else return -1;
    } else if (runtimeArch === "arm64") {
      if (assetArch === "arm64") archScore = 100;
      else if (assetArch === "unknown") archScore = 40;
      else return -1;
    } else {
      archScore = 40;
    }

    // Prefer .AppImage > .deb > .rpm
    const extScore = isAppImage ? 30 : isDeb ? 20 : 10;
    const osBonus = /(?:^|[-_.])linux(?:[-_.]|$)/.test(lower) ? 5 : 0;
    return archScore + extScore + osBonus;
  }

  return -1;
}

/**
 * Selects the best matching release asset for the given Node.js `platform` and `arch`.
 */
export function selectReleaseAssetForPlatform(
  assets: readonly GitHubReleaseAssetDto[] | null | undefined,
  platform: string,
  arch: string,
): AppUpdateReleaseAsset | null {
  if (!assets || assets.length === 0) return null;

  const runtimeArch = normalizeRuntimeArch(arch);
  let bestAsset: GitHubReleaseAssetDto | null = null;
  let bestScore = -1;

  for (const asset of assets) {
    if (!asset?.name || !asset?.browser_download_url) continue;
    if (!isAllowedDownloadUrl(asset.browser_download_url)) continue;

    const score = scoreAssetForPlatform(asset.name, platform, runtimeArch);
    if (score > bestScore) {
      bestScore = score;
      bestAsset = asset;
    }
  }

  if (!bestAsset || bestScore < 0) return null;

  return {
    name: bestAsset.name,
    downloadUrl: bestAsset.browser_download_url,
    size: typeof bestAsset.size === "number" && Number.isFinite(bestAsset.size) ? bestAsset.size : 0,
    contentType: bestAsset.content_type || "application/octet-stream",
  };
}

/**
 * Extracts a concise, readable excerpt from GitHub release notes markdown.
 */
export function extractReleaseNotesExcerpt(
  body: string | null | undefined,
  maxChars = 420,
): string {
  if (!body) return "";

  const normalized = body
    .replace(/\r\n/g, "\n")
    // Strip HTML comments
    .replace(/<!--[\s\S]*?-->/g, "")
    // Strip markdown links down to their label (keeps readable text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) return "";

  const lines = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !/^\*\*Full Changelog\*\*:/i.test(line.trim()));

  const joined = lines.join("\n").trim();
  if (!joined) return "";
  if (joined.length <= maxChars) return joined;

  const sliced = joined.slice(0, maxChars);
  const lastBreak = Math.max(sliced.lastIndexOf("\n"), sliced.lastIndexOf(" "));
  const cut = lastBreak > maxChars * 0.6 ? sliced.slice(0, lastBreak) : sliced;
  return `${cut.trimEnd()}…`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatPlatformArchLabel(platform: string, arch: string): string {
  const osLabel =
    platform === "darwin"
      ? "macOS"
      : platform === "win32"
        ? "Windows"
        : platform === "linux"
          ? "Linux"
          : platform;
  return `${osLabel} (${arch})`;
}

export function createInitialAppUpdateState(params: {
  currentVersion: string;
  currentTag?: string | null;
  currentCommitSha?: string | null;
  currentRunNumber?: number | null;
  isDevMode: boolean;
  platform: string;
  arch: string;
}): AppUpdateState {
  return {
    status: "idle",
    currentVersion: params.currentVersion,
    currentTag: params.currentTag ?? null,
    currentCommitSha: params.currentCommitSha ?? null,
    currentRunNumber: params.currentRunNumber ?? null,
    isDevMode: params.isDevMode,
    platform: params.platform,
    arch: params.arch,
    lastCheckedAt: null,
    latestRelease: null,
    updateAvailable: false,
    downloadProgress: null,
    downloadedFilePath: null,
    openedInstaller: false,
    error: null,
    errorCode: null,
  };
}
