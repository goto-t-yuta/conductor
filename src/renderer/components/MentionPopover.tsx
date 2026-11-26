import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Folder,
  GitBranch,
  Loader2,
  XCircle,
} from "lucide-react";
import type { AgentTask, Project } from "../../shared/types.js";
import {
  formatTaskCode,
  type ActiveMentionQuery,
  type MentionSuggestion,
} from "../../shared/mentions.js";
import { formatTaskStatusLabel, t, type UiLocale } from "../../shared/i18n.js";
import {
  MENTION_POPOVER_BATCH_SIZE,
  MENTION_POPOVER_INITIAL_LIMIT,
  computeMentionPopoverVisibleCount,
} from "../lib/composer-perf.js";
import { ProjectNamePill, TaskCodePill } from "./MentionChips.js";

interface MentionPopoverProps {
  query: ActiveMentionQuery;
  suggestions: MentionSuggestion[];
  scopedProject: Project | null;
  activeIndex: number;
  locale?: UiLocale;
  onHoverIndex: (index: number) => void;
  onSelect: (suggestion: MentionSuggestion) => void;
}

function MentionTaskStatusIcon({ status }: { status: AgentTask["status"] }) {
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

function compactPath(fullPath: string): string {
  const normalized = fullPath.replace(/^\/Users\/[^/]+/, "~");
  const parts = normalized.split("/");
  if (parts.length <= 3) return normalized;
  return `${parts[0]}/…/${parts.slice(-2).join("/")}`;
}

export const MentionPopover: React.FC<MentionPopoverProps> = React.memo(({
  query,
  suggestions,
  scopedProject,
  activeIndex,
  locale = "ja",
  onHoverIndex,
  onSelect,
}) => {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [renderLimit, setRenderLimit] = useState(MENTION_POPOVER_INITIAL_LIMIT);

  useEffect(() => {
    setRenderLimit(MENTION_POPOVER_INITIAL_LIMIT);
  }, [query.start, query.rawQuery, query.mode]);

  const visibleCount = computeMentionPopoverVisibleCount(
    suggestions.length,
    activeIndex,
    renderLimit,
    MENTION_POPOVER_BATCH_SIZE,
  );
  const visibleSuggestions =
    visibleCount < suggestions.length ? suggestions.slice(0, visibleCount) : suggestions;
  const remainingCount = suggestions.length - visibleSuggestions.length;

  useEffect(() => {
    const activeEl = itemRefs.current[activeIndex];
    if (activeEl) {
      activeEl.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, visibleCount]);

  const handleListScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (remainingCount <= 0) return;
      const el = e.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) {
        setRenderLimit((prev) => Math.min(suggestions.length, prev + MENTION_POPOVER_BATCH_SIZE));
      }
    },
    [remainingCount, suggestions.length],
  );

  const headerTitle =
    query.mode === "project_tasks"
      ? t(locale, "mention.projectTasksTitle", { name: scopedProject?.name ?? query.projectQuery })
      : t(locale, "mention.defaultTitle");

  return (
    <div
      role="listbox"
      aria-label={t(locale, "mention.popoverAria")}
      className="absolute bottom-full left-0 right-0 mb-2 z-50 rounded-xl border border-zinc-200 dark:border-zinc-700/90 bg-white dark:bg-[#191d26] shadow-2xl overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-zinc-200/80 dark:border-zinc-800 bg-zinc-50/90 dark:bg-[#14171f] text-[10.5px] text-zinc-500 dark:text-zinc-400">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-semibold text-zinc-700 dark:text-zinc-200 truncate">
            {headerTitle}
          </span>
          <span className="px-1.5 py-0.2 rounded-full bg-zinc-200/70 dark:bg-zinc-800 text-[10px] font-medium">
            {suggestions.length}
          </span>
        </div>
        <span className="shrink-0 hidden sm:inline text-[10px] text-zinc-400">
          {t(locale, "mention.shortcutsHint")}
        </span>
      </div>

      {/* Items */}
      {suggestions.length === 0 ? (
        <div className="px-3.5 py-4 text-center text-[12px] text-zinc-500 dark:text-zinc-400">
          {query.mode === "project_tasks"
            ? t(locale, "mention.noProjectTasks", {
                name: scopedProject?.name ?? query.projectQuery,
              })
            : t(locale, "mention.noMatches")}
        </div>
      ) : (
        <div
          onScroll={handleListScroll}
          className="max-h-72 overflow-y-auto py-1"
        >
          {visibleSuggestions.map((item, idx) => {
            const isActive = idx === activeIndex;
            const prevKind = idx > 0 ? visibleSuggestions[idx - 1].kind : null;
            const showDivider = query.mode === "all" && prevKind !== null && prevKind !== item.kind;

            return (
              <React.Fragment key={item.id}>
                {showDivider && (
                  <div className="my-1 border-t border-zinc-200/70 dark:border-zinc-800" />
                )}
                <button
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onMouseEnter={() => onHoverIndex(idx)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onSelect(item);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors cursor-pointer ${
                    isActive
                      ? "bg-indigo-500/14 text-zinc-900 dark:text-white"
                      : "text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/70"
                  }`}
                >
                  {item.kind === "task" ? (
                    <>
                      <MentionTaskStatusIcon status={item.task.status} />
                      <TaskCodePill code={formatTaskCode(item.task.taskNumber)} />
                      {item.task.projectName && (
                        <ProjectNamePill
                          name={item.task.projectName}
                          colorHex={item.projectColorHex}
                          maxWidthClass="max-w-[110px]"
                        />
                      )}
                      <span className="flex-1 text-[12.5px] font-medium truncate">
                        {item.task.title}
                      </span>
                      <span className="text-[10.5px] text-zinc-400 shrink-0">
                        {formatTaskStatusLabel(item.task.status, locale)}
                      </span>
                    </>
                  ) : (
                    <>
                      <span
                        className="w-2.5 h-2.5 rounded-full shrink-0"
                        style={{ backgroundColor: item.project.colorHex }}
                      />
                      <Folder className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                      <span className="text-[12.5px] font-semibold truncate">
                        @{item.project.name}
                      </span>
                      {item.project.gitBranch && (
                        <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-200/70 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[100px] truncate">
                          <GitBranch className="w-2.5 h-2.5 shrink-0" />
                          <span className="truncate">{item.project.gitBranch}</span>
                        </span>
                      )}
                      {item.taskCount > 0 && (
                        <span
                          className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 shrink-0"
                          title={t(locale, "mention.filterTasksTitle", { name: item.project.name })}
                        >
                          {item.taskCount} tasks · /
                        </span>
                      )}
                      <span className="flex-1 text-right text-[10.5px] font-mono text-zinc-400 truncate">
                        {compactPath(item.project.path)}
                      </span>
                    </>
                  )}
                </button>
              </React.Fragment>
            );
          })}
          {remainingCount > 0 && (
            <button
              type="button"
              data-testid="mention-popover-load-more"
              onMouseDown={(e) => {
                e.preventDefault();
                setRenderLimit((prev) =>
                  Math.min(suggestions.length, prev + MENTION_POPOVER_BATCH_SIZE),
                );
              }}
              className="w-full px-3 py-1.5 text-center text-[11px] text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/70 transition-colors cursor-pointer"
            >
              +{remainingCount}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
