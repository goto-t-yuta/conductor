import React from "react";
import { Folder } from "lucide-react";
import type { ResolvedMessageMentionBadge } from "../../shared/mentions.js";
import { t, type UiLocale } from "../../shared/i18n.js";
import { ProjectNamePill, TaskCodePill } from "./MentionChips.js";

export interface MentionBadgeItemProps {
  badge: ResolvedMessageMentionBadge;
  locale?: UiLocale;
  onOpenTask?: (taskId: string) => void;
}

export function formatMentionBadgeTooltip(badge: ResolvedMessageMentionBadge): string {
  if (badge.kind === "task") {
    const prefix = badge.projectName
      ? `${badge.taskCode} · ${badge.projectName}`
      : badge.taskCode;
    return badge.taskTitle ? `${prefix}: ${badge.taskTitle}` : prefix;
  }
  return badge.projectPath ? `${badge.projectName} (${badge.projectPath})` : badge.projectName;
}

export const MentionBadgeItem: React.FC<MentionBadgeItemProps> = ({
  badge,
  locale = "ja",
  onOpenTask,
}) => {
  const tooltip = formatMentionBadgeTooltip(badge);

  if (badge.kind === "task") {
    const clickable = badge.isLiveTask && Boolean(badge.taskId) && Boolean(onOpenTask);
    const content = (
      <>
        <TaskCodePill code={badge.taskCode} />
        {badge.projectName && (
          <ProjectNamePill name={badge.projectName} colorHex={badge.projectColorHex} />
        )}
        {badge.taskTitle && (
          <span className="max-w-[200px] sm:max-w-[260px] truncate font-medium text-zinc-700 dark:text-zinc-200">
            {badge.taskTitle}
          </span>
        )}
      </>
    );

    if (clickable) {
      return (
        <button
          type="button"
          data-testid="user-message-mention-badge"
          data-mention-kind="task"
          data-mention-source={badge.source ?? "explicit"}
          data-task-code={badge.taskCode}
          onClick={() => onOpenTask?.(badge.taskId)}
          title={tooltip}
          aria-label={t(locale, "mention.openTaskAria", { tooltip })}
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg max-w-full bg-indigo-500/[0.08] dark:bg-indigo-500/[0.15] hover:bg-indigo-500/[0.14] dark:hover:bg-indigo-500/[0.22] border border-indigo-500/20 dark:border-indigo-400/25 hover:border-indigo-500/40 text-[11.5px] text-zinc-700 dark:text-zinc-200 transition-colors cursor-pointer"
        >
          {content}
        </button>
      );
    }

    return (
      <div
        data-testid="user-message-mention-badge"
        data-mention-kind="task"
        data-mention-source={badge.source ?? "explicit"}
        data-task-code={badge.taskCode}
        title={tooltip}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg max-w-full bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/70 text-[11.5px] text-zinc-600 dark:text-zinc-300"
      >
        {content}
      </div>
    );
  }

  return (
    <div
      data-testid="user-message-mention-badge"
      data-mention-kind="project"
      data-mention-source={badge.source ?? "explicit"}
      data-project-name={badge.projectName}
      title={tooltip}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg max-w-full bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200/80 dark:border-zinc-700/70 text-[11.5px] text-zinc-700 dark:text-zinc-200"
    >
      <Folder className="w-3 h-3 text-zinc-400 shrink-0" />
      <ProjectNamePill
        name={badge.projectName}
        colorHex={badge.projectColorHex}
        maxWidthClass="max-w-[180px]"
      />
    </div>
  );
};

export interface UserMessageMentionBadgesProps {
  badges: readonly ResolvedMessageMentionBadge[];
  locale?: UiLocale;
  onOpenTask?: (taskId: string) => void;
}

export const UserMessageMentionBadges: React.FC<UserMessageMentionBadgesProps> = ({
  badges,
  locale = "ja",
  onOpenTask,
}) => {
  if (badges.length === 0) return null;
  return (
    <>
      {badges.map((badge) => (
        <MentionBadgeItem key={badge.key} badge={badge} locale={locale} onOpenTask={onOpenTask} />
      ))}
    </>
  );
};
