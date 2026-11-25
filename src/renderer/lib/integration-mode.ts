import type { IntegrationMode, Project } from "../../shared/types.js";

export interface IntegrationModeOption {
  id: IntegrationMode;
  label: string;
  shortLabel: string;
  badgeText: string;
  description: string;
}

export const INTEGRATION_MODE_OPTIONS: readonly IntegrationModeOption[] = [
  {
    id: "feature-branch",
    label: "Feature Branch（既定）",
    shortLabel: "Feature Branch",
    badgeText: "Branch",
    description:
      "親リポジトリが main / master の場合は自動で conductor/<slug> ブランチを作成し、後続タスクも同じブランチへリベースして順次統合します。",
  },
  {
    id: "per-task-pr",
    label: "Per-Task PR",
    shortLabel: "Per-Task PR",
    badgeText: "PR",
    description:
      "親リポジトリへマージせずタスク専用ブランチを保持し、リモートへの Push や PR 作成を行います。",
  },
  {
    id: "direct",
    label: "Direct",
    shortLabel: "Direct",
    badgeText: "Direct",
    description:
      "main / master を含む現在の親ブランチへ直接リベース＆取り込みを行い、完了後に Worktree を削除します。",
  },
] as const;

export function getIntegrationModeOption(mode: IntegrationMode): IntegrationModeOption {
  return (
    INTEGRATION_MODE_OPTIONS.find((opt) => opt.id === mode) ?? INTEGRATION_MODE_OPTIONS[0]!
  );
}

export function getEffectiveProjectMode(
  project: Project | null | undefined,
  defaultMode: IntegrationMode,
): IntegrationMode {
  return project?.integrationMode ?? defaultMode;
}
