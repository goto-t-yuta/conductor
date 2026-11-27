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

export type PairingTransportMode = "tailscale" | "lan";
export type TailscaleAddressKind = "ip" | "magicdns";
export type PairingEndpointKind = "tailscale-ip" | "tailscale-magicdns" | "lan";

export interface PairingStatusInput {
  port: number;
  token?: string | null;
  tailscaleIp: string | null;
  magicDnsName: string | null;
  lanIp: string | null;
  url?: string | null;
  tailscaleUrl?: string | null;
  magicDnsUrl?: string | null;
  lanUrl?: string | null;
}

export interface PairingEndpoints {
  tailscaleIpUrl: string | null;
  magicDnsUrl: string | null;
  lanUrl: string | null;
  hasTailscale: boolean;
  hasBothTailscaleEndpoints: boolean;
  defaultTransport: PairingTransportMode;
  defaultTailscaleAddressKind: TailscaleAddressKind;
}

export interface ResolvedPairingTarget {
  transport: PairingTransportMode;
  tailscaleAddressKind: TailscaleAddressKind;
  endpointKind: PairingEndpointKind | null;
  url: string | null;
  linkUri: string | null;
  connectUri: string | null;
}

const ACCEPTED_CONNECT_HOSTS = new Set(["connect", "link"]);

function normalizeHttpEndpoint(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  return trimmed.length > 0 ? trimmed : null;
}

function buildHostPortUrl(host: string | null | undefined, port: number): string | null {
  const trimmedHost = typeof host === "string" ? host.trim().replace(/\.+$/, "") : "";
  if (!trimmedHost || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return `http://${trimmedHost}:${port}`;
}

export function buildConductorConnectUri(url: string, token: string): string {
  const params = new URLSearchParams();
  params.set("url", url);
  params.set("token", token);
  return `conductor://connect?${params.toString()}`;
}

export function buildConductorLinkUri(url: string, token: string): string {
  const params = new URLSearchParams();
  params.set("url", url);
  params.set("token", token);
  return `conductor://link?${params.toString()}`;
}

export function resolvePairingEndpoints(status: PairingStatusInput): PairingEndpoints {
  const tailscaleIpUrl =
    normalizeHttpEndpoint(status.tailscaleUrl) ?? buildHostPortUrl(status.tailscaleIp, status.port);
  const magicDnsUrl =
    normalizeHttpEndpoint(status.magicDnsUrl) ?? buildHostPortUrl(status.magicDnsName, status.port);
  const lanUrl =
    normalizeHttpEndpoint(status.lanUrl) ?? buildHostPortUrl(status.lanIp, status.port);

  const hasTailscale = Boolean(tailscaleIpUrl || magicDnsUrl);
  const hasBothTailscaleEndpoints = Boolean(tailscaleIpUrl && magicDnsUrl);
  const defaultTransport: PairingTransportMode = hasTailscale
    ? "tailscale"
    : lanUrl
      ? "lan"
      : "tailscale";
  const defaultTailscaleAddressKind: TailscaleAddressKind = tailscaleIpUrl ? "ip" : "magicdns";

  return {
    tailscaleIpUrl,
    magicDnsUrl,
    lanUrl,
    hasTailscale,
    hasBothTailscaleEndpoints,
    defaultTransport,
    defaultTailscaleAddressKind,
  };
}

export function resolvePairingTarget(
  status: PairingStatusInput,
  options?: {
    transport?: PairingTransportMode | null;
    tailscaleAddressKind?: TailscaleAddressKind | null;
  },
): ResolvedPairingTarget {
  const endpoints = resolvePairingEndpoints(status);
  const transport: PairingTransportMode = options?.transport ?? endpoints.defaultTransport;

  let tailscaleAddressKind: TailscaleAddressKind = endpoints.defaultTailscaleAddressKind;
  if (options?.tailscaleAddressKind === "magicdns" && endpoints.magicDnsUrl) {
    tailscaleAddressKind = "magicdns";
  } else if (options?.tailscaleAddressKind === "ip" && endpoints.tailscaleIpUrl) {
    tailscaleAddressKind = "ip";
  }

  let url: string | null = null;
  let endpointKind: PairingEndpointKind | null = null;

  if (transport === "tailscale") {
    if (tailscaleAddressKind === "magicdns" && endpoints.magicDnsUrl) {
      url = endpoints.magicDnsUrl;
      endpointKind = "tailscale-magicdns";
    } else if (endpoints.tailscaleIpUrl) {
      url = endpoints.tailscaleIpUrl;
      endpointKind = "tailscale-ip";
    } else if (endpoints.magicDnsUrl) {
      url = endpoints.magicDnsUrl;
      endpointKind = "tailscale-magicdns";
    }
  } else {
    url = endpoints.lanUrl;
    endpointKind = url ? "lan" : null;
  }

  const token = typeof status.token === "string" ? status.token.trim() : "";
  const linkUri = url && token ? buildConductorLinkUri(url, token) : null;
  const connectUri = url && token ? buildConductorConnectUri(url, token) : null;

  return {
    transport,
    tailscaleAddressKind,
    endpointKind,
    url,
    linkUri,
    connectUri,
  };
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
