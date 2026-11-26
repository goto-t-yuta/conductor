import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  FolderPlus,
  FolderSearch,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Globe,
  Layers,
  ListTodo,
  Loader2,
  MessageSquare,
  MessagesSquare,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import type { AgentTask, AgentTaskStatus, IntegrationMode, Project } from "../../shared/types.js";
import { t, type UiLocale } from "../../shared/i18n.js";
import { findProjectForTask, formatTaskCode } from "../../shared/mentions.js";
import {
  getLocalizedMarkTaskDoneBlockedReason,
  requiresLandBeforeDone,
  validateManualTaskStatusTransition,
} from "../../shared/task-status.js";
import { getEffectiveProjectMode, getIntegrationModeOption } from "../lib/integration-mode.js";
import {
  filterQuestions,
  formatQuestionTime,
  summarizeQuestions,
  type QuestionItem,
} from "../lib/questions.js";
import {
  QUESTIONS_SECTION_MAX_HEIGHT_RATIO,
  QUESTIONS_SECTION_MIN_HEIGHT,
  clampQuestionsSectionHeight,
  countTasksByProjectGroup,
  filterCompletedTasks,
  formatCompletedCountBadge,
  getQuickStatusTransition,
  getTaskCardSubtitle,
  groupTasksByProject,
  loadCollapsedProjectGroups,
  loadQuestionsSectionHeight,
  loadTaskGroupByProject,
  makeProjectGroupCollapseKey,
  partitionSidebarTasks,
  saveCollapsedProjectGroups,
  saveQuestionsSectionHeight,
  saveTaskGroupByProject,
  toggleCollapsedProjectGroup,
  type TaskProjectGroup,
  type TaskSidebarSection,
} from "../lib/task-sidebar.js";

export interface TaskSidebarProps {
  projects: Project[];
  tasks: AgentTask[];
  questions?: QuestionItem[];
  defaultIntegrationMode?: IntegrationMode;
  locale?: UiLocale;
  selectedProjectId: string | null;
  selectedTaskId: string | null;
  defaultCompletedExpanded?: boolean;
  defaultCompletedSearch?: string;
  defaultGroupByProject?: boolean;
  defaultCollapsedProjectGroups?: readonly string[];
  defaultQuestionsExpanded?: boolean;
  defaultQuestionsSearch?: string;
  onSelectProjectFilter: (id: string | null) => void;
  onAddProject: () => void;
  onScanDirectory: () => void;
  onRescanProjects: () => void;
  onRemoveProject: (id: string) => void;
  onMentionProject: (project: Project) => void;
  onSelectTask: (id: string) => void;
  onSelectQuestion?: (question: QuestionItem) => void;
  onOpenPreviewUrl: (url: string, task?: AgentTask) => void;
  onMentionTask: (task: AgentTask) => void;
  onUpdateTaskStatus: (taskId: string, status: AgentTaskStatus) => void;
  onStopWorker: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onLandTask?: (taskId: string, options?: { createPr?: boolean }) => void;
}

function findTaskProject(projects: Project[], task: AgentTask): Project | undefined {
  return findProjectForTask(projects, task);
}

function projectColor(projects: Project[], task: AgentTask): string {
  return findProjectForTask(projects, task)?.colorHex ?? "#6366F1";
}

function TaskStatusIcon({ status }: { status: AgentTask["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin shrink-0" />;
    case "queued":
      return <Clock className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
    case "needs_review":
      return <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />;
    case "done":
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
    case "failed":
      return <XCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />;
  }
}

export const TaskSidebar: React.FC<TaskSidebarProps> = React.memo(({
  projects,
  tasks,
  questions = [],
  defaultIntegrationMode = "feature-branch",
  locale = "ja",
  selectedProjectId,
  selectedTaskId,
  defaultCompletedExpanded = false,
  defaultCompletedSearch = "",
  defaultGroupByProject,
  defaultCollapsedProjectGroups,
  defaultQuestionsExpanded = true,
  defaultQuestionsSearch = "",
  onSelectProjectFilter,
  onAddProject,
  onScanDirectory,
  onRescanProjects,
  onRemoveProject,
  onMentionProject,
  onSelectTask,
  onSelectQuestion,
  onOpenPreviewUrl,
  onMentionTask,
  onUpdateTaskStatus,
  onStopWorker,
  onDeleteTask,
  onLandTask,
}) => {
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [completedExpanded, setCompletedExpanded] = useState(defaultCompletedExpanded);
  const [completedSearch, setCompletedSearch] = useState(defaultCompletedSearch);
  const [groupByProject, setGroupByProject] = useState<boolean>(() =>
    defaultGroupByProject !== undefined ? defaultGroupByProject : loadTaskGroupByProject(),
  );
  const [collapsedProjectGroups, setCollapsedProjectGroups] = useState<Set<string>>(() =>
    defaultCollapsedProjectGroups !== undefined
      ? new Set(defaultCollapsedProjectGroups)
      : loadCollapsedProjectGroups(),
  );
  const [questionsExpanded, setQuestionsExpanded] = useState(defaultQuestionsExpanded);
  const [questionsSearch, setQuestionsSearch] = useState(defaultQuestionsSearch);
  const [questionsHeight, setQuestionsHeight] = useState<number | null>(() =>
    loadQuestionsSectionHeight(),
  );
  const [sidebarHeight, setSidebarHeight] = useState<number | null>(null);
  const [isResizingQuestions, setIsResizingQuestions] = useState(false);

  const sidebarRef = useRef<HTMLElement | null>(null);
  const questionsSectionRef = useRef<HTMLDivElement | null>(null);
  const cleanupResizeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return;

    const updateSidebarHeight = () => {
      const nextHeight = Math.round(el.getBoundingClientRect().height);
      if (nextHeight > 0) {
        setSidebarHeight((prev) => (prev === nextHeight ? prev : nextHeight));
      }
    };

    updateSidebarHeight();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateSidebarHeight);
      observer.observe(el);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", updateSidebarHeight);
    return () => window.removeEventListener("resize", updateSidebarHeight);
  }, []);

  useEffect(() => {
    return () => {
      cleanupResizeRef.current?.();
    };
  }, []);

  const resolvedQuestionsHeight =
    questionsExpanded && questionsHeight !== null
      ? clampQuestionsSectionHeight(questionsHeight, sidebarHeight)
      : null;

  const startQuestionsResize = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !questionsExpanded) return;
    e.preventDefault();
    cleanupResizeRef.current?.();

    const startY = e.clientY;
    const measuredSidebarHeight =
      sidebarRef.current?.getBoundingClientRect().height || sidebarHeight || undefined;
    const measuredQuestionsHeight =
      questionsSectionRef.current?.getBoundingClientRect().height ||
      resolvedQuestionsHeight ||
      QUESTIONS_SECTION_MIN_HEIGHT;

    let latestHeight: number | null = null;
    let didMove = false;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    setIsResizingQuestions(true);

    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      if (!didMove && Math.abs(dy) < 2) return;
      didMove = true;
      const currentSidebarHeight =
        sidebarRef.current?.getBoundingClientRect().height || measuredSidebarHeight;
      const nextHeight = clampQuestionsSectionHeight(
        measuredQuestionsHeight + dy,
        currentSidebarHeight,
      );
      latestHeight = nextHeight;
      setQuestionsHeight(nextHeight);
    };

    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      setIsResizingQuestions(false);
      cleanupResizeRef.current = null;
    };

    const onUp = () => {
      cleanup();
      if (didMove && latestHeight !== null) {
        const currentSidebarHeight =
          sidebarRef.current?.getBoundingClientRect().height || measuredSidebarHeight;
        saveQuestionsSectionHeight(latestHeight, undefined, currentSidebarHeight);
      }
    };

    cleanupResizeRef.current = cleanup;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", onUp);
  };

  const resetQuestionsHeight = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setQuestionsHeight(null);
    saveQuestionsSectionHeight(null);
  };

  const handleQuestionsResizeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!questionsExpanded) return;
    const currentSidebarHeight =
      sidebarRef.current?.getBoundingClientRect().height || sidebarHeight || undefined;
    const baseHeight =
      questionsSectionRef.current?.getBoundingClientRect().height ||
      resolvedQuestionsHeight ||
      QUESTIONS_SECTION_MIN_HEIGHT;

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const delta = e.key === "ArrowUp" ? 20 : -20;
      const nextHeight = clampQuestionsSectionHeight(baseHeight + delta, currentSidebarHeight);
      setQuestionsHeight(nextHeight);
      saveQuestionsSectionHeight(nextHeight, undefined, currentSidebarHeight);
    } else if (e.key === "Home" || e.key === "Escape") {
      e.preventDefault();
      setQuestionsHeight(null);
      saveQuestionsSectionHeight(null);
    }
  };

  const questionSummary = useMemo(() => summarizeQuestions(questions), [questions]);
  const hasQuestionsQuery = questionsSearch.trim().length > 0;
  const filteredQuestions = useMemo(
    () =>
      hasQuestionsQuery
        ? filterQuestions(questions, questionsSearch, { projects, tasks })
        : questions,
    [questions, questionsSearch, hasQuestionsQuery, projects, tasks],
  );
  const questionsBadgeText = formatCompletedCountBadge(
    filteredQuestions.length,
    questionSummary.totalCount,
    hasQuestionsQuery,
  );

  // Show only projects that currently have tasks (or are actively selected) as quick filter pills
  const taskProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tasks) {
      if (t.projectId) ids.add(t.projectId);
    }
    if (selectedProjectId) ids.add(selectedProjectId);
    return ids;
  }, [tasks, selectedProjectId]);

  const quickFilterProjects = useMemo(
    () => projects.filter((p) => taskProjectIds.has(p.id)),
    [projects, taskProjectIds],
  );

  const searchedProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    const list = q
      ? projects.filter(
          (p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q),
        )
      : projects;
    return list.slice(0, 30);
  }, [projects, projectSearch]);

  const { filteredTasks, activeTasks, completedTasks } = useMemo(
    () => partitionSidebarTasks(tasks, selectedProjectId),
    [tasks, selectedProjectId],
  );
  const hasCompletedQuery = completedSearch.trim().length > 0;
  const filteredCompletedTasks = useMemo(
    () => filterCompletedTasks(completedTasks, completedSearch),
    [completedTasks, completedSearch],
  );
  const completedBadgeText = formatCompletedCountBadge(
    filteredCompletedTasks.length,
    completedTasks.length,
    hasCompletedQuery,
  );
  const activeProjectGroups = useMemo(
    () => groupTasksByProject(activeTasks, projects, locale),
    [activeTasks, projects, locale],
  );
  const completedProjectGroups = useMemo(
    () => groupTasksByProject(filteredCompletedTasks, projects, locale),
    [filteredCompletedTasks, projects, locale],
  );
  const completedTotalByGroup = useMemo(
    () => countTasksByProjectGroup(completedTasks, projects),
    [completedTasks, projects],
  );
  const runningCount = tasks.filter((t) => t.status === "running").length;

  const handleToggleGroupByProject = () => {
    setGroupByProject((prev) => {
      const next = !prev;
      saveTaskGroupByProject(next);
      return next;
    });
  };

  const handleToggleProjectGroupCollapse = (collapseKey: string) => {
    setCollapsedProjectGroups((prev) => {
      const next = toggleCollapsedProjectGroup(prev, collapseKey);
      saveCollapsedProjectGroups(next);
      return next;
    });
  };

  const renderTaskCard = (task: AgentTask, hideProjectBadge = false) => {
    const proj = findTaskProject(projects, task);
    return (
      <TaskCard
        key={task.id}
        task={task}
        colorHex={projectColor(projects, task)}
        effectiveMode={getEffectiveProjectMode(proj, defaultIntegrationMode)}
        parentBranch={proj?.gitBranch ?? null}
        locale={locale}
        hideProjectBadge={hideProjectBadge}
        isSelected={selectedTaskId === task.id}
        onSelect={() => onSelectTask(task.id)}
        onOpenPreview={(url) => onOpenPreviewUrl(url, task)}
        onMention={() => onMentionTask(task)}
        onUpdateStatus={(status) => onUpdateTaskStatus(task.id, status)}
        onStop={() => onStopWorker(task.id)}
        onDelete={() => onDeleteTask(task.id)}
        onLand={onLandTask ? (opts) => onLandTask(task.id, opts) : undefined}
      />
    );
  };

  return (
    <aside
      ref={sidebarRef}
      className="flex flex-col h-full bg-zinc-50 dark:bg-[#13161c] border-r border-zinc-200/80 dark:border-zinc-800/90"
    >
      {/* Header with space for macOS traffic lights */}
      <div className="drag-region h-11 flex items-center justify-between gap-2 pl-[78px] pr-3 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <ListTodo className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
          <span className="text-[12.5px] font-semibold truncate whitespace-nowrap">
            {t(locale, "sidebar.tasks")}
          </span>
          {runningCount > 0 && (
            <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 shrink-0 whitespace-nowrap">
              {runningCount}
            </span>
          )}
        </div>
        <div className="no-drag flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            data-testid="toggle-project-grouping"
            aria-pressed={groupByProject}
            aria-label={t(locale, "sidebar.groupByProjectAria")}
            onClick={handleToggleGroupByProject}
            title={
              groupByProject
                ? t(locale, "sidebar.groupByProjectOnTitle")
                : t(locale, "sidebar.groupByProjectOffTitle")
            }
            className={`p-1.5 rounded-md transition-colors cursor-pointer ${
              groupByProject
                ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/25"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onAddProject}
            title={t(locale, "sidebar.addProjectTitle")}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Compact Auto-Discovered Projects Section */}
      <div className="px-3 py-2 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0 space-y-2">
        <button
          type="button"
          onClick={() => setProjectsExpanded((v) => !v)}
          className="w-full flex items-center justify-between text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors cursor-pointer"
        >
          <span className="inline-flex items-center gap-1 font-semibold uppercase tracking-wider text-[10px]">
            {projectsExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
            {t(locale, "sidebar.projectsCount", { count: projects.length })}
          </span>
          <span className="text-[10px] text-zinc-400">{t(locale, "sidebar.autoDetected")}</span>
        </button>

        {/* Quick filter pills only when tasks exist */}
        {quickFilterProjects.length > 0 && (
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => onSelectProjectFilter(null)}
              className={`px-2 py-0.5 rounded-full text-[10.5px] font-medium transition-colors cursor-pointer ${
                selectedProjectId === null
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "bg-zinc-200/60 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
              }`}
            >
              {t(locale, "common.all")}
            </button>
            {quickFilterProjects.map((p) => {
              const active = selectedProjectId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onSelectProjectFilter(active ? null : p.id)}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium border transition-colors cursor-pointer ${
                    active
                      ? "bg-indigo-500/15 border-indigo-500/50 text-zinc-900 dark:text-white"
                      : "bg-zinc-200/50 dark:bg-zinc-800/70 border-transparent text-zinc-700 dark:text-zinc-300"
                  }`}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: p.colorHex }}
                  />
                  <span className="truncate max-w-[100px]">{p.name}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Expandable searchable catalog of all auto-discovered projects */}
        {projectsExpanded && (
          <div className="space-y-1.5 pt-1">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onAddProject}
                className="flex-1 inline-flex items-center justify-center gap-1 py-1 px-1.5 rounded-md text-[10.5px] font-medium bg-zinc-200/70 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 transition-colors cursor-pointer"
                title={t(locale, "sidebar.addOneTitle")}
              >
                <FolderPlus className="w-3 h-3 text-indigo-500" />
                <span>{t(locale, "sidebar.addOne")}</span>
              </button>
              <button
                type="button"
                onClick={onScanDirectory}
                className="flex-1 inline-flex items-center justify-center gap-1 py-1 px-1.5 rounded-md text-[10.5px] font-medium bg-zinc-200/70 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 transition-colors cursor-pointer"
                title={t(locale, "sidebar.scanDirTitle")}
              >
                <FolderSearch className="w-3 h-3 text-indigo-500" />
                <span>{t(locale, "sidebar.scanDir")}</span>
              </button>
              <button
                type="button"
                onClick={onRescanProjects}
                className="p-1 rounded-md bg-zinc-200/70 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer"
                title={t(locale, "sidebar.rescanTitle")}
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>

            <div className="relative">
              <Search className="w-3 h-3 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                placeholder={t(locale, "sidebar.searchProjectsPlaceholder")}
                className="w-full pl-7 pr-2 py-1 rounded-md text-[11.5px] bg-white dark:bg-[#0f1115] border border-zinc-200 dark:border-zinc-800 outline-none focus:border-indigo-500/60 select-text"
              />
            </div>

            <div className="max-h-48 overflow-y-auto space-y-0.5 pr-0.5">
              {searchedProjects.map((p) => {
                const active = selectedProjectId === p.id;
                const projModeOpt = p.integrationMode
                  ? getIntegrationModeOption(p.integrationMode, locale)
                  : null;
                return (
                  <div
                    key={p.id}
                    onClick={() => onSelectProjectFilter(active ? null : p.id)}
                    title={p.path}
                    className={`group flex items-center gap-1.5 px-2 py-1 rounded-md text-[11.5px] cursor-pointer transition-colors ${
                      active
                        ? "bg-indigo-500/15 text-zinc-900 dark:text-white font-medium"
                        : "hover:bg-zinc-200/60 dark:hover:bg-zinc-800/70 text-zinc-700 dark:text-zinc-300"
                    }`}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: p.colorHex }}
                    />
                    <span className="truncate flex-1">{p.name}</span>
                    {projModeOpt && (
                      <span
                        className="px-1 py-0.2 rounded text-[9px] font-medium bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 shrink-0"
                        title={t(locale, "sidebar.customModeTitle", {
                          mode: projModeOpt.shortLabel,
                        })}
                      >
                        {projModeOpt.badgeText}
                      </span>
                    )}
                    {p.gitBranch && (
                      <span className="text-[9.5px] font-mono text-zinc-400 truncate max-w-[60px]">
                        {p.gitBranch}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMentionProject(p);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-zinc-300/70 dark:hover:bg-zinc-700 cursor-pointer"
                      title={t(locale, "sidebar.mentionInChat")}
                    >
                      <MessageSquare className="w-2.5 h-2.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveProject(p.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-zinc-300/70 dark:hover:bg-zinc-700 cursor-pointer"
                      title={t(locale, "sidebar.removeFromList")}
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                );
              })}
              {searchedProjects.length === 0 && (
                <div className="text-[11px] text-zinc-400 text-center py-2">
                  {t(locale, "sidebar.noMatchingProjects")}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Tasks List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2.5 space-y-3">
        {filteredTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center px-4 pt-12 gap-2">
            <Sparkles className="w-6 h-6 text-zinc-300 dark:text-zinc-700" />
            <div className="text-[12.5px] font-medium text-zinc-500 dark:text-zinc-400">
              {t(locale, "sidebar.noTasksTitle")}
            </div>
            <p className="text-[11.5px] text-zinc-400 dark:text-zinc-500 leading-relaxed">
              {t(locale, "sidebar.noTasksDescription")}
            </p>
          </div>
        ) : (
          <>
            {activeTasks.length > 0 && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[10px] font-semibold tracking-wider text-zinc-400 uppercase">
                    {t(locale, "sidebar.activeAndReview")}
                  </span>
                  <span className="text-[10px] text-zinc-400 tabular-nums">{activeTasks.length}</span>
                </div>
                {groupByProject ? (
                  <div className="space-y-2" data-testid="active-project-groups">
                    {activeProjectGroups.map((group) => (
                      <ProjectTaskGroupSection
                        key={makeProjectGroupCollapseKey("active", group.groupKey)}
                        group={group}
                        section="active"
                        locale={locale}
                        isCollapsed={collapsedProjectGroups.has(
                          makeProjectGroupCollapseKey("active", group.groupKey),
                        )}
                        onToggleCollapse={handleToggleProjectGroupCollapse}
                        renderTaskCard={(task) => renderTaskCard(task, true)}
                      />
                    ))}
                  </div>
                ) : (
                  activeTasks.map((task) => renderTaskCard(task, false))
                )}
              </div>
            )}

            {completedTasks.length > 0 && (
              <div className="space-y-1.5 pt-1 border-t border-zinc-200/70 dark:border-zinc-800/80">
                <button
                  type="button"
                  aria-expanded={completedExpanded}
                  onClick={() => setCompletedExpanded((v) => !v)}
                  className="w-full flex items-center justify-between px-1 py-0.5 rounded-md text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/40 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer"
                >
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-wider uppercase">
                    {completedExpanded ? (
                      <ChevronDown className="w-3 h-3 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3 h-3 shrink-0" />
                    )}
                    <span>{t(locale, "sidebar.completed")}</span>
                  </span>
                  <span
                    data-testid="completed-count-badge"
                    className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 tabular-nums"
                  >
                    {completedBadgeText}
                  </span>
                </button>

                {completedExpanded && (
                  <div className="space-y-1.5">
                    <div className="relative">
                      <Search className="w-3 h-3 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={completedSearch}
                        onChange={(e) => setCompletedSearch(e.target.value)}
                        placeholder={t(locale, "sidebar.searchCompletedPlaceholder")}
                        aria-label={t(locale, "sidebar.searchCompletedAria")}
                        title={t(locale, "sidebar.searchCompletedTitle")}
                        className="w-full pl-7 pr-7 py-1 rounded-md text-[11.5px] bg-white dark:bg-[#0f1115] border border-zinc-200 dark:border-zinc-800 outline-none focus:border-indigo-500/60 select-text"
                      />
                      {hasCompletedQuery && (
                        <button
                          type="button"
                          onClick={() => setCompletedSearch("")}
                          aria-label={t(locale, "sidebar.clearFilter")}
                          title={t(locale, "sidebar.clearFilter")}
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>

                    {hasCompletedQuery && (
                      <div className="flex items-center justify-between px-1 text-[10.5px] text-zinc-400 tabular-nums">
                        <span>
                          {t(locale, "sidebar.showingCount", {
                            filtered: filteredCompletedTasks.length,
                            total: completedTasks.length,
                          })}
                        </span>
                      </div>
                    )}

                    {filteredCompletedTasks.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-zinc-200 dark:border-zinc-800 px-3 py-3 text-center space-y-1">
                        <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
                          {t(locale, "sidebar.noMatchingCompleted")}
                        </div>
                        {hasCompletedQuery && (
                          <button
                            type="button"
                            onClick={() => setCompletedSearch("")}
                            className="text-[10.5px] font-medium text-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer"
                          >
                            {t(locale, "sidebar.clearFilterBtn")}
                          </button>
                        )}
                      </div>
                    ) : groupByProject ? (
                      <div className="space-y-2" data-testid="completed-project-groups">
                        {completedProjectGroups.map((group) => (
                          <ProjectTaskGroupSection
                            key={makeProjectGroupCollapseKey("completed", group.groupKey)}
                            group={group}
                            section="completed"
                            locale={locale}
                            isCollapsed={collapsedProjectGroups.has(
                              makeProjectGroupCollapseKey("completed", group.groupKey),
                            )}
                            forceExpanded={hasCompletedQuery}
                            totalCountInGroup={completedTotalByGroup.get(group.groupKey)}
                            onToggleCollapse={handleToggleProjectGroupCollapse}
                            renderTaskCard={(task) => renderTaskCard(task, true)}
                          />
                        ))}
                      </div>
                    ) : (
                      filteredCompletedTasks.map((task) => renderTaskCard(task, false))
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Bottom Questions History & Progress Section */}
      <div
        ref={questionsSectionRef}
        data-testid="questions-section"
        style={
          resolvedQuestionsHeight !== null
            ? {
                height: `${resolvedQuestionsHeight}px`,
                maxHeight: `${Math.round(QUESTIONS_SECTION_MAX_HEIGHT_RATIO * 100)}%`,
              }
            : undefined
        }
        className="shrink-0 min-h-0 border-t border-zinc-200/80 dark:border-zinc-800/90 bg-zinc-50/90 dark:bg-[#11141a] flex flex-col"
      >
        {questionsExpanded && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t(locale, "sidebar.questionsResizeAria")}
            tabIndex={0}
            data-testid="questions-resize-handle"
            onMouseDown={startQuestionsResize}
            onDoubleClick={resetQuestionsHeight}
            onKeyDown={handleQuestionsResizeKeyDown}
            title={t(locale, "sidebar.questionsResizeTitle")}
            className={`group h-1.5 shrink-0 cursor-row-resize select-none transition-colors flex items-center justify-center focus-visible:outline-none focus-visible:bg-indigo-500/35 ${
              isResizingQuestions
                ? "bg-indigo-500/35"
                : "hover:bg-indigo-500/25"
            }`}
          >
            <div
              className={`h-[2px] w-8 rounded-full transition-colors ${
                isResizingQuestions
                  ? "bg-indigo-500/80"
                  : "bg-zinc-300/60 dark:bg-zinc-700/70 group-hover:bg-indigo-500/70"
              }`}
            />
          </div>
        )}
        <button
          type="button"
          aria-expanded={questionsExpanded}
          data-testid="questions-toggle-button"
          onClick={() => setQuestionsExpanded((v) => !v)}
          className={`shrink-0 px-3 ${
            questionsExpanded ? "pt-1 pb-2" : "py-2"
          } flex items-center justify-between gap-1.5 text-left hover:bg-zinc-200/40 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer`}
        >
          <span className="inline-flex items-center gap-1.5 min-w-0">
            {questionsExpanded ? (
              <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 text-zinc-400 shrink-0" />
            )}
            <MessagesSquare className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
            <span className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-200 truncate">
              {t(locale, "sidebar.questions")}
            </span>
            {questionSummary.totalCount > 0 && (
              <span
                data-testid="questions-count-badge"
                className="text-[10.5px] text-zinc-400 tabular-nums"
              >
                {questionsBadgeText}
              </span>
            )}
          </span>
          <span className="inline-flex items-center gap-1 shrink-0">
            {questionSummary.activeCount > 0 && (
              <span
                title={t(locale, "sidebar.questionsActiveTitle", {
                  count: questionSummary.activeCount,
                })}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 tabular-nums"
              >
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                {questionSummary.activeCount}
              </span>
            )}
            {questionSummary.unreadCount > 0 && (
              <span
                title={t(locale, "sidebar.questionsUnreadTitle", {
                  count: questionSummary.unreadCount,
                })}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 tabular-nums"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                {questionSummary.unreadCount}
              </span>
            )}
          </span>
        </button>

        {questionsExpanded && (questions.length > 0 || hasQuestionsQuery) && (
          <div className="shrink-0 px-2.5 pb-1.5 space-y-1">
            <div className="relative">
              <Search className="w-3 h-3 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                data-testid="questions-search-input"
                value={questionsSearch}
                onChange={(e) => setQuestionsSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && questionsSearch) {
                    e.preventDefault();
                    setQuestionsSearch("");
                  }
                }}
                placeholder={t(locale, "sidebar.searchQuestionsPlaceholder")}
                aria-label={t(locale, "sidebar.searchQuestionsAria")}
                title={t(locale, "sidebar.searchQuestionsTitle")}
                className="w-full pl-7 pr-7 py-1 rounded-md text-[11.5px] bg-white dark:bg-[#0f1115] border border-zinc-200 dark:border-zinc-800 outline-none focus:border-indigo-500/60 select-text"
              />
              {hasQuestionsQuery && (
                <button
                  type="button"
                  data-testid="questions-search-clear"
                  onClick={() => setQuestionsSearch("")}
                  aria-label={t(locale, "sidebar.clearFilter")}
                  title={t(locale, "sidebar.clearFilter")}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {hasQuestionsQuery && (
              <div
                data-testid="questions-search-count"
                className="flex items-center justify-between px-1 text-[10.5px] text-zinc-400 tabular-nums"
              >
                <span>
                  {t(locale, "sidebar.showingCount", {
                    filtered: filteredQuestions.length,
                    total: questions.length,
                  })}
                </span>
              </div>
            )}
          </div>
        )}

        {questionsExpanded && (
          <div
            data-testid="questions-list-container"
            className={`${
              resolvedQuestionsHeight !== null ? "flex-1 min-h-0" : "max-h-[38vh]"
            } overflow-y-auto px-2.5 pb-2.5 pt-0.5 space-y-1.5`}
          >
            {questions.length === 0 ? (
              <div className="px-2 py-2 text-[11px] text-zinc-400 dark:text-zinc-500 text-center">
                {t(locale, "sidebar.questionsEmpty")}
              </div>
            ) : filteredQuestions.length === 0 ? (
              <div
                data-testid="questions-search-empty"
                className="rounded-lg border border-dashed border-zinc-200 dark:border-zinc-800 px-3 py-3 text-center space-y-1"
              >
                <div className="text-[11px] text-zinc-400 dark:text-zinc-500">
                  {t(locale, "sidebar.noMatchingQuestions")}
                </div>
                {hasQuestionsQuery && (
                  <button
                    type="button"
                    data-testid="questions-search-clear-empty"
                    onClick={() => setQuestionsSearch("")}
                    className="text-[10.5px] font-medium text-indigo-500 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer"
                  >
                    {t(locale, "sidebar.clearFilterBtn")}
                  </button>
                )}
              </div>
            ) : (
              filteredQuestions.map((item) => (
                <QuestionCard
                  key={item.id}
                  item={item}
                  locale={locale}
                  onSelect={() => onSelectQuestion?.(item)}
                />
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
});

export interface ProjectTaskGroupSectionProps {
  group: TaskProjectGroup;
  section: TaskSidebarSection;
  locale: UiLocale;
  isCollapsed: boolean;
  forceExpanded?: boolean;
  totalCountInGroup?: number;
  onToggleCollapse: (collapseKey: string) => void;
  renderTaskCard: (task: AgentTask) => React.ReactNode;
}

export const ProjectTaskGroupSection: React.FC<ProjectTaskGroupSectionProps> = ({
  group,
  section,
  locale,
  isCollapsed,
  forceExpanded = false,
  totalCountInGroup,
  onToggleCollapse,
  renderTaskCard,
}) => {
  const collapseKey = makeProjectGroupCollapseKey(section, group.groupKey);
  const isExpanded = forceExpanded || !isCollapsed;
  const totalInProject = totalCountInGroup ?? group.tasks.length;
  const countBadgeText = formatCompletedCountBadge(
    group.tasks.length,
    totalInProject,
    forceExpanded,
  );

  return (
    <div
      data-testid="project-group-section"
      data-project-group={group.groupKey}
      data-section={section}
      className="space-y-1.5"
    >
      <button
        type="button"
        data-testid="project-group-header"
        data-project-group={group.groupKey}
        data-section={section}
        aria-expanded={isExpanded}
        onClick={() => {
          if (!forceExpanded) {
            onToggleCollapse(collapseKey);
          }
        }}
        title={
          forceExpanded
            ? t(locale, "sidebar.projectGroupMatchTitle", {
                filtered: group.tasks.length,
                total: totalInProject,
              })
            : isExpanded
              ? t(locale, "sidebar.projectGroupCollapseTitle", { name: group.projectName })
              : t(locale, "sidebar.projectGroupExpandTitle", { name: group.projectName })
        }
        className={`w-full flex items-center justify-between gap-1.5 px-1.5 py-1 rounded-lg text-left transition-colors ${
          forceExpanded
            ? "bg-indigo-500/[0.08] dark:bg-indigo-500/[0.14] cursor-default"
            : "hover:bg-zinc-200/55 dark:hover:bg-zinc-800/60 cursor-pointer"
        }`}
      >
        <span className="inline-flex items-center gap-1.5 min-w-0">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-zinc-400 shrink-0" />
          )}
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: group.colorHex }}
          />
          <span className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 truncate">
            {group.projectName}
          </span>
        </span>
        <span className="inline-flex items-center gap-1 shrink-0">
          {group.runningCount > 0 && (
            <span
              data-testid="project-group-running-badge"
              title={t(locale, "sidebar.projectGroupRunningTitle", {
                count: group.runningCount,
              })}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9.5px] font-semibold bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 tabular-nums"
            >
              <Loader2 className="w-2.5 h-2.5 animate-spin shrink-0" />
              {group.runningCount}
            </span>
          )}
          {group.needsReviewCount > 0 && (
            <span
              data-testid="project-group-review-badge"
              title={t(locale, "sidebar.projectGroupReviewTitle", {
                count: group.needsReviewCount,
              })}
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9.5px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 tabular-nums"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
              {group.needsReviewCount}
            </span>
          )}
          <span
            data-testid="project-group-count"
            title={
              forceExpanded
                ? t(locale, "sidebar.projectGroupMatchTitle", {
                    filtered: group.tasks.length,
                    total: totalInProject,
                  })
                : t(locale, "sidebar.projectGroupTotalTitle", {
                    count: group.tasks.length,
                  })
            }
            className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 tabular-nums"
          >
            {countBadgeText}
          </span>
        </span>
      </button>

      {isExpanded && (
        <div
          data-testid="project-group-tasks"
          data-project-group={group.groupKey}
          data-section={section}
          className="pl-2 ml-1.5 border-l border-zinc-200/80 dark:border-zinc-800/80 space-y-1.5"
        >
          {group.tasks.map((task) => renderTaskCard(task))}
        </div>
      )}
    </div>
  );
};

export interface TaskCardProps {
  task: AgentTask;
  colorHex: string;
  effectiveMode?: IntegrationMode;
  parentBranch?: string | null;
  locale?: UiLocale;
  hideProjectBadge?: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onOpenPreview: (url: string) => void;
  onMention: () => void;
  onUpdateStatus: (status: AgentTaskStatus) => void;
  onStop: () => void;
  onDelete: () => void;
  onLand?: (options?: { createPr?: boolean }) => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  colorHex,
  effectiveMode = "feature-branch",
  parentBranch = null,
  locale = "ja",
  hideProjectBadge = false,
  isSelected,
  onSelect,
  onOpenPreview,
  onMention,
  onUpdateStatus,
  onStop,
  onDelete,
  onLand,
}) => {
  const quickTransition = getQuickStatusTransition(task.status, locale);
  const subtitle = getTaskCardSubtitle(task);
  const isDone = task.status === "done";
  const hasActiveWorktree = Boolean(task.worktreePath && task.worktreeBranch);
  const isLanding = task.landStatus === "landing";
  const needsLand = requiresLandBeforeDone(task);
  const doneBlockedReason =
    quickTransition?.action === "done"
      ? getLocalizedMarkTaskDoneBlockedReason(task, locale)
      : null;
  const isQuickDoneBlocked = Boolean(doneBlockedReason);
  const canQuickLand =
    Boolean(onLand) &&
    hasActiveWorktree &&
    task.status !== "running" &&
    task.landStatus !== "landed";
  const isPrMode = effectiveMode === "per-task-pr";

  return (
    <div
      onClick={onSelect}
      className={`group rounded-xl p-2.5 border transition-colors cursor-pointer ${
        isSelected
          ? "bg-indigo-500/10 border-indigo-500/50"
          : isDone
            ? "bg-white/80 dark:bg-[#161a22] border-zinc-200/70 dark:border-zinc-800/80 hover:border-zinc-300 dark:hover:border-zinc-700"
            : "bg-white dark:bg-[#191d26] border-zinc-200/80 dark:border-zinc-800/90 hover:border-zinc-300 dark:hover:border-zinc-700"
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1.5">
        <TaskStatusIcon status={task.status} />
        <span
          className="px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 border border-indigo-500/20 shrink-0"
          title={`@${formatTaskCode(task.taskNumber)} / @${task.projectName}/${formatTaskCode(task.taskNumber)}`}
        >
          {formatTaskCode(task.taskNumber)}
        </span>
        {!hideProjectBadge && (
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-semibold truncate max-w-[96px]"
            style={{ backgroundColor: `${colorHex}22`, color: colorHex }}
          >
            {task.projectName}
          </span>
        )}
        {task.provider && (
          <span className="px-1.5 py-0.5 rounded text-[9.5px] font-medium bg-zinc-200/70 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
            {task.provider === "agy" ? "AGY" : task.provider === "claude" ? "Claude" : "Codex"}
          </span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {task.previewURL && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenPreview(task.previewURL!);
              }}
              title={t(locale, "sidebar.openInBrowserTitle")}
              className="p-1 rounded hover:bg-zinc-200/70 dark:hover:bg-zinc-700 text-zinc-500 cursor-pointer"
            >
              <Globe className="w-3 h-3" />
            </button>
          )}
          {task.status === "running" ? (
            <button
              type="button"
              data-testid="task-stop-worker"
              onClick={(e) => {
                e.stopPropagation();
                onStop();
              }}
              title={t(locale, "sidebar.stopWorker")}
              aria-label={`${task.title}: ${t(locale, "sidebar.stopWorker")}`}
              className="p-1 rounded hover:bg-rose-500/15 text-rose-500 cursor-pointer"
            >
              <Square className="w-3 h-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onMention();
              }}
              title={t(locale, "sidebar.mentionInChat")}
              className="p-1 rounded hover:bg-zinc-200/70 dark:hover:bg-zinc-700 text-zinc-500 cursor-pointer"
            >
              <MessageSquare className="w-3 h-3" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title={t(locale, "common.delete")}
            className="p-1 rounded hover:bg-rose-500/15 text-zinc-400 hover:text-rose-500 cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div
        className={`text-[12.5px] font-semibold leading-snug line-clamp-2 ${
          isDone ? "text-zinc-600 dark:text-zinc-300" : "text-zinc-900 dark:text-zinc-100"
        }`}
      >
        {task.title}
      </div>

      {/* Git Worktree / Land Status Badges */}
      {(task.worktreeBranch || task.landedBranch) && (
        <div className="mt-1 flex flex-wrap items-center gap-1 min-w-0">
          {task.landStatus === "landed" && task.landedBranch ? (
            <span
              data-testid="task-landed-badge"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-mono font-medium bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 max-w-full truncate"
              title={`Landed → ${task.landedBranch}`}
            >
              <GitMerge className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate">Landed → {task.landedBranch}</span>
            </span>
          ) : task.landStatus === "pr_created" ? (
            <span
              data-testid="task-pr-badge"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-mono font-medium bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 max-w-full truncate"
              title={task.prUrl ?? task.worktreeBranch ?? "PR Created"}
            >
              <GitPullRequest className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate">PR · {task.worktreeBranch}</span>
            </span>
          ) : task.landStatus === "pushed" ? (
            <span
              data-testid="task-pushed-badge"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-mono font-medium bg-sky-500/12 text-sky-700 dark:text-sky-300 max-w-full truncate"
              title={`Pushed: ${task.worktreeBranch}`}
            >
              <GitPullRequest className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate">Pushed · {task.worktreeBranch}</span>
            </span>
          ) : (
            task.worktreeBranch && (
              <>
                <span
                  data-testid="task-worktree-badge"
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-mono max-w-full truncate ${
                    task.landStatus === "conflict" || task.landStatus === "error"
                      ? "bg-rose-500/12 text-rose-600 dark:text-rose-400"
                      : "bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
                  }`}
                  title={
                    parentBranch
                      ? t(locale, "sidebar.worktreeTitleParent", {
                          branch: task.worktreeBranch,
                          parent: parentBranch,
                        })
                      : t(locale, "sidebar.worktreeTitle", { branch: task.worktreeBranch })
                  }
                >
                  <GitBranch className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate">{task.worktreeBranch}</span>
                </span>
                {needsLand && task.status !== "running" && (
                  <span
                    data-testid="task-unlanded-badge"
                    className="inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 shrink-0"
                    title={doneBlockedReason ?? undefined}
                  >
                    {t(locale, "task.unlandedBadge")}
                  </span>
                )}
              </>
            )
          )}
        </div>
      )}

      {task.landError && (task.landStatus === "conflict" || task.landStatus === "error") && (
        <div
          data-testid="task-land-error"
          className="mt-1 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-rose-500/10 text-rose-600 dark:text-rose-400 truncate"
          title={task.landError}
        >
          <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">{task.landError}</span>
        </div>
      )}

      <div className="mt-1.5 flex items-center justify-between gap-1.5 min-w-0">
        {subtitle ? (
          <div className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate flex-1 min-w-0">
            {subtitle}
          </div>
        ) : (
          <div className="flex-1" />
        )}
        <div className="flex items-center gap-1 shrink-0">
          {canQuickLand && (
            <button
              type="button"
              disabled={isLanding}
              data-testid="task-quick-land"
              onClick={(e) => {
                e.stopPropagation();
                onLand?.(isPrMode ? { createPr: true } : undefined);
              }}
              title={
                isPrMode
                  ? t(locale, "sidebar.pushPrTitle", { branch: task.worktreeBranch ?? "" })
                  : parentBranch
                    ? t(locale, "sidebar.landToBranchTitle", {
                        branch: parentBranch,
                        mode: effectiveMode,
                      })
                    : t(locale, "sidebar.landChangesTitle", { mode: effectiveMode })
              }
              aria-label={`${task.title}: ${isPrMode ? "Push / PR" : "Land"}`}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10.5px] font-medium border transition-colors shrink-0 ${
                isLanding
                  ? "bg-indigo-500/10 border-indigo-500/25 text-indigo-500 opacity-70 cursor-wait"
                  : task.landStatus === "conflict" || task.landStatus === "error"
                    ? "bg-amber-500/12 border-amber-500/35 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 cursor-pointer"
                    : "bg-indigo-500/10 border-indigo-500/25 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/20 hover:border-indigo-500/45 cursor-pointer"
              }`}
            >
              {isLanding ? (
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
              ) : isPrMode ? (
                <GitPullRequest className="w-2.5 h-2.5" />
              ) : (
                <GitMerge className="w-2.5 h-2.5" />
              )}
              <span>{isLanding ? "..." : isPrMode ? "Push/PR" : "Land"}</span>
            </button>
          )}
          {quickTransition && (
            <button
              type="button"
              disabled={isQuickDoneBlocked}
              aria-disabled={isQuickDoneBlocked || undefined}
              data-testid={`task-quick-${quickTransition.action}`}
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
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10.5px] font-medium border transition-colors shrink-0 ${
                isQuickDoneBlocked
                  ? "bg-zinc-100 dark:bg-zinc-800/60 border-zinc-200/80 dark:border-zinc-700/70 text-zinc-400 dark:text-zinc-500 opacity-60 cursor-not-allowed"
                  : isDone
                    ? "bg-zinc-100 dark:bg-zinc-800/80 border-zinc-200/90 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-indigo-500/12 hover:border-indigo-500/35 hover:text-indigo-600 dark:hover:text-indigo-300 cursor-pointer"
                    : "bg-emerald-500/10 border-emerald-500/25 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 hover:border-emerald-500/40 cursor-pointer"
              }`}
            >
              {isDone ? <RotateCcw className="w-2.5 h-2.5" /> : <Check className="w-2.5 h-2.5" />}
              <span>{quickTransition.label}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

function QuestionStatusIcon({ item, locale }: { item: QuestionItem; locale: UiLocale }) {
  if (item.status === "streaming") {
    return <Loader2 className="w-3.5 h-3.5 text-indigo-500 animate-spin shrink-0" />;
  }
  if (item.status === "error") {
    return (
      <span className="relative inline-flex items-center justify-center shrink-0">
        <XCircle className="w-3.5 h-3.5 text-rose-500" />
        {item.isUnread && (
          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-rose-500 ring-1 ring-white dark:ring-[#191d26]" />
        )}
      </span>
    );
  }
  if (item.status === "pending") {
    return <Clock className="w-3.5 h-3.5 text-zinc-400 shrink-0" />;
  }
  if (item.isUnread) {
    return (
      <span
        title={t(locale, "sidebar.questionUnreadTooltip")}
        className="w-2.5 h-2.5 mx-0.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/25 shrink-0"
      />
    );
  }
  return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500/80 shrink-0" />;
}

const QuestionCard: React.FC<{
  item: QuestionItem;
  locale: UiLocale;
  onSelect: () => void;
}> = React.memo(({ item, locale, onSelect }) => {
  const timeLabel = formatQuestionTime(item.updatedAt);
  const providerLabel =
    item.provider === "agy" ? "AGY" : item.provider === "claude" ? "Claude" : item.provider === "codex" ? "Codex" : null;

  const cardSurface = item.isUnread
    ? item.status === "error"
      ? "bg-rose-500/[0.08] dark:bg-rose-500/[0.12] border-rose-500/45 hover:border-rose-500/70"
      : "bg-emerald-500/[0.08] dark:bg-emerald-500/[0.12] border-emerald-500/45 hover:border-emerald-500/70"
    : item.status === "streaming"
      ? "bg-indigo-500/[0.06] dark:bg-indigo-500/[0.1] border-indigo-500/35 hover:border-indigo-500/55"
      : "bg-white dark:bg-[#191d26] border-zinc-200/80 dark:border-zinc-800/90 hover:border-zinc-300 dark:hover:border-zinc-700";

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left group rounded-xl p-2 border transition-colors cursor-pointer ${cardSurface}`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <QuestionStatusIcon item={item} locale={locale} />
        {item.status === "streaming" ? (
          <span className="text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 shrink-0">
            {t(locale, "sidebar.questionStreaming")}
          </span>
        ) : item.isUnread ? (
          <span
            className={`px-1.5 py-0.2 rounded-full text-[9.5px] font-semibold shrink-0 ${
              item.status === "error"
                ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            }`}
          >
            {t(locale, "sidebar.questionUnread")}
          </span>
        ) : item.status === "error" ? (
          <span className="text-[10px] font-medium text-rose-500 shrink-0">
            {t(locale, "common.error")}
          </span>
        ) : null}
        {providerLabel && (
          <span className="px-1 py-0.2 rounded text-[9px] font-medium bg-zinc-200/70 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 shrink-0">
            {providerLabel}
          </span>
        )}
        <div className="flex-1" />
        {timeLabel && (
          <span className="text-[10px] text-zinc-400 tabular-nums shrink-0">{timeLabel}</span>
        )}
      </div>

      <div className="text-[12px] font-medium leading-snug text-zinc-900 dark:text-zinc-100 line-clamp-2">
        {item.questionSnippet}
      </div>

      {((item.relatedTasks && item.relatedTasks.length > 0) ||
        (item.relatedProjects && item.relatedProjects.length > 0)) && (() => {
        const relatedTasks = item.relatedTasks ?? [];
        const coveredProjectIds = new Set(
          relatedTasks.map((rt) => rt.projectId).filter((id): id is string => Boolean(id)),
        );
        const coveredProjectNames = new Set(
          relatedTasks
            .map((rt) => rt.projectName.trim().toLowerCase())
            .filter(Boolean),
        );
        const standaloneProjects = (item.relatedProjects ?? []).filter((rp) => {
          if (rp.projectId && coveredProjectIds.has(rp.projectId)) return false;
          if (coveredProjectNames.has(rp.projectName.trim().toLowerCase())) return false;
          return true;
        });

        return (
          <div
            data-testid="question-relation-badges"
            className="mt-1 flex flex-wrap items-center gap-1 min-w-0"
          >
            {relatedTasks.map((rt) => {
              const colorHex = rt.projectColorHex || "#6366F1";
              const tooltip = [
                rt.projectName ? `${rt.taskCode} · ${rt.projectName}` : rt.taskCode,
                rt.taskTitle,
              ]
                .filter(Boolean)
                .join(": ");
              return (
                <span
                  key={`task:${rt.taskId || rt.taskNumber}`}
                  title={tooltip}
                  className="inline-flex items-center gap-1 max-w-full min-w-0"
                >
                  <span className="px-1 py-0.2 rounded font-mono text-[9.5px] font-semibold bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 border border-indigo-500/20 shrink-0">
                    {rt.taskCode}
                  </span>
                  {rt.projectName && (
                    <span
                      className="px-1 py-0.2 rounded text-[9.5px] font-semibold truncate max-w-[96px]"
                      style={{ backgroundColor: `${colorHex}22`, color: colorHex }}
                    >
                      {rt.projectName}
                    </span>
                  )}
                </span>
              );
            })}
            {standaloneProjects.map((rp) => {
              const colorHex = rp.projectColorHex || "#6366F1";
              return (
                <span
                  key={`project:${rp.projectId ?? rp.projectName.toLowerCase()}`}
                  title={rp.projectName}
                  className="px-1 py-0.2 rounded text-[9.5px] font-semibold truncate max-w-[110px]"
                  style={{ backgroundColor: `${colorHex}22`, color: colorHex }}
                >
                  {rp.projectName}
                </span>
              );
            })}
          </div>
        );
      })()}

      <div className="mt-1 flex items-center gap-1 text-[10.5px] text-zinc-500 dark:text-zinc-400 min-w-0">
        {item.status === "streaming" && item.hasRunningTool && (
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse shrink-0" />
        )}
        <span className="truncate">{item.detailLine}</span>
      </div>
    </button>
  );
});
