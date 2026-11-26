import React, { useEffect, useMemo, useState } from "react";
import { BarChart3, Check, GitBranch, Globe, Search, Settings, X } from "lucide-react";
import { DEFAULT_PREFERRED_LANGUAGE, LANGUAGE_OPTIONS } from "../../shared/language.js";
import type {
  IntegrationMode,
  PreferredLanguage,
  Project,
  UsageRecord,
} from "../../shared/types.js";
import {
  getIntegrationModeOption,
  INTEGRATION_MODE_OPTIONS,
} from "../lib/integration-mode.js";
import { UsagePanel } from "./UsagePanel.js";

export type SettingsModalTab = "general" | "usage";

export interface SettingsModalProps {
  defaultIntegrationMode: IntegrationMode;
  autoLandOnComplete?: boolean;
  preferredLanguage?: PreferredLanguage;
  projects: Project[];
  initialTab?: SettingsModalTab;
  usageRecords?: UsageRecord[];
  onClearUsage?: () => void;
  onClose: () => void;
  onSetDefaultIntegrationMode: (mode: IntegrationMode) => void;
  onSetAutoLandOnComplete?: (enabled: boolean) => void;
  onSetProjectIntegrationMode: (projectId: string, mode: IntegrationMode | null) => void;
  onChangePreferredLanguage?: (language: PreferredLanguage) => void;
}

export interface LanguageSettingsSectionProps {
  preferredLanguage: PreferredLanguage;
  onChangePreferredLanguage?: (language: PreferredLanguage) => void;
}

export const LanguageSettingsSection: React.FC<LanguageSettingsSectionProps> = ({
  preferredLanguage,
  onChangePreferredLanguage,
}) => (
  <section className="space-y-2.5">
    <div>
      <h3 className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
        <Globe className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
        <span>言語設定 / Output Language</span>
      </h3>
      <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-0.5">
        チャット返信、タスクのタイトル・要約、ワーカーの完了レポートの出力言語を指定します。
      </p>
    </div>

    <div className="space-y-2">
      {LANGUAGE_OPTIONS.map((opt) => {
        const active = preferredLanguage === opt.id;
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
  </section>
);

export const SettingsModal: React.FC<SettingsModalProps> = ({
  defaultIntegrationMode,
  autoLandOnComplete = true,
  preferredLanguage = DEFAULT_PREFERRED_LANGUAGE,
  projects,
  initialTab = "general",
  usageRecords = [],
  onClearUsage,
  onClose,
  onSetDefaultIntegrationMode,
  onSetAutoLandOnComplete,
  onSetProjectIntegrationMode,
  onChangePreferredLanguage,
}) => {
  const [activeTab, setActiveTab] = useState<SettingsModalTab>(initialTab);
  const [projectSearch, setProjectSearch] = useState("");

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const filteredProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
    );
  }, [projects, projectSearch]);

  const globalOption = getIntegrationModeOption(defaultIntegrationMode);

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
            {activeTab === "usage" ? "Usage / API利用料" : "Conductor 設定"}
          </h2>

          <div className="flex-1 flex items-center justify-end gap-2">
            <div
              role="tablist"
              aria-label="設定タブ"
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
                <span>一般設定</span>
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
                <span>Usage / API利用料</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="設定を閉じる"
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
                onChangePreferredLanguage={onChangePreferredLanguage}
              />

          {/* Global Default Integration Mode */}
          <section className="space-y-2.5 border-t border-zinc-200 dark:border-zinc-800 pt-5">
            <div>
              <h3 className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                Git Worktree 統合モード（グローバル既定）
              </h3>
              <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                ワーカーは各タスク専用の Git Worktree で並列実行されます。完了後の取り込み方式を選択してください。
              </p>
            </div>

            <div className="space-y-2">
              {INTEGRATION_MODE_OPTIONS.map((opt) => {
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
                      ワーカー完了時に自動 Land（コンフリクト時は AI が自力解消）
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
                    feature-branch / direct モード時、タスク完了後に自動で取り込みを実行します。コンフリクトが発生した場合は最大2回までワーカーが自動で解消を試みます（per-task-pr モードは手動 Push/PR のまま維持）。
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
                  プロジェクトごとの個別設定
                </h3>
                <p className="text-[11.5px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                  特定のプロジェクトだけ統合モードを上書きできます（未設定時はプロジェクト直下の{" "}
                  <code className="font-mono text-[10.5px]">.conductor.json</code>{" "}
                  またはグローバル既定を使用）。
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
                  placeholder="プロジェクトを絞り込む..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg text-[12px] bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 outline-none focus:border-indigo-500/60"
                />
              </div>
            )}

            {filteredProjects.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-4 text-center text-[12px] text-zinc-400">
                対象のプロジェクトがありません
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
                      aria-label={`${proj.name} の統合モード`}
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
                      <option value="">既定 ({globalOption.shortLabel})</option>
                      {INTEGRATION_MODE_OPTIONS.map((opt) => (
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
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
};
