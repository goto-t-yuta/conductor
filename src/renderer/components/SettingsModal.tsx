import React, { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpCircle,
  BarChart3,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  GitBranch,
  Globe,
  Link2,
  Loader2,
  Mic,
  Power,
  QrCode,
  RefreshCw,
  Search,
  Settings,
  Smartphone,
  Volume2,
  X,
} from "lucide-react";
import {
  getLocalizedLanguageOptionMeta,
  resolveUiLocale,
  t,
  type UiLocale,
} from "../../shared/i18n.js";
import { DEFAULT_PREFERRED_LANGUAGE, LANGUAGE_OPTIONS } from "../../shared/language.js";
import { ANDROID_APK_DOWNLOAD_URL } from "../../shared/remote-access.js";
import type {
  AppUpdateState,
  IntegrationMode,
  PreferredLanguage,
  Project,
  ProviderQuotasMap,
  RemoteAccessStatus,
  UsageBudgetSettings,
  UsageRecord,
} from "../../shared/types.js";
import { formatBytes, formatPlatformArchLabel } from "../../shared/updater.js";
import {
  DEFAULT_VOICE_AUTO_SEND,
  DEFAULT_VOICE_READBACK_ENABLED,
} from "../../shared/voice.js";
import {
  getIntegrationModeOption,
  getIntegrationModeOptions,
} from "../lib/integration-mode.js";
import { QrCodeSvg } from "./QrCodeSvg.js";
import { UsagePanel } from "./UsagePanel.js";

export type SettingsModalTab = "general" | "usage";

export interface SettingsModalProps {
  defaultIntegrationMode: IntegrationMode;
  autoLandOnComplete?: boolean;
  preferredLanguage?: PreferredLanguage;
  voiceReadbackEnabled?: boolean;
  voiceAutoSend?: boolean;
  remoteAccess?: RemoteAccessStatus;
  locale?: UiLocale;
  projects: Project[];
  initialTab?: SettingsModalTab;
  usageRecords?: UsageRecord[];
  usageBudgets?: UsageBudgetSettings;
  providerQuotas?: ProviderQuotasMap;
  onClearUsage?: () => void;
  onUpdateUsageBudgets?: (budgets: UsageBudgetSettings) => void;
  onRefreshProviderQuotas?: () => void | Promise<unknown>;
  onClose: () => void;
  onSetDefaultIntegrationMode: (mode: IntegrationMode) => void;
  onSetAutoLandOnComplete?: (enabled: boolean) => void;
  onSetProjectIntegrationMode: (projectId: string, mode: IntegrationMode | null) => void;
  onChangePreferredLanguage?: (language: PreferredLanguage) => void;
  onSetVoiceReadbackEnabled?: (enabled: boolean) => void;
  onSetVoiceAutoSend?: (enabled: boolean) => void;
  onSetRemoteAccessEnabled?: (enabled: boolean) => void;
  onSetRemoteAccessPort?: (port: number) => void;
  onRegenerateRemoteAccessToken?: () => void;
  onRefreshRemoteAccessStatus?: () => void;
  appUpdate?: AppUpdateState | null;
  onCheckForUpdates?: () => void;
  onDownloadAndOpenUpdate?: () => void;
  onCancelUpdateDownload?: () => void;
  onOpenDownloadedUpdate?: () => void;
  onShowDownloadedUpdateInFolder?: () => void;
  onOpenUpdateReleasePage?: (url?: string) => void;
}

export interface AppUpdateSettingsSectionProps {
  appUpdate: AppUpdateState;
  locale?: UiLocale;
  onCheckForUpdates?: () => void;
  onDownloadAndOpenUpdate?: () => void;
  onCancelUpdateDownload?: () => void;
  onOpenDownloadedUpdate?: () => void;
  onShowDownloadedUpdateInFolder?: () => void;
  onOpenUpdateReleasePage?: (url?: string) => void;
}

function formatUpdateTimestamp(iso: string | null, locale: UiLocale): string {
  if (!iso) return t(locale, "update.notCheckedYet");
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : "en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

function resolveUpdateErrorText(appUpdate: AppUpdateState, locale: UiLocale): string | null {
  if (!appUpdate.errorCode && !appUpdate.error) return null;
  switch (appUpdate.errorCode) {
    case "network":
      return t(locale, "update.errorNetwork");
    case "rate_limit":
      return t(locale, "update.errorRateLimit");
    case "no_release":
      return t(locale, "update.errorNoRelease");
    case "download_failed":
      return t(locale, "update.errorDownloadFailed");
    case "open_failed":
      return t(locale, "update.errorOpenFailed");
    case "no_asset":
      return t(locale, "update.noAssetForPlatform", {
        platform: formatPlatformArchLabel(appUpdate.platform, appUpdate.arch),
      });
    default:
      return appUpdate.error;
  }
}

export const AppUpdateSettingsSection: React.FC<AppUpdateSettingsSectionProps> = ({
  appUpdate,
  locale = "ja",
  onCheckForUpdates,
  onDownloadAndOpenUpdate,
  onCancelUpdateDownload,
  onOpenDownloadedUpdate,
  onShowDownloadedUpdateInFolder,
  onOpenUpdateReleasePage,
}) => {
  const isChecking = appUpdate.status === "checking";
  const isDownloading = appUpdate.status === "downloading";
  const isDownloaded = appUpdate.status === "downloaded";
  const isAvailable = appUpdate.status === "available";
  const isUpToDate = appUpdate.status === "up_to_date";
  const isError = appUpdate.status === "error";
  const release = appUpdate.latestRelease;
  const asset = release?.selectedAsset ?? null;
  const progress = appUpdate.downloadProgress;
  const platformLabel = formatPlatformArchLabel(appUpdate.platform, appUpdate.arch);
  const localizedError = resolveUpdateErrorText(appUpdate, locale);

  const currentVersionDisplay = appUpdate.currentTag
    ? appUpdate.currentTag
    : appUpdate.currentCommitSha
      ? `v${appUpdate.currentVersion} (${appUpdate.currentCommitSha})`
      : `v${appUpdate.currentVersion}`;

  const statusBadge = (() => {
    if (isAvailable) {
      return {
        label: t(locale, "update.statusAvailable"),
        cls: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
      };
    }
    if (isDownloading) {
      return {
        label: t(locale, "update.statusDownloading"),
        cls: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
      };
    }
    if (isDownloaded) {
      return {
        label: t(locale, "update.statusDownloaded"),
        cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
      };
    }
    if (isUpToDate) {
      return {
        label: t(locale, "update.statusUpToDate"),
        cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
      };
    }
    if (isError) {
      return {
        label: t(locale, "update.statusError"),
        cls: "bg-rose-500/15 text-rose-600 dark:text-rose-300",
      };
    }
    return null;
  })();

  return (
    <section
      data-testid="app-update-section"
      className="space-y-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5 flex-wrap">
            <ArrowUpCircle className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
            <span>{t(locale, "update.title")}</span>
            {statusBadge && (
              <span
                data-testid="app-update-status-badge"
                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${statusBadge.cls}`}
              >
                {statusBadge.label}
              </span>
            )}
            {appUpdate.isDevMode && (
              <span
                data-testid="app-update-dev-badge"
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300"
              >
                {t(locale, "update.devModeBadge")}
              </span>
            )}
          </h3>
          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-0.5">
            {t(locale, "update.desc")}
          </p>
        </div>

        <button
          type="button"
          data-testid="app-update-check-btn"
          disabled={isChecking || isDownloading}
          onClick={() => onCheckForUpdates?.()}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shrink-0"
        >
          <RefreshCw className={`w-3 h-3 ${isChecking ? "animate-spin" : ""}`} />
          <span>
            {isChecking ? t(locale, "update.checkingBtn") : t(locale, "update.checkBtn")}
          </span>
        </button>
      </div>

      <div className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 space-y-3">
        {/* Version summary row */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="space-y-0.5 min-w-0">
            <div className="text-[10.5px] font-medium text-zinc-500 dark:text-zinc-400">
              {t(locale, "update.currentVersionLabel")}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <code
                data-testid="app-update-current-version"
                className="text-[12px] font-mono font-semibold text-zinc-900 dark:text-zinc-100"
              >
                {currentVersionDisplay}
              </code>
              <span className="px-1.5 py-0.5 rounded bg-zinc-200/70 dark:bg-zinc-800 text-[10px] font-mono text-zinc-600 dark:text-zinc-400">
                {platformLabel}
              </span>
            </div>
          </div>

          <div className="text-right space-y-0.5">
            {release && (
              <div className="text-[11px] font-mono text-zinc-700 dark:text-zinc-300">
                <span className="text-zinc-400 mr-1">{t(locale, "update.latestVersionLabel")}:</span>
                <span data-testid="app-update-latest-version" className="font-semibold">
                  {release.tagName}
                </span>
              </div>
            )}
            <div className="text-[10.5px] text-zinc-400">
              {t(locale, "update.lastChecked", {
                time: formatUpdateTimestamp(appUpdate.lastCheckedAt, locale),
              })}
            </div>
          </div>
        </div>

        {/* Dev mode info notice */}
        {appUpdate.isDevMode && (
          <div className="flex items-start gap-2 px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-800 dark:text-amber-200 leading-relaxed">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{t(locale, "update.devModeHint")}</span>
          </div>
        )}

        {/* Up-to-date message */}
        {isUpToDate && (
          <div
            data-testid="app-update-uptodate"
            className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-[11.5px] text-emerald-700 dark:text-emerald-300"
          >
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              <span>{t(locale, "update.upToDateMessage")}</span>
            </div>
            <button
              type="button"
              onClick={() => onOpenUpdateReleasePage?.(release?.htmlUrl)}
              className="inline-flex items-center gap-1 text-[11px] font-medium hover:underline cursor-pointer shrink-0"
            >
              <span>{t(locale, "update.openReleasePageBtn")}</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Release details when update is available / downloading / downloaded */}
        {release && (appUpdate.updateAvailable || isDownloading || isDownloaded) && (
          <div className="space-y-2.5 pt-1 border-t border-zinc-200/80 dark:border-zinc-800">
            {/* Release notes excerpt */}
            {release.notesExcerpt && (
              <div className="space-y-1">
                <div className="text-[10.5px] font-semibold text-zinc-500 dark:text-zinc-400">
                  {t(locale, "update.releaseNotesTitle")}
                </div>
                <pre
                  data-testid="app-update-release-notes"
                  className="text-[11px] font-sans whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300 bg-white/90 dark:bg-zinc-950/70 border border-zinc-200/80 dark:border-zinc-800 rounded-lg p-2.5 max-h-36 overflow-y-auto leading-relaxed"
                >
                  {release.notesExcerpt}
                </pre>
              </div>
            )}

            {/* Selected installer asset info */}
            {asset ? (
              <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-600 dark:text-zinc-300">
                <span className="text-zinc-400 shrink-0">
                  {t(locale, "update.selectedAssetLabel")}:
                </span>
                <span
                  data-testid="app-update-selected-asset"
                  className="font-mono truncate"
                  title={asset.name}
                >
                  {asset.name}
                  {asset.size > 0 ? ` (${formatBytes(asset.size)})` : ""}
                </span>
              </div>
            ) : (
              <div className="px-2.5 py-2 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-800 dark:text-amber-200">
                {t(locale, "update.noAssetForPlatform", { platform: platformLabel })}
              </div>
            )}

            {/* Download progress bar */}
            {isDownloading && progress && (
              <div data-testid="app-update-progress" className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-indigo-600 dark:text-indigo-300 font-medium tabular-nums">
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {progress.percent !== null && progress.totalBytes
                      ? t(locale, "update.downloadingProgress", {
                          percent: progress.percent,
                          downloaded: formatBytes(progress.downloadedBytes),
                          total: formatBytes(progress.totalBytes),
                        })
                      : t(locale, "update.downloadingProgressIndeterminate", {
                          downloaded: formatBytes(progress.downloadedBytes),
                        })}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.percent ?? undefined}
                    className={`h-full rounded-full bg-indigo-500 transition-all duration-150 ${
                      progress.percent === null ? "w-1/2 animate-pulse" : ""
                    }`}
                    style={
                      progress.percent !== null
                        ? { width: `${Math.max(2, Math.min(100, progress.percent))}%` }
                        : undefined
                    }
                  />
                </div>
              </div>
            )}

            {/* Downloaded hint */}
            {isDownloaded && (
              <div
                data-testid="app-update-downloaded-hint"
                className="px-2.5 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/25 text-[11px] text-emerald-700 dark:text-emerald-300 leading-relaxed"
              >
                {appUpdate.openedInstaller
                  ? t(locale, "update.downloadedOpenedHint")
                  : t(locale, "update.downloadedManualHint")}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex items-center gap-2 flex-wrap pt-0.5">
              {isAvailable && asset && (
                <button
                  type="button"
                  data-testid="app-update-download-btn"
                  onClick={() => onDownloadAndOpenUpdate?.()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs transition-colors cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{t(locale, "update.downloadAndOpenBtn")}</span>
                </button>
              )}

              {isDownloading && (
                <button
                  type="button"
                  data-testid="app-update-cancel-btn"
                  onClick={() => onCancelUpdateDownload?.()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] font-medium bg-zinc-200/80 dark:bg-zinc-800 hover:bg-zinc-300/80 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>{t(locale, "update.cancelDownloadBtn")}</span>
                </button>
              )}

              {isDownloaded && (
                <>
                  <button
                    type="button"
                    data-testid="app-update-open-installer-btn"
                    onClick={() => onOpenDownloadedUpdate?.()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>{t(locale, "update.openInstallerBtn")}</span>
                  </button>
                  <button
                    type="button"
                    data-testid="app-update-show-folder-btn"
                    onClick={() => onShowDownloadedUpdateInFolder?.()}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-500/60 text-zinc-700 dark:text-zinc-200 cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>{t(locale, "update.showInFolderBtn")}</span>
                  </button>
                </>
              )}

              <button
                type="button"
                data-testid="app-update-open-release-btn"
                onClick={() => onOpenUpdateReleasePage?.(release.htmlUrl)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-500/60 text-zinc-700 dark:text-zinc-200 cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>{t(locale, "update.openReleasePageBtn")}</span>
              </button>
            </div>
          </div>
        )}

        {/* Error notice with fallback button */}
        {(isError || (isDownloaded && appUpdate.errorCode === "open_failed")) && localizedError && (
          <div
            data-testid="app-update-error"
            className="p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11.5px] text-rose-700 dark:text-rose-300 space-y-2"
          >
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div className="space-y-0.5 min-w-0">
                <div>{localizedError}</div>
                {appUpdate.error && appUpdate.error !== localizedError && (
                  <div className="text-[10.5px] font-mono opacity-80 break-all">
                    {appUpdate.error}
                  </div>
                )}
              </div>
            </div>
            {isError && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onCheckForUpdates?.()}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-white dark:bg-zinc-900 border border-rose-300 dark:border-rose-700/60 hover:bg-rose-50 dark:hover:bg-rose-950/50 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>{t(locale, "common.retry")}</span>
                </button>
                <button
                  type="button"
                  data-testid="app-update-error-release-btn"
                  onClick={() => onOpenUpdateReleasePage?.(release?.htmlUrl)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:border-indigo-500/60 cursor-pointer"
                >
                  <ExternalLink className="w-3 h-3" />
                  <span>{t(locale, "update.openReleasePageBtn")}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
};

export interface LanguageSettingsSectionProps {
  preferredLanguage: PreferredLanguage;
  locale?: UiLocale;
  onChangePreferredLanguage?: (language: PreferredLanguage) => void;
}

export const LanguageSettingsSection: React.FC<LanguageSettingsSectionProps> = ({
  preferredLanguage,
  locale,
  onChangePreferredLanguage,
}) => {
  const activeLocale = locale ?? resolveUiLocale(preferredLanguage);
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
          <Globe className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span>{t(activeLocale, "settings.languageTitle")}</span>
        </h3>
        <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-0.5">
          {t(activeLocale, "settings.languageDesc")}
        </p>
      </div>

      <div className="space-y-2">
        {LANGUAGE_OPTIONS.map((opt) => {
          const active = preferredLanguage === opt.id;
          const meta = getLocalizedLanguageOptionMeta(opt.id, activeLocale);
          return (
            <button
              key={opt.id}
              type="button"
              data-testid={`preferred-language-${opt.id}`}
              aria-pressed={active}
              onClick={() => onChangePreferredLanguage?.(opt.id)}
              className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer ${
                active
                  ? "bg-indigo-500/10 border-indigo-500/60 ring-1 ring-indigo-500/30"
                  : "bg-zinc-50/70 dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-4 h-4 rounded-full flex items-center justify-center border ${
                      active
                        ? "bg-indigo-500 border-indigo-500 text-white"
                        : "border-zinc-300 dark:border-zinc-600"
                    }`}
                  >
                    {active && <Check className="w-2.5 h-2.5" />}
                  </span>
                  <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                    {meta.label}
                  </span>
                  <code className="text-[10.5px] px-1.5 py-0.5 rounded bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                    {opt.id}
                  </code>
                </div>
              </div>
              <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-1.5 pl-6 leading-relaxed">
                {meta.description}
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
};

export interface RemoteAccessSettingsSectionProps {
  remoteAccess: RemoteAccessStatus;
  locale?: UiLocale;
  onSetRemoteAccessEnabled?: (enabled: boolean) => void;
  onSetRemoteAccessPort?: (port: number) => void;
  onRegenerateRemoteAccessToken?: () => void;
  onRefreshRemoteAccessStatus?: () => void;
}

export const RemoteAccessSettingsSection: React.FC<RemoteAccessSettingsSectionProps> = ({
  remoteAccess,
  locale = "ja",
  onSetRemoteAccessEnabled,
  onSetRemoteAccessPort,
  onRegenerateRemoteAccessToken,
  onRefreshRemoteAccessStatus,
}) => {
  const [portDraft, setPortDraft] = useState(String(remoteAccess.port || 4789));
  const [showToken, setShowToken] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    setPortDraft(String(remoteAccess.port || 4789));
  }, [remoteAccess.port]);

  const copyText = (key: string, value: string | null | undefined) => {
    if (!value) return;
    void navigator.clipboard?.writeText(value);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1800);
  };

  const applyPort = () => {
    const num = Number(portDraft.trim());
    if (Number.isInteger(num) && num >= 1 && num <= 65535) {
      onSetRemoteAccessPort?.(num);
    } else {
      setPortDraft(String(remoteAccess.port || 4789));
    }
  };

  const maskedToken =
    remoteAccess.token.length > 8
      ? `${remoteAccess.token.slice(0, 6)}${"•".repeat(16)}${remoteAccess.token.slice(-4)}`
      : "•".repeat(16);

  const canShowPairingQr = Boolean(remoteAccess.running && remoteAccess.connectUri);

  return (
    <section
      data-testid="remote-access-section"
      className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <Smartphone className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
            <span>{t(locale, "remote.title")}</span>
          </h3>
          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-0.5">
            {t(locale, "remote.desc")}
          </p>
        </div>
        <button
          type="button"
          data-testid="remote-access-refresh"
          onClick={() => onRefreshRemoteAccessStatus?.()}
          title={t(locale, "remote.refreshTitle")}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 cursor-pointer shrink-0"
        >
          <RefreshCw className="w-3 h-3" />
          <span>{t(locale, "remote.refreshBtn")}</span>
        </button>
      </div>

      {/* Opt-in Enable Toggle */}
      <button
        type="button"
        role="switch"
        aria-checked={remoteAccess.enabled}
        data-testid="remote-access-toggle"
        onClick={() => onSetRemoteAccessEnabled?.(!remoteAccess.enabled)}
        className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer flex items-start justify-between gap-3 ${
          remoteAccess.enabled
            ? "bg-emerald-500/8 border-emerald-500/40 ring-1 ring-emerald-500/20"
            : "bg-zinc-50/70 dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
        }`}
      >
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
              {t(locale, "remote.toggleTitle")}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                remoteAccess.running
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : remoteAccess.error
                    ? "bg-red-500/15 text-red-600 dark:text-red-300"
                    : "bg-zinc-200/80 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
              }`}
            >
              {remoteAccess.running
                ? t(locale, "remote.statusRunning", { count: remoteAccess.connectedClients })
                : remoteAccess.error
                  ? t(locale, "remote.statusError")
                  : t(locale, "remote.statusStopped")}
            </span>
          </div>
          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {t(locale, "remote.toggleDescBeforeCode")}
            <code className="font-mono text-[10.5px]">0.0.0.0:{remoteAccess.port}</code>
            {t(locale, "remote.toggleDescAfterCode")}
          </p>
        </div>
        <span
          aria-hidden="true"
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors mt-0.5 ${
            remoteAccess.enabled ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
              remoteAccess.enabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </span>
      </button>

      {remoteAccess.error && (
        <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-[11.5px] text-red-600 dark:text-red-300">
          {remoteAccess.error}
        </div>
      )}

      {/* 2-Step Android QR Quick Setup */}
      <div
        data-testid="remote-access-qr-panel"
        className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 space-y-3"
      >
        <div className="flex items-start gap-2">
          <QrCode className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h4 className="text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
              {t(locale, "remote.qrHeading")}
            </h4>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
              {t(locale, "remote.qrSubheading")}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Step 1: Android APK Download QR */}
          <div
            data-testid="remote-access-qr-download-card"
            className="flex flex-col justify-between gap-2.5 p-3 rounded-xl bg-white dark:bg-zinc-950/80 border border-zinc-200 dark:border-zinc-800"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-indigo-500/12 text-indigo-600 dark:text-indigo-300">
                  <Download className="w-2.5 h-2.5" />
                  <span>{t(locale, "remote.step1Badge")}</span>
                </span>
                <span className="text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
                  {t(locale, "remote.step1Title")}
                </span>
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                {t(locale, "remote.step1Desc")}
              </p>
            </div>

            <div className="flex justify-center py-1">
              <QrCodeSvg
                value={ANDROID_APK_DOWNLOAD_URL}
                size={136}
                ariaLabel={t(locale, "remote.step1QrAria")}
                testId="remote-access-qr-download"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <code
                data-testid="remote-access-apk-url"
                title={ANDROID_APK_DOWNLOAD_URL}
                className="flex-1 min-w-0 truncate px-2 py-1 rounded-md bg-zinc-100/90 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800 font-mono text-[10px] text-zinc-600 dark:text-zinc-300"
              >
                {ANDROID_APK_DOWNLOAD_URL}
              </code>
              <button
                type="button"
                data-testid="remote-access-apk-copy"
                onClick={() => copyText("apkUrl", ANDROID_APK_DOWNLOAD_URL)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10.5px] font-medium bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-500/60 text-zinc-700 dark:text-zinc-200 cursor-pointer shrink-0"
              >
                {copiedKey === "apkUrl" ? (
                  <Check className="w-3 h-3 text-emerald-500" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                <span>
                  {copiedKey === "apkUrl"
                    ? t(locale, "remote.copiedBtn")
                    : t(locale, "remote.step1CopyUrl")}
                </span>
              </button>
            </div>
          </div>

          {/* Step 2: Desktop Pairing QR */}
          <div
            data-testid="remote-access-qr-pair-card"
            className="flex flex-col justify-between gap-2.5 p-3 rounded-xl bg-white dark:bg-zinc-950/80 border border-zinc-200 dark:border-zinc-800"
          >
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-500/12 text-emerald-700 dark:text-emerald-300">
                  <Link2 className="w-2.5 h-2.5" />
                  <span>{t(locale, "remote.step2Badge")}</span>
                </span>
                <span className="text-[12px] font-semibold text-zinc-900 dark:text-zinc-100">
                  {t(locale, "remote.step2Title")}
                </span>
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                {canShowPairingQr
                  ? t(locale, "remote.step2DescActive")
                  : t(locale, "remote.step2DisabledDesc")}
              </p>
            </div>

            {canShowPairingQr && remoteAccess.connectUri ? (
              <>
                <div className="flex justify-center py-1">
                  <QrCodeSvg
                    value={remoteAccess.connectUri}
                    size={136}
                    ariaLabel={t(locale, "remote.step2QrAria")}
                    testId="remote-access-qr-pair"
                  />
                </div>
                <div className="space-y-1">
                  {!remoteAccess.tailscaleIp && (
                    <div
                      data-testid="remote-access-qr-tailscale-warning"
                      className="flex items-start gap-1.5 px-2 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[10px] text-amber-700 dark:text-amber-300 leading-snug"
                    >
                      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                      <span>{t(locale, "remote.step2TailscaleWarning")}</span>
                    </div>
                  )}
                  <p className="text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
                    {t(locale, "remote.step2TokenHint")}
                  </p>
                </div>
              </>
            ) : (
              <div
                data-testid="remote-access-qr-pair-disabled"
                className="flex-1 flex flex-col items-center justify-center gap-2.5 py-4 px-3 rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-900/50 text-center"
              >
                <QrCode className="w-8 h-8 text-zinc-400 dark:text-zinc-600" />
                <button
                  type="button"
                  data-testid="remote-access-qr-enable-btn"
                  onClick={() => onSetRemoteAccessEnabled?.(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors cursor-pointer"
                >
                  <Power className="w-3.5 h-3.5" />
                  <span>{t(locale, "remote.step2EnableBtn")}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Connection Details Box */}
      <div className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 space-y-3">
        {/* Port & Tailscale Info */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label
              htmlFor="remote-access-port"
              className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
            >
              {t(locale, "remote.portLabel")}
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id="remote-access-port"
                data-testid="remote-access-port-input"
                type="number"
                min={1}
                max={65535}
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyPort();
                }}
                className="w-28 px-2.5 py-1 rounded-lg text-[12px] font-mono bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 outline-none focus:border-indigo-500/60"
              />
              <button
                type="button"
                data-testid="remote-access-port-apply"
                onClick={applyPort}
                className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium bg-zinc-200/80 dark:bg-zinc-800 hover:bg-zinc-300/80 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 cursor-pointer"
              >
                {t(locale, "remote.applyBtn")}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              {t(locale, "remote.tailscaleDetection")}
            </div>
            <div className="text-[11.5px] font-mono text-zinc-800 dark:text-zinc-200 space-y-0.5">
              <div>
                IPv4:{" "}
                <span data-testid="remote-access-tailscale-ip">
                  {remoteAccess.tailscaleIp ?? t(locale, "remote.notDetected")}
                </span>
              </div>
              {remoteAccess.magicDnsName && (
                <div className="text-[10.5px] text-zinc-500 dark:text-zinc-400 truncate">
                  MagicDNS: {remoteAccess.magicDnsName}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Connection URL */}
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
            {t(locale, "remote.urlLabel")}
          </div>
          <div className="flex items-center gap-1.5">
            <code
              data-testid="remote-access-url"
              className="flex-1 min-w-0 truncate px-2.5 py-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 font-mono text-[11.5px] text-zinc-800 dark:text-zinc-200"
            >
              {remoteAccess.url ?? `http://<tailscale-ip>:${remoteAccess.port}`}
            </code>
            <button
              type="button"
              onClick={() => copyText("url", remoteAccess.url)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-500/60 cursor-pointer shrink-0"
            >
              {copiedKey === "url" ? (
                <Check className="w-3 h-3 text-emerald-500" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              <span>
                {copiedKey === "url" ? t(locale, "remote.copiedBtn") : t(locale, "remote.copyBtn")}
              </span>
            </button>
          </div>
          {remoteAccess.magicDnsUrl && remoteAccess.magicDnsUrl !== remoteAccess.url && (
            <div className="flex items-center justify-between gap-2 text-[10.5px] text-zinc-500 dark:text-zinc-400 font-mono">
              <span className="truncate">MagicDNS URL: {remoteAccess.magicDnsUrl}</span>
              <button
                type="button"
                onClick={() => copyText("magicdns", remoteAccess.magicDnsUrl)}
                className="text-indigo-500 hover:underline shrink-0 cursor-pointer"
              >
                {copiedKey === "magicdns"
                  ? t(locale, "remote.copiedBtn")
                  : t(locale, "remote.copyBtn")}
              </button>
            </div>
          )}
        </div>

        {/* Bearer Token */}
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
            {t(locale, "remote.bearerTokenLabel")}
          </div>
          <div className="flex items-center gap-1.5">
            <code
              data-testid="remote-access-token"
              className="flex-1 min-w-0 truncate px-2.5 py-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 font-mono text-[11.5px] text-zinc-800 dark:text-zinc-200"
            >
              {showToken ? remoteAccess.token : maskedToken}
            </code>
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              aria-label={
                showToken ? t(locale, "remote.hideTokenAria") : t(locale, "remote.showTokenAria")
              }
              className="p-1.5 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-500/60 cursor-pointer shrink-0"
            >
              {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={() => copyText("token", remoteAccess.token)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:border-indigo-500/60 cursor-pointer shrink-0"
            >
              {copiedKey === "token" ? (
                <Check className="w-3 h-3 text-emerald-500" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              <span>
                {copiedKey === "token"
                  ? t(locale, "remote.copiedBtn")
                  : t(locale, "remote.copyBtn")}
              </span>
            </button>
            <button
              type="button"
              data-testid="remote-access-regenerate-token"
              onClick={() => onRegenerateRemoteAccessToken?.()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer shrink-0"
            >
              <RefreshCw className="w-3 h-3" />
              <span>{t(locale, "remote.regenerateBtn")}</span>
            </button>
          </div>
        </div>

        {/* One-Paste Android Connection URI */}
        {remoteAccess.connectUri && (
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              {t(locale, "remote.connectUriLabel")}
            </div>
            <div className="flex items-center gap-1.5">
              <code
                data-testid="remote-access-connect-uri"
                className="flex-1 min-w-0 truncate px-2.5 py-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 font-mono text-[11px] text-indigo-600 dark:text-indigo-300"
              >
                {showToken
                  ? remoteAccess.connectUri
                  : remoteAccess.connectUri.replace(/token=[^&]+/, "token=••••••••")}
              </code>
              <button
                type="button"
                onClick={() => copyText("uri", remoteAccess.connectUri)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 cursor-pointer shrink-0"
              >
                {copiedKey === "uri" ? (
                  <Check className="w-3 h-3" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
                <span>
                  {copiedKey === "uri"
                    ? t(locale, "remote.copiedBtn")
                    : t(locale, "remote.copyUriBtn")}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

export interface VoiceSettingsSectionProps {
  voiceReadbackEnabled: boolean;
  voiceAutoSend: boolean;
  locale?: UiLocale;
  onSetVoiceReadbackEnabled?: (enabled: boolean) => void;
  onSetVoiceAutoSend?: (enabled: boolean) => void;
}

export const VoiceSettingsSection: React.FC<VoiceSettingsSectionProps> = ({
  voiceReadbackEnabled,
  voiceAutoSend,
  locale = "ja",
  onSetVoiceReadbackEnabled,
  onSetVoiceAutoSend,
}) => (
  <section
    data-testid="voice-settings-section"
    className="space-y-2.5 border-t border-zinc-200 dark:border-zinc-800 pt-5"
  >
    <div>
      <h3 className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
        <Volume2 className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
        <span>{t(locale, "settings.voiceTitle")}</span>
      </h3>
      <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-0.5">
        {t(locale, "settings.voiceDescBeforeKbd")}
        <kbd className="px-1 py-0.5 rounded bg-zinc-200/80 dark:bg-zinc-800 font-mono text-[10.5px]">
          ⌥Space
        </kbd>
        {t(locale, "settings.voiceDescBetweenKbdAndCode")}
        <code className="font-mono text-[10.5px]">say</code>
        {t(locale, "settings.voiceDescAfterCode")}
      </p>
    </div>

    <div className="space-y-2">
      {/* Voice Readback (TTS) Toggle */}
      <button
        type="button"
        role="switch"
        aria-checked={voiceReadbackEnabled}
        data-testid="voice-readback-toggle"
        onClick={() => onSetVoiceReadbackEnabled?.(!voiceReadbackEnabled)}
        className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer flex items-start justify-between gap-3 ${
          voiceReadbackEnabled
            ? "bg-indigo-500/10 border-indigo-500/50 ring-1 ring-indigo-500/25"
            : "bg-zinc-50/70 dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
        }`}
      >
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <Volume2 className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
            <span className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
              {t(locale, "settings.voiceReadbackTitle")}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                voiceReadbackEnabled
                  ? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
                  : "bg-zinc-200/80 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
              }`}
            >
              {voiceReadbackEnabled ? "ON" : "OFF"}
            </span>
          </div>
          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 leading-relaxed pl-5">
            {t(locale, "settings.voiceReadbackDescBeforeCode")}
            <code className="font-mono text-[10.5px]">say</code>
            {t(locale, "settings.voiceReadbackDescAfterCode")}
          </p>
        </div>
        <span
          aria-hidden="true"
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors mt-0.5 ${
            voiceReadbackEnabled ? "bg-indigo-500" : "bg-zinc-300 dark:bg-zinc-700"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
              voiceReadbackEnabled ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </span>
      </button>

      {/* Auto-send on speech end Toggle */}
      <button
        type="button"
        role="switch"
        aria-checked={voiceAutoSend}
        data-testid="voice-autosend-toggle"
        onClick={() => onSetVoiceAutoSend?.(!voiceAutoSend)}
        className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer flex items-start justify-between gap-3 ${
          voiceAutoSend
            ? "bg-emerald-500/8 border-emerald-500/40 ring-1 ring-emerald-500/20"
            : "bg-zinc-50/70 dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
        }`}
      >
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <Mic className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            <span className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
              {t(locale, "settings.voiceAutoSendTitle")}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                voiceAutoSend
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "bg-zinc-200/80 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
              }`}
            >
              {voiceAutoSend ? "ON" : "OFF"}
            </span>
          </div>
          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 leading-relaxed pl-5">
            {t(locale, "settings.voiceAutoSendDesc")}
          </p>
        </div>
        <span
          aria-hidden="true"
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors mt-0.5 ${
            voiceAutoSend ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
              voiceAutoSend ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </span>
      </button>
    </div>
  </section>
);

export const SettingsModal: React.FC<SettingsModalProps> = ({
  defaultIntegrationMode,
  autoLandOnComplete = true,
  preferredLanguage = DEFAULT_PREFERRED_LANGUAGE,
  voiceReadbackEnabled = DEFAULT_VOICE_READBACK_ENABLED,
  voiceAutoSend = DEFAULT_VOICE_AUTO_SEND,
  remoteAccess,
  locale,
  projects,
  initialTab = "general",
  usageRecords = [],
  usageBudgets,
  providerQuotas,
  onClearUsage,
  onUpdateUsageBudgets,
  onRefreshProviderQuotas,
  onClose,
  onSetDefaultIntegrationMode,
  onSetAutoLandOnComplete,
  onSetProjectIntegrationMode,
  onChangePreferredLanguage,
  onSetVoiceReadbackEnabled,
  onSetVoiceAutoSend,
  onSetRemoteAccessEnabled,
  onSetRemoteAccessPort,
  onRegenerateRemoteAccessToken,
  onRefreshRemoteAccessStatus,
  appUpdate,
  onCheckForUpdates,
  onDownloadAndOpenUpdate,
  onCancelUpdateDownload,
  onOpenDownloadedUpdate,
  onShowDownloadedUpdateInFolder,
  onOpenUpdateReleasePage,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsModalTab>(initialTab);
  const [projectSearch, setProjectSearch] = useState("");
  const activeLocale = locale ?? resolveUiLocale(preferredLanguage);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    onRefreshRemoteAccessStatus?.();
  }, []);

  useEffect(() => {
    if (activeTab === "usage") {
      void onRefreshProviderQuotas?.();
    }
  }, [activeTab]);

  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [projects, projectSearch]);

  const integrationOptions = useMemo(
    () => getIntegrationModeOptions(activeLocale),
    [activeLocale],
  );
  const globalOption = getIntegrationModeOption(defaultIntegrationMode, activeLocale);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-6"
      onClick={onClose}
    >
      <div
        className={`w-full ${
          activeTab === "usage" ? "max-w-3xl" : "max-w-2xl"
        } max-h-[84vh] flex flex-col rounded-2xl bg-white dark:bg-[#161a22] border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800">
          {activeTab === "usage" ? (
            <BarChart3 className="w-4 h-4 text-indigo-500 shrink-0" />
          ) : (
            <Settings className="w-4 h-4 text-indigo-500 shrink-0" />
          )}
          <h2 className="text-[15px] font-semibold">
            {activeTab === "usage"
              ? t(activeLocale, "settings.usageTabTitle")
              : t(activeLocale, "settings.title")}
          </h2>

          <div className="flex-1 flex items-center justify-end gap-2">
            <div
              role="tablist"
              aria-label={t(activeLocale, "settings.tabsAria")}
              className="inline-flex items-center p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-800"
            >
              <button
                type="button"
                role="tab"
                data-testid="settings-tab-general"
                aria-selected={activeTab === "general"}
                onClick={() => setActiveTab("general")}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-colors cursor-pointer ${
                  activeTab === "general"
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                <Settings className="w-3 h-3" />
                <span>{t(activeLocale, "settings.generalTab")}</span>
              </button>
              <button
                type="button"
                role="tab"
                data-testid="settings-tab-usage"
                aria-selected={activeTab === "usage"}
                onClick={() => setActiveTab("usage")}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-colors cursor-pointer ${
                  activeTab === "usage"
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200"
                }`}
              >
                <BarChart3 className="w-3 h-3" />
                <span>{t(activeLocale, "settings.usageTabTitle")}</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label={t(activeLocale, "settings.closeAria")}
              className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6 select-text">
          {activeTab === "usage" ? (
            <UsagePanel
              usageRecords={usageRecords}
              usageBudgets={usageBudgets}
              providerQuotas={providerQuotas}
              locale={activeLocale}
              onClearUsage={onClearUsage}
              onUpdateBudgets={onUpdateUsageBudgets}
              onRefreshProviderQuotas={onRefreshProviderQuotas}
            />
          ) : (
            <>
              {/* App Updates (GitHub Releases) */}
              {appUpdate && (
                <div className="border-b border-zinc-200 dark:border-zinc-800 pb-5">
                  <AppUpdateSettingsSection
                    appUpdate={appUpdate}
                    locale={activeLocale}
                    onCheckForUpdates={onCheckForUpdates}
                    onDownloadAndOpenUpdate={onDownloadAndOpenUpdate}
                    onCancelUpdateDownload={onCancelUpdateDownload}
                    onOpenDownloadedUpdate={onOpenDownloadedUpdate}
                    onShowDownloadedUpdateInFolder={onShowDownloadedUpdateInFolder}
                    onOpenUpdateReleasePage={onOpenUpdateReleasePage}
                  />
                </div>
              )}

              {/* Output Language Preference */}
              <LanguageSettingsSection
                preferredLanguage={preferredLanguage}
                locale={activeLocale}
                onChangePreferredLanguage={onChangePreferredLanguage}
              />

              {/* Voice Input & Readback (OS-Standard Zero-Cost) */}
              <VoiceSettingsSection
                voiceReadbackEnabled={voiceReadbackEnabled}
                voiceAutoSend={voiceAutoSend}
                locale={activeLocale}
                onSetVoiceReadbackEnabled={onSetVoiceReadbackEnabled}
                onSetVoiceAutoSend={onSetVoiceAutoSend}
              />

              {/* Remote Access / Tailscale Mobile Bridge */}
              {remoteAccess && (
                <RemoteAccessSettingsSection
                  remoteAccess={remoteAccess}
                  locale={activeLocale}
                  onSetRemoteAccessEnabled={onSetRemoteAccessEnabled}
                  onSetRemoteAccessPort={onSetRemoteAccessPort}
                  onRegenerateRemoteAccessToken={onRegenerateRemoteAccessToken}
                  onRefreshRemoteAccessStatus={onRefreshRemoteAccessStatus}
                />
              )}

          {/* Global Default Integration Mode */}
          <section className="space-y-2.5 border-t border-zinc-200 dark:border-zinc-800 pt-5">
            <div>
              <h3 className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                {t(activeLocale, "settings.integrationTitle")}
              </h3>
              <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                {t(activeLocale, "settings.integrationDesc")}
              </p>
            </div>

            <div className="space-y-2">
              {integrationOptions.map((opt) => {
                const active = defaultIntegrationMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    data-testid={`integration-mode-${opt.id}`}
                    onClick={() => onSetDefaultIntegrationMode(opt.id)}
                    className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer ${
                      active
                        ? "bg-indigo-500/10 border-indigo-500/60 ring-1 ring-indigo-500/30"
                        : "bg-zinc-50/70 dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-4 h-4 rounded-full flex items-center justify-center border ${
                            active
                              ? "bg-indigo-500 border-indigo-500 text-white"
                              : "border-zinc-300 dark:border-zinc-600"
                          }`}
                        >
                          {active && <Check className="w-2.5 h-2.5" />}
                        </span>
                        <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
                          {opt.label}
                        </span>
                        <code className="text-[10.5px] px-1.5 py-0.5 rounded bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">
                          {opt.id}
                        </code>
                      </div>
                    </div>
                    <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-1.5 pl-6 leading-relaxed">
                      {opt.description}
                    </p>
                  </button>
                );
              })}
            </div>
            {/* Auto-Land on Worker Completion Toggle */}
            <div className="pt-2">
              <button
                type="button"
                role="switch"
                aria-checked={autoLandOnComplete}
                data-testid="auto-land-toggle"
                onClick={() => onSetAutoLandOnComplete?.(!autoLandOnComplete)}
                className={`w-full text-left p-3 rounded-xl border transition-all cursor-pointer flex items-start justify-between gap-3 ${
                  autoLandOnComplete
                    ? "bg-emerald-500/8 border-emerald-500/40 ring-1 ring-emerald-500/20"
                    : "bg-zinc-50/70 dark:bg-zinc-900/50 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700"
                }`}
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                      {t(activeLocale, "settings.autoLandTitle")}
                    </span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                        autoLandOnComplete
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                          : "bg-zinc-200/80 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
                      }`}
                    >
                      {autoLandOnComplete ? "ON" : "OFF"}
                    </span>
                  </div>
                  <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                    {t(activeLocale, "settings.autoLandDesc")}
                  </p>
                </div>
                <span
                  aria-hidden="true"
                  className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors mt-0.5 ${
                    autoLandOnComplete ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700"
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                      autoLandOnComplete ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </span>
              </button>
            </div>
          </section>

          {/* Per-Project Override */}
          <section className="space-y-2.5 border-t border-zinc-200 dark:border-zinc-800 pt-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                  {t(activeLocale, "settings.perProjectTitle")}
                </h3>
                <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {t(activeLocale, "settings.perProjectDescBefore")}
                  <code className="font-mono text-[10.5px]">.conductor.json</code>
                  {t(activeLocale, "settings.perProjectDescAfter")}
                </p>
              </div>
            </div>

            {projects.length > 5 && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                  placeholder={t(activeLocale, "settings.filterProjectsPlaceholder")}
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg text-[12px] bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 outline-none focus:border-indigo-500/60"
                />
              </div>
            )}

            {filteredProjects.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-4 text-center text-[12px] text-zinc-400">
                {t(activeLocale, "settings.noProjects")}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto pr-0.5">
                {filteredProjects.map((proj) => (
                  <div
                    key={proj.id}
                    className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800/80"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: proj.colorHex }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[12.5px] font-medium text-zinc-900 dark:text-zinc-100 truncate">
                          {proj.name}
                        </span>
                        {proj.gitBranch && (
                          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-zinc-200/70 dark:bg-zinc-800 font-mono text-[10px] text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[140px] truncate">
                            <GitBranch className="w-2.5 h-2.5 shrink-0" />
                            <span className="truncate">{proj.gitBranch}</span>
                          </span>
                        )}
                      </div>
                      <div className="text-[10.5px] font-mono text-zinc-400 truncate">
                        {proj.path}
                      </div>
                    </div>
                    <select
                      data-testid={`project-mode-${proj.id}`}
                      aria-label={t(activeLocale, "settings.projectModeAria", { name: proj.name })}
                      value={proj.integrationMode ?? ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        onSetProjectIntegrationMode(
                          proj.id,
                          val === "" ? null : (val as IntegrationMode),
                        );
                      }}
                      className="text-[11.5px] rounded-lg px-2 py-1 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 outline-none focus:border-indigo-500/60 shrink-0 cursor-pointer"
                    >
                      <option value="">
                        {t(activeLocale, "settings.defaultModeOption", {
                          mode: globalOption.shortLabel,
                        })}
                      </option>
                      {integrationOptions.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.shortLabel}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            )}
          </section>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/40">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors cursor-pointer"
          >
            {t(activeLocale, "common.close")}
          </button>
        </div>
      </div>
    </div>
  );
};
