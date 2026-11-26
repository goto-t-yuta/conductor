import type { IntegrationMode, Project } from "../../shared/types.js";
import { getLocalizedIntegrationModeMeta, type UiLocale } from "../../shared/i18n.js";

export interface IntegrationModeOption {
  id: IntegrationMode;
  label: string;
  shortLabel: string;
  badgeText: string;
  description: string;
}

const INTEGRATION_MODE_IDS: readonly IntegrationMode[] = [
  "feature-branch",
  "per-task-pr",
  "direct",
] as const;

export function getIntegrationModeOptions(locale: UiLocale = "ja"): IntegrationModeOption[] {
  return INTEGRATION_MODE_IDS.map((id) => ({
    id,
    ...getLocalizedIntegrationModeMeta(id, locale),
  }));
}

export const INTEGRATION_MODE_OPTIONS: readonly IntegrationModeOption[] =
  getIntegrationModeOptions("ja");

export function getIntegrationModeOption(
  mode: IntegrationMode,
  locale: UiLocale = "ja",
): IntegrationModeOption {
  return {
    id: mode,
    ...getLocalizedIntegrationModeMeta(mode, locale),
  };
}

export function getEffectiveProjectMode(
  project: Project | null | undefined,
  defaultMode: IntegrationMode,
): IntegrationMode {
  return project?.integrationMode ?? defaultMode;
}
