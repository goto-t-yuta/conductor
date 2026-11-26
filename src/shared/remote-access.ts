/**
 * Shared constants & URI helpers for Android APK download and desktop-mobile QR pairing.
 */

export const ANDROID_APK_FILENAME = "conductor-android.apk";

export const ANDROID_APK_DOWNLOAD_URL =
  `https://github.com/goto-t-yuta/conductor/releases/latest/download/${ANDROID_APK_FILENAME}`;

export const ANDROID_RELEASES_PAGE_URL =
  "https://github.com/goto-t-yuta/conductor/releases/latest";

export interface ConductorConnectPayload {
  url: string;
  token: string;
}

const ACCEPTED_CONNECT_HOSTS = new Set(["connect", "link"]);

export function buildConductorConnectUri(url: string, token: string): string {
  const params = new URLSearchParams();
  params.set("url", url);
  params.set("token", token);
  return `conductor://connect?${params.toString()}`;
}

export function parseConductorConnectUri(raw: string): ConductorConnectPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Support JSON payload fallback: {"url": "...", "token": "..."}
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const rawUrl =
        typeof parsed.url === "string"
          ? parsed.url
          : typeof parsed.serverUrl === "string"
            ? parsed.serverUrl
            : "";
      const rawToken =
        typeof parsed.token === "string"
          ? parsed.token
          : typeof parsed.bearerToken === "string"
            ? parsed.bearerToken
            : "";
      const url = rawUrl.trim().replace(/\/+$/, "");
      const token = rawToken.trim();
      if (!url || !token) return null;
      return { url, token };
    } catch {
      return null;
    }
  }

  if (!trimmed.toLowerCase().startsWith("conductor://")) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname && !ACCEPTED_CONNECT_HOSTS.has(parsed.hostname.toLowerCase())) {
      return null;
    }
    const url = parsed.searchParams.get("url")?.trim() ?? "";
    const token = parsed.searchParams.get("token")?.trim() ?? "";
    if (!url || !token) return null;
    return { url: url.replace(/\/+$/, ""), token };
  } catch {
    return null;
  }
}
