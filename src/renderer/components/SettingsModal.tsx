import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Check,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  Globe,
  Mic,
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
import type {
  IntegrationMode,
  PreferredLanguage,
  Project,
  RemoteAccessStatus,
  UsageRecord,
} from "../../shared/types.js";
import {
  DEFAULT_VOICE_AUTO_SEND,
  DEFAULT_VOICE_READBACK_ENABLED,
} from "../../shared/voice.js";
import {
  getIntegrationModeOption,
  getIntegrationModeOptions,
} from "../lib/integration-mode.js";
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
  onClearUsage?: () => void;
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
}

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
  onSetRemoteAccessEnabled?: (enabled: boolean) => void;
  onSetRemoteAccessPort?: (port: number) => void;
  onRegenerateRemoteAccessToken?: () => void;
  onRefreshRemoteAccessStatus?: () => void;
}

export const RemoteAccessSettingsSection: React.FC<RemoteAccessSettingsSectionProps> = ({
  remoteAccess,
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

  return (
    <section
      data-testid="remote-access-section"
      className="space-y-3 border-t border-zinc-200 dark:border-zinc-800 pt-5"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <Smartphone className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
            <span>リモートアクセス / Tailscale Mobile Bridge</span>
          </h3>
          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-0.5">
            Tailscale 経由で Android アプリやモバイルブラウザから Conductor のチャット・タスクをリアルタイム操作します。
          </p>
        </div>
        <button
          type="button"
          data-testid="remote-access-refresh"
          onClick={() => onRefreshRemoteAccessStatus?.()}
          title="Tailscale ネットワーク情報を再検出"
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/70 dark:hover:bg-zinc-800 cursor-pointer shrink-0"
        >
          <RefreshCw className="w-3 h-3" />
          <span>再検出</span>
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
              Remote Bridge サーバーを有効化
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
                ? `稼働中 · SSE ${remoteAccess.connectedClients}台`
                : remoteAccess.error
                  ? "エラー"
                  : "停止中"}
            </span>
          </div>
          <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
            ON の間のみ <code className="font-mono text-[10.5px]">0.0.0.0:{remoteAccess.port}</code>{" "}
            で待受し、すべての API に Bearer Token 認証を必須とします。
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

      {/* Connection Details Box */}
      <div className="p-3.5 rounded-xl bg-zinc-50/80 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 space-y-3">
        {/* Port & Tailscale Info */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label
              htmlFor="remote-access-port"
              className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400"
            >
              ポート番号（既定: 4789）
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
                適用
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              Tailscale 検出結果
            </div>
            <div className="text-[11.5px] font-mono text-zinc-800 dark:text-zinc-200 space-y-0.5">
              <div>
                IPv4:{" "}
                <span data-testid="remote-access-tailscale-ip">
                  {remoteAccess.tailscaleIp ?? "未検出"}
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
            接続 URL（Android Chrome でもそのまま開けます）
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
              <span>{copiedKey === "url" ? "コピー済み" : "コピー"}</span>
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
                {copiedKey === "magicdns" ? "コピー済み" : "コピー"}
              </button>
            </div>
          )}
        </div>

        {/* Bearer Token */}
        <div className="space-y-1">
          <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
            Bearer Token
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
              aria-label={showToken ? "トークンを隠す" : "トークンを表示"}
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
              <span>{copiedKey === "token" ? "コピー済み" : "コピー"}</span>
            </button>
            <button
              type="button"
              data-testid="remote-access-regenerate-token"
              onClick={() => onRegenerateRemoteAccessToken?.()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer shrink-0"
            >
              <RefreshCw className="w-3 h-3" />
              <span>再生成</span>
            </button>
          </div>
        </div>

        {/* One-Paste Android Connection URI */}
        {remoteAccess.connectUri && (
          <div className="space-y-1">
            <div className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              Android アプリ一括接続 URI（そのまま貼り付け可能）
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
                <span>{copiedKey === "uri" ? "コピー済み" : "URI コピー"}</span>
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
  onClearUsage,
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
        className="w-full max-w-2xl max-h-[82vh] flex flex-col rounded-2xl bg-white dark:bg-[#161a22] border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden"
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
            <UsagePanel usageRecords={usageRecords} onClearUsage={onClearUsage} />
          ) : (
            <>
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
