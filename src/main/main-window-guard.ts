import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_HTML_EXT_RE = /\.(?:html|htm)$/i;

export interface MainWindowNavigationEventLike {
  preventDefault(): void;
}

export interface MainWindowWebContentsLike {
  on(
    event: "will-navigate" | "will-redirect",
    listener: (event: MainWindowNavigationEventLike, url: string) => void,
  ): unknown;
  setWindowOpenHandler(
    handler: (details: { url: string }) => { action: "allow" | "deny" },
  ): void;
}

export interface MainWindowNavigationGuardTarget {
  /** Development server URL (e.g. `http://localhost:5179`) when running with Vite dev server. */
  devServerUrl?: string | null;
  /** Packaged/built renderer HTML file path (e.g. `dist/renderer/index.html`). */
  rendererHtmlPath?: string | null;
}

export interface MainWindowNavigationGuardOptions extends MainWindowNavigationGuardTarget {
  /**
   * Optional fallback router for blocked external `http(s)://` URLs and local
   * `file://` `.html`/`.htm` links so they open inside the right-pane In-App Browser
   * instead of navigating or spawning windows from the main app frame.
   */
  onOpenInAppBrowser?: (url: string) => void;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFilesystemPathForCompare(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync(resolved);
  } catch {
    // Keep resolved path when target does not exist on disk (e.g. unit tests)
  }
  const normalized = canonical.replace(/\\/g, "/");
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLowerCase()
    : normalized;
}

/**
 * Returns true if `rawUrl` is a `file://` URL pointing to an `.html` or `.htm` document.
 */
export function isLocalHtmlFileUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!/^file:\/\//i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol.toLowerCase() !== "file:") return false;
    const decodedPathname = safeDecodeURIComponent(parsed.pathname);
    return LOCAL_HTML_EXT_RE.test(decodedPathname);
  } catch {
    return false;
  }
}

/**
 * Determines whether the main Conductor `BrowserWindow` should be permitted to navigate
 * to `targetUrl`.
 *
 * - In dev mode (`devServerUrl` set): allows only `http:` / `https:` URLs with the exact
 *   same origin as `devServerUrl`.
 * - In production mode (`rendererHtmlPath` set): allows only `file:` URLs pointing to the
 *   exact built `renderer/index.html` entry file (ignoring query/hash).
 * - Blocks all other `file://` URLs (such as local `.html` reports or images), all external
 *   URLs, and all unsafe schemes (`javascript:`, `data:`, etc.).
 */
export function isAllowedMainWindowNavigation(
  targetUrl: string,
  target: MainWindowNavigationGuardTarget,
): boolean {
  const trimmed = targetUrl.trim();
  if (!trimmed) return false;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  const protocol = parsed.protocol.toLowerCase();

  if (target.devServerUrl?.trim()) {
    try {
      const allowed = new URL(target.devServerUrl.trim());
      return (
        (protocol === "http:" || protocol === "https:") &&
        parsed.origin === allowed.origin
      );
    } catch {
      return false;
    }
  }

  if (target.rendererHtmlPath?.trim()) {
    if (protocol !== "file:") return false;
    try {
      const stripped = new URL(parsed.toString());
      stripped.search = "";
      stripped.hash = "";
      const targetFsPath = fileURLToPath(stripped);
      return (
        normalizeFilesystemPathForCompare(targetFsPath) ===
        normalizeFilesystemPathForCompare(target.rendererHtmlPath)
      );
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Returns true if a blocked URL from the main window should be safely forwarded to the
 * right-pane In-App Chromium Browser (remote `http(s)://` or local `file://` `.html`/`.htm`).
 */
export function shouldRouteBlockedUrlToInAppBrowser(
  targetUrl: string,
  target: MainWindowNavigationGuardTarget,
): boolean {
  const trimmed = targetUrl.trim();
  if (!trimmed) return false;
  if (isAllowedMainWindowNavigation(trimmed, target)) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (isLocalHtmlFileUrl(trimmed)) return true;
  return false;
}

/**
 * Installs `will-navigate`, `will-redirect`, and `setWindowOpenHandler` guards on the
 * main Conductor `BrowserWindow`'s `webContents` so the app UI can never be replaced by
 * accidental `file://` or external URL navigations or spawn unmanaged popups.
 */
export function installMainWindowNavigationGuard(
  webContents: MainWindowWebContentsLike,
  options: MainWindowNavigationGuardOptions,
): void {
  const target: MainWindowNavigationGuardTarget = {
    devServerUrl: options.devServerUrl,
    rendererHtmlPath: options.rendererHtmlPath,
  };

  webContents.on("will-navigate", (event, url) => {
    if (isAllowedMainWindowNavigation(url, target)) {
      return;
    }
    event.preventDefault();
    if (shouldRouteBlockedUrlToInAppBrowser(url, target)) {
      options.onOpenInAppBrowser?.(url);
    }
  });

  webContents.on("will-redirect", (event, url) => {
    if (isAllowedMainWindowNavigation(url, target)) {
      return;
    }
    event.preventDefault();
  });

  webContents.setWindowOpenHandler(({ url }) => {
    if (shouldRouteBlockedUrlToInAppBrowser(url, target)) {
      options.onOpenInAppBrowser?.(url);
    }
    return { action: "deny" };
  });
}
