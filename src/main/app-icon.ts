import fs from "node:fs";
import path from "node:path";
import { app, nativeImage, type NativeImage } from "electron";

export interface ResolveAppIconPathOptions {
  /** Directory containing the compiled main process entry (defaults to `__dirname`). */
  mainDir?: string;
  /** Packaged or development app root returned by `app.getAppPath()`. */
  appPath?: string;
  /** Electron `process.resourcesPath` when packaged. */
  resourcesPath?: string;
  /** Custom file existence checker for unit tests. */
  existsSync?: (targetPath: string) => boolean;
}

/**
 * Resolves the absolute path to Conductor's high-resolution application icon PNG.
 * Checks development build resources (`../../build/icon.png`), packaged app.asar
 * (`<appPath>/build/icon.png`), and extraResources fallbacks.
 */
export function resolveAppIconPath(options: ResolveAppIconPathOptions = {}): string | null {
  const mainDir = options.mainDir ?? __dirname;
  const existsSync = options.existsSync ?? fs.existsSync;

  const candidates: string[] = [
    path.resolve(mainDir, "../../build/icon.png"),
  ];

  if (options.appPath) {
    candidates.push(path.join(options.appPath, "build/icon.png"));
  }
  if (options.resourcesPath) {
    candidates.push(path.join(options.resourcesPath, "build/icon.png"));
    candidates.push(path.join(options.resourcesPath, "icon.png"));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (existsSync(normalized)) {
      return normalized;
    }
  }

  return null;
}

/**
 * Loads Conductor's runtime NativeImage icon for `BrowserWindow` and `app.dock.setIcon`.
 * Returns `null` if the icon file is missing or cannot be decoded.
 */
export function loadAppIcon(options: ResolveAppIconPathOptions = {}): NativeImage | null {
  let appPath = options.appPath;
  if (appPath === undefined) {
    try {
      appPath = app.getAppPath();
    } catch {
      appPath = undefined;
    }
  }

  const resourcesPath =
    options.resourcesPath !== undefined
      ? options.resourcesPath
      : typeof process.resourcesPath === "string"
        ? process.resourcesPath
        : undefined;

  const iconPath = resolveAppIconPath({
    ...options,
    appPath,
    resourcesPath,
  });

  if (!iconPath) return null;

  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? null : image;
}
