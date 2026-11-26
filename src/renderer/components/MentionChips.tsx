import React from "react";
import { X } from "lucide-react";
import type { ResolvedMentionChip } from "../../shared/mentions.js";
import { t, type UiLocale } from "../../shared/i18n.js";

export interface TaskCodePillProps {
  code: string;
}

export const TaskCodePill: React.FC<TaskCodePillProps> = ({ code }) => (
  <span className="px-1.5 py-0.5 rounded font-mono text-[10.5px] font-semibold leading-none bg-indigo-500/15 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-300 shrink-0">
    {code}
  </span>
);

export interface ProjectNamePillProps {
  name: string;
  colorHex: string;
  maxWidthClass?: string;
}

export const ProjectNamePill: React.FC<ProjectNamePillProps> = ({
  name,
  colorHex,
  maxWidthClass = "max-w-[120px]",
}) => (
  <span
    className={`px-1.5 py-0.5 rounded text-[10.5px] font-semibold leading-none shrink-0 truncate ${maxWidthClass}`}
    style={{
      backgroundColor: `${colorHex}22`,
      color: colorHex,
    }}
  >
    {name}
  </span>
);

export interface DraftMentionContextBarProps {
  chips: ResolvedMentionChip[];
  locale?: UiLocale;
  onRemoveChip: (chip: ResolvedMentionChip) => void;
  hasAttachmentsAbove?: boolean;
}

export const DraftMentionContextBar: React.FC<DraftMentionContextBarProps> = ({
  chips,
  locale = "ja",
  onRemoveChip,
  hasAttachmentsAbove = false,
}) => {
  if (chips.length === 0) return null;

  return (
    <div
      role="list"
      aria-label={t(locale, "mention.selectedAria")}
      data-testid="draft-mention-context-bar"
      className={`flex flex-wrap items-center gap-1.5 px-3 ${
        hasAttachmentsAbove ? "pt-1.5" : "pt-2.5"
      }`}
    >
      {chips.map((chip) => {
        if (chip.kind === "task") {
          const tooltip = chip.projectName
            ? `${chip.taskCode} · ${chip.projectName}: ${chip.task.title}`
            : `${chip.taskCode}: ${chip.task.title}`;

          return (
            <div
              key={chip.key}
              role="listitem"
              data-testid={`draft-mention-chip-task-${chip.task.taskNumber}`}
              data-mention-kind="task"
              data-task-code={chip.taskCode}
              title={tooltip}
              className="inline-flex items-center gap-1.5 pl-1.5 pr-1 py-1 rounded-lg max-w-full bg-indigo-500/[0.07] dark:bg-indigo-500/[0.13] border border-indigo-500/20 dark:border-indigo-400/25 text-[11.5px]"
            >
              <TaskCodePill code={chip.taskCode} />
              {chip.projectName && (
                <ProjectNamePill name={chip.projectName} colorHex={chip.projectColorHex} />
              )}
              <span className="max-w-[200px] sm:max-w-[260px] truncate font-medium text-zinc-700 dark:text-zinc-200">
                {chip.task.title}
              </span>
              <button
                type="button"
                data-testid={`draft-mention-remove-task-${chip.task.taskNumber}`}
                onClick={() => onRemoveChip(chip)}
                title={t(locale, "mention.removeTaskTitle", { code: chip.taskCode })}
                aria-label={t(locale, "mention.removeTaskAria", {
                  code: chip.taskCode,
                  title: chip.task.title,
                })}
                className="p-0.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-700/70 transition-colors cursor-pointer shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          );
        }

        return (
          <div
            key={chip.key}
            role="listitem"
            data-testid={`draft-mention-chip-project-${chip.project.id}`}
            data-mention-kind="project"
            data-project-name={chip.projectName}
            title={chip.project.path}
            className="inline-flex items-center gap-1 pl-1.5 pr-1 py-1 rounded-lg max-w-full bg-zinc-200/55 dark:bg-zinc-800/80 border border-zinc-300/60 dark:border-zinc-700/70 text-[11.5px]"
          >
            <ProjectNamePill
              name={chip.projectName}
              colorHex={chip.projectColorHex}
              maxWidthClass="max-w-[180px]"
            />
            <button
              type="button"
              data-testid={`draft-mention-remove-project-${chip.project.id}`}
              onClick={() => onRemoveChip(chip)}
              title={t(locale, "mention.removeProjectTitle", { name: chip.projectName })}
              aria-label={t(locale, "mention.removeProjectTitle", { name: chip.projectName })}
              className="p-0.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-100 hover:bg-zinc-200/70 dark:hover:bg-zinc-700/70 transition-colors cursor-pointer shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
