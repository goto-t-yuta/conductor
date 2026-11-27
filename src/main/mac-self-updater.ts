import { execFile, spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const EXPECTED_MAC_BUNDLE_ID = "com.conductor.app";
export const DEFAULT_MAC_APP_NAME = "Conductor.app";

export interface ResolveMacTargetAppParams {
  platform: string;
  isPackaged: boolean;
  execPath: string;
  applicationsDir?: string;
  existsSync?: (p: string) => boolean;
}

/**
 * Resolves the macOS `.app` bundle path to replace during self-update.
 *
 * Strictly returns `null` when:
 *  - platform is not `darwin`
 *  - app is running in development mode (`!isPackaged`)
 *  - execPath points to `Electron.app` or inside `node_modules`
 */
export function resolveMacTargetAppBundlePath(params: ResolveMacTargetAppParams): string | null {
  if (params.platform !== "darwin" || !params.isPackaged) {
    return null;
  }

  const applicationsDir = params.applicationsDir ?? "/Applications";
  const exists = params.existsSync ?? fs.existsSync;
  const resolvedExec = path.resolve(params.execPath || "");

  if (resolvedExec.includes(`${path.sep}node_modules${path.sep}`)) {
    return null;
  }

  // Walk up from execPath (e.g. /Applications/Conductor.app/Contents/MacOS/Conductor)
  let current = resolvedExec;
  let enclosingApp: string | null = null;
  while (current && current !== path.dirname(current)) {
    if (current.toLowerCase().endsWith(".app")) {
      enclosingApp = current;
      break;
    }
    current = path.dirname(current);
  }

  if (enclosingApp) {
    const baseLower = path.basename(enclosingApp).toLowerCase();
    if (baseLower === "electron.app") {
      return null;
    }

    // If running from a mounted DMG (/Volumes/...) or Gatekeeper AppTranslocation,
    // install into /Applications/Conductor.app instead of the read-only mount.
    const isReadOnlyLocation =
      enclosingApp.startsWith("/Volumes/") ||
      enclosingApp.includes("/AppTranslocation/");
    if (isReadOnlyLocation) {
      return path.join(applicationsDir, DEFAULT_MAC_APP_NAME);
    }

    return enclosingApp;
  }

  const standardAppPath = path.join(applicationsDir, DEFAULT_MAC_APP_NAME);
  if (exists(standardAppPath)) {
    return standardAppPath;
  }

  return null;
}

export interface StagedMacAppValidationResult {
  ok: boolean;
  executablePath?: string;
  bundleId?: string | null;
  error?: string;
}

function readXmlPlistStringValue(plistContent: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]+)</string>`, "i");
  const match = re.exec(plistContent);
  return match?.[1]?.trim() || null;
}

/**
 * Validates that a staged `.app` bundle is a structurally intact Conductor macOS bundle
 * before allowing any replacement of the installed application.
 */
export function validateStagedMacAppBundle(
  appPath: string,
  expectedBundleId: string | null = EXPECTED_MAC_BUNDLE_ID,
): StagedMacAppValidationResult {
  if (!appPath || !appPath.toLowerCase().endsWith(".app")) {
    return { ok: false, error: `Invalid app bundle path: ${appPath}` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(appPath);
  } catch {
    return { ok: false, error: `Staged app bundle does not exist: ${appPath}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `Staged app bundle is not a directory: ${appPath}` };
  }

  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  if (!fs.existsSync(infoPlistPath) || !fs.statSync(infoPlistPath).isFile()) {
    return { ok: false, error: "Staged app bundle is missing Contents/Info.plist." };
  }

  let bundleId: string | null = null;
  let executableName = "Conductor";
  try {
    const rawPlist = fs.readFileSync(infoPlistPath, "utf8");
    const parsedBundleId = readXmlPlistStringValue(rawPlist, "CFBundleIdentifier");
    if (parsedBundleId) {
      bundleId = parsedBundleId;
      if (expectedBundleId && parsedBundleId !== expectedBundleId) {
        return {
          ok: false,
          error: `Staged bundle identifier mismatch: expected ${expectedBundleId}, got ${parsedBundleId}.`,
        };
      }
    }
    const parsedExecutable = readXmlPlistStringValue(rawPlist, "CFBundleExecutable");
    if (parsedExecutable) {
      executableName = parsedExecutable;
    }
  } catch {
    return { ok: false, error: "Failed to read Contents/Info.plist in staged app bundle." };
  }

  const macOsDir = path.join(appPath, "Contents", "MacOS");
  if (!fs.existsSync(macOsDir) || !fs.statSync(macOsDir).isDirectory()) {
    return { ok: false, error: "Staged app bundle is missing Contents/MacOS directory." };
  }

  const executablePath = path.join(macOsDir, executableName);
  if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
    return {
      ok: false,
      error: `Staged app bundle is missing executable: Contents/MacOS/${executableName}`,
    };
  }

  const resourcesDir = path.join(appPath, "Contents", "Resources");
  const hasAsar = fs.existsSync(path.join(resourcesDir, "app.asar"));
  const hasAppDir = fs.existsSync(path.join(resourcesDir, "app"));
  if (!hasAsar && !hasAppDir) {
    return {
      ok: false,
      error: "Staged app bundle is missing Contents/Resources/app.asar (or app).",
    };
  }

  return {
    ok: true,
    executablePath,
    bundleId,
  };
}

/**
 * Finds `Conductor.app` (or any `*.app`) inside an extracted archive or mounted DMG directory.
 */
export function findAppBundleInDirectory(dirPath: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const visibleDirs = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      entry.name !== "__MACOSX",
  );

  const exactConductor = visibleDirs.find(
    (entry) => entry.name.toLowerCase() === DEFAULT_MAC_APP_NAME.toLowerCase(),
  );
  if (exactConductor) {
    return path.join(dirPath, exactConductor.name);
  }

  const anyTopApp = visibleDirs.find((entry) => entry.name.toLowerCase().endsWith(".app"));
  if (anyTopApp) {
    return path.join(dirPath, anyTopApp.name);
  }

  // Fallback: inspect one nested folder level in case the archive wraps the app bundle
  for (const sub of visibleDirs) {
    const subPath = path.join(dirPath, sub.name);
    let subEntries: fs.Dirent[];
    try {
      subEntries = fs.readdirSync(subPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const nestedExact = subEntries.find(
      (entry) =>
        entry.isDirectory() &&
        entry.name.toLowerCase() === DEFAULT_MAC_APP_NAME.toLowerCase(),
    );
    if (nestedExact) {
      return path.join(subPath, nestedExact.name);
    }
    const nestedAny = subEntries.find(
      (entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith(".app"),
    );
    if (nestedAny) {
      return path.join(subPath, nestedAny.name);
    }
  }

  return null;
}

/**
 * Safely POSIX-single-quotes a string for embedding into `/bin/sh` scripts.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface MacUpdateScriptParams {
  parentPid: number;
  stagedAppPath: string;
  targetAppPath: string;
  stagingRootDir: string;
  relaunch: boolean;
  logPath: string;
  waitTimeoutSec?: number;
}

/**
 * Generates an independent POSIX `/bin/sh` script that waits for the running Electron
 * process to exit, atomically swaps the target `.app` bundle (with rollback on error),
 * strips `com.apple.quarantine`, optionally relaunches the updated app, and cleans up
 * the staging directory.
 *
 * All downloading, archive extraction, and bundle verification happen BEFORE this script
 * runs so that downtime during restart is minimized to ~1-2 seconds.
 */
export function generateMacUpdateApplyScript(params: MacUpdateScriptParams): string {
  if (!Number.isInteger(params.parentPid) || params.parentPid <= 0) {
    throw new Error(`Invalid parentPid: ${params.parentPid}`);
  }
  if (!params.stagedAppPath || !params.stagedAppPath.toLowerCase().endsWith(".app")) {
    throw new Error(`Invalid stagedAppPath: ${params.stagedAppPath}`);
  }
  if (!params.targetAppPath || !params.targetAppPath.toLowerCase().endsWith(".app")) {
    throw new Error(`Invalid targetAppPath: ${params.targetAppPath}`);
  }
  const targetBaseLower = path.basename(params.targetAppPath).toLowerCase();
  if (
    targetBaseLower === "electron.app" ||
    params.targetAppPath.includes(`${path.sep}node_modules${path.sep}`)
  ) {
    throw new Error(`Refusing to generate update script for dev bundle: ${params.targetAppPath}`);
  }

  const waitTimeoutSec = Math.max(5, Math.floor(params.waitTimeoutSec ?? 60));
  const waitTimeoutTenths = waitTimeoutSec * 10;

  return [
    "#!/bin/sh",
    "set -u",
    "",
    `PARENT_PID=${shellQuote(String(params.parentPid))}`,
    `STAGED_APP=${shellQuote(params.stagedAppPath)}`,
    `TARGET_APP=${shellQuote(params.targetAppPath)}`,
    `STAGING_ROOT=${shellQuote(params.stagingRootDir)}`,
    `RELAUNCH=${shellQuote(params.relaunch ? "1" : "0")}`,
    `LOG_FILE=${shellQuote(params.logPath)}`,
    `WAIT_TIMEOUT_TENTHS=${shellQuote(String(waitTimeoutTenths))}`,
    "",
    'exec >>"$LOG_FILE" 2>&1',
    'echo "[$(date \'+%Y-%m-%d %H:%M:%S\')] Starting Conductor macOS self-update (pid=$PARENT_PID, relaunch=$RELAUNCH)"',
    "",
    "# 1. Wait for the currently running Conductor process to exit cleanly",
    "ELAPSED=0",
    'while kill -0 "$PARENT_PID" 2>/dev/null; do',
    '  if [ "$ELAPSED" -ge "$WAIT_TIMEOUT_TENTHS" ]; then',
    '    echo "ERROR: Timed out waiting for PID $PARENT_PID to exit. Aborting without modifying $TARGET_APP."',
    "    exit 1",
    "  fi",
    "  sleep 0.2",
    "  ELAPSED=$((ELAPSED + 2))",
    "done",
    "",
    "# Brief settle delay so macOS releases bundle file handles cleanly",
    "sleep 0.3",
    "",
    "# 2. Verify staged app bundle is still intact",
    'if [ ! -d "$STAGED_APP" ] || [ ! -f "$STAGED_APP/Contents/Info.plist" ]; then',
    '  echo "ERROR: Staged app bundle is missing or invalid: $STAGED_APP"',
    "  exit 1",
    "fi",
    "",
    'TARGET_DIR=$(dirname "$TARGET_APP")',
    'if [ ! -d "$TARGET_DIR" ]; then',
    '  echo "ERROR: Target directory does not exist: $TARGET_DIR"',
    "  exit 1",
    "fi",
    "",
    'if [ ! -w "$TARGET_DIR" ]; then',
    '  echo "ERROR: Target directory is not writable: $TARGET_DIR"',
    "  exit 1",
    "fi",
    "",
    "# 3. Remove Gatekeeper quarantine attribute on staged bundle",
    '/usr/bin/xattr -dr com.apple.quarantine "$STAGED_APP" 2>/dev/null || true',
    "",
    "# 4. Atomically swap target app bundle with rollback protection",
    'BACKUP_APP="${TARGET_APP}.backup-$$"',
    "HAD_EXISTING=0",
    'if [ -e "$TARGET_APP" ]; then',
    "  HAD_EXISTING=1",
    '  if ! mv "$TARGET_APP" "$BACKUP_APP"; then',
    '    echo "ERROR: Failed to move existing app to backup: $BACKUP_APP"',
    "    exit 1",
    "  fi",
    "fi",
    "",
    "SWAP_OK=0",
    'if mv "$STAGED_APP" "$TARGET_APP" 2>/dev/null; then',
    "  SWAP_OK=1",
    'elif /usr/bin/ditto "$STAGED_APP" "$TARGET_APP"; then',
    "  SWAP_OK=1",
    "fi",
    "",
    'if [ "$SWAP_OK" -ne 1 ]; then',
    '  echo "ERROR: Failed to place updated app at $TARGET_APP. Restoring previous version."',
    '  rm -rf "$TARGET_APP" 2>/dev/null || true',
    '  if [ "$HAD_EXISTING" -eq 1 ] && [ -e "$BACKUP_APP" ]; then',
    '    mv "$BACKUP_APP" "$TARGET_APP" || true',
    "  fi",
    "  exit 1",
    "fi",
    "",
    "# 5. Ensure Gatekeeper quarantine is cleared on the installed app bundle",
    '/usr/bin/xattr -dr com.apple.quarantine "$TARGET_APP" 2>/dev/null || true',
    "",
    "# 6. Remove backup bundle after successful replacement",
    'if [ "$HAD_EXISTING" -eq 1 ] && [ -e "$BACKUP_APP" ]; then',
    '  rm -rf "$BACKUP_APP" 2>/dev/null || true',
    "fi",
    "",
    'echo "[$(date \'+%Y-%m-%d %H:%M:%S\')] Successfully replaced $TARGET_APP"',
    "",
    "# 7. Relaunch updated Conductor if requested",
    'if [ "$RELAUNCH" = "1" ]; then',
    '  echo "Relaunching $TARGET_APP"',
    '  /usr/bin/open "$TARGET_APP" || true',
    "fi",
    "",
    "# 8. Clean up temporary staging workspace",
    'if [ -n "$STAGING_ROOT" ] && [ -d "$STAGING_ROOT" ]; then',
    '  rm -rf "$STAGING_ROOT" 2>/dev/null || true',
    "fi",
    "",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Extracts a macOS `.zip` archive in the background using `ditto -x -k` (preserves symlinks & permissions).
 */
export async function extractMacZipArchive(
  zipPath: string,
  extractDir: string,
  signal?: AbortSignal,
): Promise<void> {
  fs.mkdirSync(extractDir, { recursive: true });
  await execFileAsync("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir], {
    signal,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Silently mounts a macOS `.dmg` with `hdiutil attach -nobrowse -readonly`, copies its `.app`
 * into `extractDir` with `ditto`, and always detaches the volume.
 */
export async function extractMacDmgArchive(
  dmgPath: string,
  extractDir: string,
  signal?: AbortSignal,
): Promise<void> {
  fs.mkdirSync(extractDir, { recursive: true });
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-dmg-mnt-"));
  let mounted = false;

  try {
    await execFileAsync(
      "/usr/bin/hdiutil",
      ["attach", "-nobrowse", "-readonly", "-noverify", "-mountpoint", mountPoint, dmgPath],
      { signal, maxBuffer: 10 * 1024 * 1024 },
    );
    mounted = true;

    const mountedApp = findAppBundleInDirectory(mountPoint);
    if (!mountedApp) {
      throw new Error("No .app bundle found inside the downloaded DMG image.");
    }

    const destAppPath = path.join(extractDir, path.basename(mountedApp));
    await execFileAsync("/usr/bin/ditto", [mountedApp, destAppPath], {
      signal,
      maxBuffer: 10 * 1024 * 1024,
    });
  } finally {
    if (mounted) {
      try {
        await execFileAsync("/usr/bin/hdiutil", ["detach", mountPoint, "-force"], {
          maxBuffer: 1024 * 1024,
        });
      } catch {
        // ignore detach cleanup error
      }
    }
    try {
      fs.rmSync(mountPoint, { recursive: true, force: true });
    } catch {
      // ignore mountPoint cleanup error
    }
  }
}

/**
 * Best-effort removal of `com.apple.quarantine` on macOS (non-fatal if absent).
 */
export async function stripMacQuarantineAttribute(targetPath: string): Promise<void> {
  try {
    await execFileAsync("/usr/bin/xattr", ["-dr", "com.apple.quarantine", targetPath], {
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // Attribute may not exist or xattr may be unavailable on non-macOS test hosts
  }
}

/**
 * Writes the generated update apply script with mode `0o700` and launches it detached
 * from the Electron process so it survives `app.quit()`.
 */
export function launchDetachedMacUpdateScript(
  scriptPath: string,
  scriptContent: string,
): { scriptPath: string; pid: number | undefined } {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, scriptContent, { encoding: "utf8", mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);

  const spawnOpts: SpawnOptions = {
    detached: true,
    stdio: "ignore",
  };
  const child = spawn("/bin/sh", [scriptPath], spawnOpts);
  child.unref();

  return {
    scriptPath,
    pid: child.pid,
  };
}
