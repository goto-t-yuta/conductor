import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Globe,
  Info,
  Loader2,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type {
  AgentTask,
  AgentTaskStatus,
  IntegrationMode,
  LandTaskResult,
  Project,
  TaskLandStatus,
  TaskWorktreeStatus,
  WorkerActivityEntry,
} from "../../shared/types.js";
import { formatTaskStatusLabel, t, type UiLocale } from "../../shared/i18n.js";
import { formatTaskCode } from "../../shared/mentions.js";
import {
  getLocalizedMarkTaskDoneBlockedReason,
  requiresLandBeforeDone,
  validateManualTaskStatusTransition,
} from "../../shared/task-status.js";
import {
  formatToolLogSummary,
  partitionTaskActivities,
} from "../lib/activity-log.js";
import {
  getEffectiveProjectMode,
  getIntegrationModeOption,
} from "../lib/integration-mode.js";
import { getQuickStatusTransition } from "../lib/task-sidebar.js";
import { MarkdownView } from "./MarkdownView.js";

export interface TaskInspectorQuickStatusButtonProps {
  task: Pick<AgentTask, "title" | "status" | "worktreePath" | "worktreeBranch" | "landStatus">;
  locale?: UiLocale;
  onUpdateStatus: (status: AgentTaskStatus) => void;
}

export const TaskInspectorQuickStatusButton: React.FC<TaskInspectorQuickStatusButtonProps> = ({
  task,
  locale = "ja",
  onUpdateStatus,
}) => {
  const quickTransition = getQuickStatusTransition(task.status, locale);
  if (!quickTransition) {
    return null;
  }

  const isDone = task.status === "done";
  const doneBlockedReason =
    quickTransition.action === "done"
      ? getLocalizedMarkTaskDoneBlockedReason(task, locale)
      : null;
  const isBlocked = Boolean(doneBlockedReason);

  return (
    <button
      type="button"
      disabled={isBlocked}
      aria-disabled={isBlocked || undefined}
      data-testid={`inspector-quick-${quickTransition.action}`}
      onClick={(e) => {
        e.stopPropagation();
        if (
          !validateManualTaskStatusTransition({
            currentStatus: task.status,
            nextStatus: quickTransition.nextStatus,
            worktreePath: task.worktreePath,
            worktreeBranch: task.worktreeBranch,
            landStatus: task.landStatus,
          }).ok
        ) {
          return;
        }
        onUpdateStatus(quickTransition.nextStatus);
      }}
      title={doneBlockedReason ?? quickTransition.title}
      aria-label={`${task.title}: ${quickTransition.label}`}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium border transition-colors shrink-0 ${
        isBlocked
          ? "bg-zinc-100 dark:bg-zinc-800/60 border-zinc-200/80 dark:border-zinc-700/70 text-zinc-400 dark:text-zinc-500 opacity-60 cursor-not-allowed"
          : isDone
            ? "bg-zinc-100 dark:bg-zinc-800/80 border-zinc-200/90 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-indigo-500/12 hover:border-indigo-500/35 hover:text-indigo-600 dark:hover:text-indigo-300 cursor-pointer"
            : "bg-emerald-500/15 border-emerald-500/35 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/25 hover:border-emerald-500/50 font-semibold cursor-pointer"
      }`}
    >
      {isDone ? <RotateCcw className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
      <span>{quickTransition.label}</span>
    </button>
  );
};

export interface TaskStatusSelectProps {
  status: AgentTaskStatus;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  landStatus?: TaskLandStatus;
  locale?: UiLocale;
  onUpdateStatus: (status: AgentTaskStatus) => void;
}

export const TaskStatusSelect: React.FC<TaskStatusSelectProps> = ({
  status,
  worktreePath,
  worktreeBranch,
  landStatus,
  locale = "ja",
  onUpdateStatus,
}) => {
  const doneBlockedReason = getLocalizedMarkTaskDoneBlockedReason(
    {
      status,
      worktreePath,
      worktreeBranch,
      landStatus,
    },
    locale,
  );
  const allowMarkDone = !doneBlockedReason;
  return (
    <select
      data-testid="inspector-status-select"
      value={status}
      aria-label={t(locale, "inspector.statusAria")}
      title={allowMarkDone ? t(locale, "inspector.statusTitle") : doneBlockedReason!}
      onChange={(e) => {
        const nextStatus = e.target.value as AgentTaskStatus;
        if (
          !validateManualTaskStatusTransition({
            currentStatus: status,
            nextStatus,
            worktreePath,
            worktreeBranch,
            landStatus,
          }).ok
        ) {
          return;
        }
        onUpdateStatus(nextStatus);
      }}
      className="text-[12px] rounded-lg px-2.5 py-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 outline-none"
    >
      <option value="queued">{formatTaskStatusLabel("queued", locale)}</option>
      <option value="running">{formatTaskStatusLabel("running", locale)}</option>
      <option value="needs_review">{formatTaskStatusLabel("needs_review", locale)}</option>
      <option
        value="done"
        data-testid="inspector-status-option-done"
        disabled={!allowMarkDone}
        title={allowMarkDone ? undefined : doneBlockedReason!}
      >
        {formatTaskStatusLabel("done", locale)}
      </option>
      <option value="failed">{formatTaskStatusLabel("failed", locale)}</option>
    </select>
  );
};

export interface TaskInspectorModalProps {
  task: AgentTask;
  project?: Project | null;
  projectColorHex: string;
  defaultIntegrationMode?: IntegrationMode;
  locale?: UiLocale;
  defaultToolLogExpanded?: boolean;
  onClose: () => void;
  onUpdateStatus: (status: AgentTaskStatus) => void;
  onOpenPreviewUrl: (url: string) => void;
  onOpenMarkdownFile?: (target: string, baseFilePath?: string) => void;
  onMentionInChat: () => void;
  onStopWorker: () => void;
  onDelete: () => void;
  onLandTask?: (options?: { createPr?: boolean }) => Promise<LandTaskResult | void> | void;
  onResolveConflictWithAI?: () => Promise<{ ok: boolean; error?: string } | void> | void;
  onCleanupWorktree?: () => Promise<void> | void;
}

export const TaskInspectorModal: React.FC<TaskInspectorModalProps> = ({
  task,
  project = null,
  projectColorHex,
  defaultIntegrationMode = "feature-branch",
  locale = "ja",
  defaultToolLogExpanded,
  onClose,
  onUpdateStatus,
  onOpenPreviewUrl,
  onOpenMarkdownFile,
  onMentionInChat,
  onStopWorker,
  onDelete,
  onLandTask,
  onResolveConflictWithAI,
  onCleanupWorktree,
}) => {
  const [gitStatus, setGitStatus] = useState<string | null>(null);
  const [worktreeStatus, setWorktreeStatus] = useState<TaskWorktreeStatus | null>(null);
  const [isRefreshingGit, setIsRefreshingGit] = useState(false);
  const [isStartingConflictResolve, setIsStartingConflictResolve] = useState(false);

  const partitionedActivities = useMemo(
    () => partitionTaskActivities(task.activities),
    [task.activities],
  );
  const [isToolLogExpanded, setIsToolLogExpanded] = useState(
    defaultToolLogExpanded ?? !partitionedActivities.defaultToolLogCollapsed,
  );

  useEffect(() => {
    setIsToolLogExpanded(
      defaultToolLogExpanded ?? !partitionedActivities.defaultToolLogCollapsed,
    );
  }, [task.id, defaultToolLogExpanded, partitionedActivities.defaultToolLogCollapsed]);

  const effectiveMode =
    worktreeStatus?.effectiveMode ?? getEffectiveProjectMode(project, defaultIntegrationMode);
  const modeOption = getIntegrationModeOption(effectiveMode, locale);
  const isLanding = task.landStatus === "landing";
  const needsLand = requiresLandBeforeDone(task);
  const hasWorktreeInfo = Boolean(
    task.worktreeBranch || task.worktreePath || task.landedBranch || task.prUrl,
  );
  const hasActiveWorktree = Boolean(task.worktreePath && task.worktreeBranch);
  const canLand =
    Boolean(onLandTask) &&
    hasActiveWorktree &&
    task.status !== "running" &&
    task.landStatus !== "landed";
  const canResolveConflictWithAI =
    Boolean(onResolveConflictWithAI) &&
    task.landStatus === "conflict" &&
    Boolean(task.worktreePath) &&
    task.status !== "running";

  const refreshGitInfo = useCallback(async () => {
    if (typeof window === "undefined" || !window.conductor) return;
    setIsRefreshingGit(true);
    try {
      const [status, wt] = await Promise.all([
        window.conductor.getTaskGitStatus(task.id),
        window.conductor.getTaskWorktreeStatus(task.id),
      ]);
      setGitStatus(status);
      setWorktreeStatus(wt);
    } finally {
      setIsRefreshingGit(false);
    }
  }, [task.id]);

  useEffect(() => {
    void refreshGitInfo();
  }, [
    refreshGitInfo,
    task.updatedAt,
    task.landStatus,
    project?.gitBranch,
    project?.integrationMode,
    defaultIntegrationMode,
  ]);

  const targetBranchDisplay =
    worktreeStatus?.suggestedTargetBranch ??
    (effectiveMode === "per-task-pr"
      ? task.worktreeBranch ?? null
      : project?.gitBranch ?? task.baseBranch ?? null);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-[2px] p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[84vh] flex flex-col rounded-2xl bg-white dark:bg-[#161a22] border border-zinc-200 dark:border-zinc-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800">
          <span
            className="px-2 py-0.5 rounded-md font-mono text-[11px] font-semibold bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 border border-indigo-500/25 shrink-0"
            title={`@${formatTaskCode(task.taskNumber)} / @${task.projectName}/${formatTaskCode(task.taskNumber)}`}
          >
            {formatTaskCode(task.taskNumber)}
          </span>
          <span
            className="px-2 py-0.5 rounded-full text-[11px] font-semibold shrink-0"
            style={{ backgroundColor: `${projectColorHex}22`, color: projectColorHex }}
          >
            {task.projectName}
          </span>
          <h2 className="text-[15px] font-semibold truncate flex-1 min-w-0">{task.title}</h2>
          <TaskInspectorQuickStatusButton
            task={task}
            locale={locale}
            onUpdateStatus={onUpdateStatus}
          />
          <TaskStatusSelect
            status={task.status}
            worktreePath={task.worktreePath}
            worktreeBranch={task.worktreeBranch}
            landStatus={task.landStatus}
            locale={locale}
            onUpdateStatus={onUpdateStatus}
          />
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 select-text">
          {task.projectPath && (
            <div className="flex items-center gap-2 text-[11.5px] font-mono text-zinc-500">
              <Folder className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{task.projectPath}</span>
            </div>
          )}

          {/* Git Worktree & Integration Panel */}
          {hasWorktreeInfo && (
            <div
              data-testid="worktree-panel"
              className="rounded-xl p-3.5 bg-zinc-50 dark:bg-zinc-900/70 border border-zinc-200/80 dark:border-zinc-800 space-y-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                  <GitBranch className="w-3.5 h-3.5 text-indigo-500" />
                  <span>Git Worktree & Integration</span>
                  {needsLand && task.status !== "running" && (
                    <span
                      data-testid="inspector-unlanded-badge"
                      className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold normal-case tracking-normal bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    >
                      {t(locale, "task.unlandedBadge")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-indigo-500/12 text-indigo-600 dark:text-indigo-300">
                    {modeOption.shortLabel}
                  </span>
                  <button
                    type="button"
                    onClick={() => void refreshGitInfo()}
                    disabled={isRefreshingGit}
                    title={t(locale, "inspector.refreshGitTitle")}
                    className="p-1 rounded hover:bg-zinc-200/70 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
                  >
                    <RefreshCw className={`w-3 h-3 ${isRefreshingGit ? "animate-spin" : ""}`} />
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                {task.worktreeBranch && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono bg-zinc-200/70 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200">
                    <GitBranch className="w-3 h-3 text-zinc-400 shrink-0" />
                    <span>{task.worktreeBranch}</span>
                  </span>
                )}

                {task.landStatus === "landed" && task.landedBranch ? (
                  <span
                    data-testid="inspector-landed-badge"
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono font-medium bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  >
                    <CheckCircle2 className="w-3 h-3 shrink-0" />
                    <span>Landed → {task.landedBranch}</span>
                    {task.landedCommit && (
                      <span className="opacity-70">({task.landedCommit.slice(0, 7)})</span>
                    )}
                  </span>
                ) : (
                  targetBranchDisplay && (
                    <span
                      data-testid="inspector-target-badge"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md font-mono bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border border-indigo-500/20"
                    >
                      <GitMerge className="w-3 h-3 shrink-0" />
                      <span>
                        {effectiveMode === "per-task-pr"
                          ? `Branch: ${targetBranchDisplay}`
                          : `Target: ${targetBranchDisplay}`}
                      </span>
                    </span>
                  )
                )}

                {worktreeStatus?.worktreeExists && (
                  <>
                    <span className="px-2 py-0.5 rounded-md text-[11px] bg-zinc-200/60 dark:bg-zinc-800/80 text-zinc-600 dark:text-zinc-300 tabular-nums">
                      +{worktreeStatus.aheadCommits} commits
                    </span>
                    <span className="px-2 py-0.5 rounded-md text-[11px] bg-zinc-200/60 dark:bg-zinc-800/80 text-zinc-600 dark:text-zinc-300 tabular-nums">
                      {worktreeStatus.changedFilesCount} uncommitted
                    </span>
                  </>
                )}

                {worktreeStatus?.parentDirty && effectiveMode !== "per-task-pr" && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/15 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="w-3 h-3 shrink-0" />
                    <span>{t(locale, "inspector.parentDirty")}</span>
                  </span>
                )}
              </div>

              {task.worktreePath && (
                <div className="text-[11px] font-mono text-zinc-400 truncate" title={task.worktreePath}>
                  Worktree: {task.worktreePath}
                </div>
              )}

              {task.prUrl && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onOpenPreviewUrl(task.prUrl!);
                      onClose();
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] font-medium bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-500/25 transition-colors cursor-pointer"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span className="truncate max-w-[420px]">{task.prUrl}</span>
                  </button>
                </div>
              )}

              {task.landError && (task.landStatus === "conflict" || task.landStatus === "error") && (
                <div
                  data-testid="inspector-land-error"
                  className="rounded-lg p-2.5 bg-rose-500/10 border border-rose-500/25 text-[12px] text-rose-700 dark:text-rose-300 space-y-1"
                >
                  <div className="flex items-start gap-1.5 font-medium">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{task.landError}</span>
                  </div>
                  {task.conflictFiles && task.conflictFiles.length > 0 && (
                    <div className="pl-5 text-[11px] font-mono text-rose-600 dark:text-rose-400">
                      {t(locale, "inspector.conflictFiles", {
                        files: task.conflictFiles.join(", "),
                      })}
                    </div>
                  )}
                </div>
              )}

              {worktreeStatus?.diffSummary && (
                <pre className="p-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-950/70 text-[11px] font-mono text-zinc-600 dark:text-zinc-300 overflow-x-auto max-h-36">
                  {worktreeStatus.diffSummary}
                </pre>
              )}

              {/* Action Buttons */}
              {(canLand ||
                canResolveConflictWithAI ||
                (hasActiveWorktree && onCleanupWorktree && task.status !== "running")) && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {canResolveConflictWithAI && (
                    <button
                      type="button"
                      disabled={isLanding || isStartingConflictResolve}
                      data-testid="inspector-ai-resolve-conflict-btn"
                      onClick={() => {
                        setIsStartingConflictResolve(true);
                        void Promise.resolve(onResolveConflictWithAI?.()).finally(() => {
                          setIsStartingConflictResolve(false);
                        });
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-60 transition-colors cursor-pointer"
                    >
                      {isStartingConflictResolve ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {isStartingConflictResolve
                          ? t(locale, "inspector.aiResolveStarting")
                          : t(locale, "inspector.aiResolveBtn")}
                      </span>
                    </button>
                  )}

                  {canLand && effectiveMode !== "per-task-pr" && (
                    <button
                      type="button"
                      disabled={isLanding}
                      data-testid="inspector-land-btn"
                      onClick={() => void onLandTask?.()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors cursor-pointer"
                    >
                      {isLanding ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <GitMerge className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {isLanding
                          ? t(locale, "inspector.landing")
                          : targetBranchDisplay
                            ? `Land → ${targetBranchDisplay}`
                            : "Land Changes"}
                      </span>
                    </button>
                  )}

                  {canLand && effectiveMode === "per-task-pr" && (
                    <>
                      <button
                        type="button"
                        disabled={isLanding}
                        data-testid="inspector-push-btn"
                        onClick={() => void onLandTask?.({ createPr: false })}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-60 transition-colors cursor-pointer"
                      >
                        {isLanding ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Upload className="w-3.5 h-3.5" />
                        )}
                        <span>Push Branch</span>
                      </button>
                      <button
                        type="button"
                        disabled={isLanding}
                        data-testid="inspector-pr-btn"
                        onClick={() => void onLandTask?.({ createPr: true })}
                        title={
                          worktreeStatus?.ghAvailable
                            ? t(locale, "inspector.pushPrGhTitle")
                            : t(locale, "inspector.pushPrNoGhTitle")
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors cursor-pointer"
                      >
                        {isLanding ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <GitPullRequest className="w-3.5 h-3.5" />
                        )}
                        <span>Push & Create PR</span>
                      </button>
                    </>
                  )}

                  {hasActiveWorktree && onCleanupWorktree && task.status !== "running" && (
                    <button
                      type="button"
                      disabled={isLanding}
                      data-testid="inspector-cleanup-wt-btn"
                      onClick={() => void onCleanupWorktree()}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium text-zinc-600 dark:text-zinc-300 bg-zinc-200/70 dark:bg-zinc-800 hover:bg-zinc-300/70 dark:hover:bg-zinc-700 transition-colors cursor-pointer ml-auto"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>{t(locale, "inspector.deleteWorktree")}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {task.summary && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">
                {t(locale, "inspector.summary")}
              </div>
              <p className="text-[13px] text-zinc-700 dark:text-zinc-300">{task.summary}</p>
            </div>
          )}

          {gitStatus && !worktreeStatus?.diffSummary && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1">
                Git Status
              </div>
              <pre className="p-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 text-[11.5px] font-mono text-zinc-600 dark:text-zinc-300 overflow-x-auto max-h-32">
                {gitStatus}
              </pre>
            </div>
          )}

          {task.latestOutput.trim() && (
            <div data-testid="inspector-latest-output">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
                {t(locale, "inspector.latestOutput")}
              </div>
              <div className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-900/80 border border-zinc-200/80 dark:border-zinc-800">
                <MarkdownView
                  content={task.latestOutput}
                  locale={locale}
                  onOpenUrl={(url) => {
                    onOpenPreviewUrl(url);
                    onClose();
                  }}
                  onOpenMarkdownFile={
                    onOpenMarkdownFile
                      ? (target, base) => {
                          onOpenMarkdownFile(target, base);
                          onClose();
                        }
                      : undefined
                  }
                />
              </div>
            </div>
          )}

          {task.activities.length > 0 && (
            <div data-testid="inspector-activity-section" className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                {t(locale, "inspector.activityLog", { count: task.activities.length })}
              </div>

              {partitionedActivities.highSignal.length > 0 && (
                <div data-testid="inspector-high-signal-activities" className="space-y-1.5">
                  {partitionedActivities.highSignal.map((act) => (
                    <HighSignalActivityItem key={act.id} activity={act} />
                  ))}
                </div>
              )}

              {partitionedActivities.toolActivities.length > 0 && (
                <div
                  data-testid="inspector-tool-log-section"
                  className="rounded-xl border border-zinc-200/70 dark:border-zinc-800/80 bg-zinc-50/70 dark:bg-zinc-900/50 overflow-hidden"
                >
                  <button
                    type="button"
                    data-testid="inspector-tool-log-toggle"
                    aria-expanded={isToolLogExpanded}
                    aria-label={
                      isToolLogExpanded
                        ? t(locale, "inspector.toolLogCollapseAria")
                        : t(locale, "inspector.toolLogExpandAria")
                    }
                    onClick={() => setIsToolLogExpanded((prev) => !prev)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[12px] font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100/90 dark:hover:bg-zinc-800/60 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <Terminal className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                      <span className="truncate">
                        {formatToolLogSummary(
                          partitionedActivities.toolActivities.length,
                          partitionedActivities.toolCounts,
                          locale,
                        )}
                      </span>
                    </span>
                    <ChevronRight
                      className={`w-3.5 h-3.5 text-zinc-400 shrink-0 transition-transform duration-150 ${
                        isToolLogExpanded ? "rotate-90" : ""
                      }`}
                    />
                  </button>

                  {isToolLogExpanded && (
                    <div
                      data-testid="inspector-tool-log-list"
                      className="border-t border-zinc-200/70 dark:border-zinc-800/80 max-h-72 overflow-y-auto divide-y divide-zinc-200/60 dark:divide-zinc-800/70"
                    >
                      {partitionedActivities.toolActivities.map((act, index) => (
                        <div
                          key={act.id}
                          data-testid="inspector-tool-log-item"
                          className="px-3 py-2 bg-white/60 dark:bg-zinc-950/30"
                        >
                          <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-zinc-700 dark:text-zinc-300">
                            <span className="text-[10px] font-mono text-zinc-400 tabular-nums shrink-0">
                              #{index + 1}
                            </span>
                            <Terminal className="w-3 h-3 text-zinc-400 shrink-0" />
                            <span className="font-mono truncate">{act.title}</span>
                          </div>
                          {act.detail && (
                            <pre className="mt-1 pl-5 text-[11px] font-mono text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap line-clamp-6">
                              {act.detail}
                            </pre>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/40">
          {task.previewURL && (
            <button
              type="button"
              onClick={() => {
                onOpenPreviewUrl(task.previewURL!);
                onClose();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors cursor-pointer"
            >
              <Globe className="w-3.5 h-3.5" />
              {t(locale, "inspector.openInBrowser")}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onMentionInChat();
              onClose();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-zinc-200/80 dark:bg-zinc-800 hover:bg-zinc-300/70 dark:hover:bg-zinc-700 transition-colors cursor-pointer"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            {t(locale, "sidebar.mentionInChat")}
          </button>
          <div className="flex-1" />
          {task.status === "running" && (
            <button
              type="button"
              onClick={onStopWorker}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-rose-500/15 text-rose-600 dark:text-rose-400 hover:bg-rose-500/25 transition-colors cursor-pointer"
            >
              <Square className="w-3 h-3 fill-current" />
              {t(locale, "sidebar.stopWorker")}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onDelete();
              onClose();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t(locale, "common.delete")}
          </button>
        </div>
      </div>
    </div>
  );
};

const HighSignalActivityItem: React.FC<{ activity: WorkerActivityEntry }> = ({ activity }) => {
  const isError = activity.kind === "error";
  const isMessage = activity.kind === "message";
  const isSystem = activity.kind === "system";

  const containerClass = isError
    ? "bg-rose-500/10 border-rose-500/25 text-rose-700 dark:text-rose-300"
    : isMessage
      ? "bg-indigo-500/[0.06] border-indigo-500/20 text-zinc-800 dark:text-zinc-200"
      : "bg-zinc-100/80 dark:bg-zinc-900/70 border-zinc-200/60 dark:border-zinc-800/80 text-zinc-800 dark:text-zinc-200";

  return (
    <div
      data-testid={`inspector-activity-${activity.kind}`}
      className={`p-2.5 rounded-lg border ${containerClass}`}
    >
      <div className="flex items-center gap-1.5 text-[12px] font-medium">
        {isError ? (
          <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
        ) : isMessage ? (
          <MessageSquare className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
        ) : isSystem ? (
          <Info className="w-3.5 h-3.5 text-sky-500 shrink-0" />
        ) : (
          <FileText className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
        )}
        <span>{activity.title}</span>
      </div>
      {activity.detail && (
        <pre className="mt-1 text-[11px] font-mono text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap line-clamp-6">
          {activity.detail}
        </pre>
      )}
    </div>
  );
};
