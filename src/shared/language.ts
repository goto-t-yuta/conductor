export type PreferredLanguage = "ja" | "en" | "auto";

export const DEFAULT_PREFERRED_LANGUAGE: PreferredLanguage = "ja";

export interface LanguageOption {
  id: PreferredLanguage;
  label: string;
  shortLabel: string;
  description: string;
}

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  {
    id: "ja",
    label: "日本語",
    shortLabel: "日本語",
    description:
      "オーケストレーターのチャット返信、タスクのタイトル・要約、ワーカーの完了レポートを常に日本語で出力します。",
  },
  {
    id: "en",
    label: "English",
    shortLabel: "English",
    description:
      "Always write Orchestrator chat replies, task titles/summaries, and worker completion reports in English.",
  },
  {
    id: "auto",
    label: "自動 (Auto)",
    shortLabel: "自動",
    description:
      "ユーザーの入力言語に合わせて、チャット返信・タスク名・ワーカー報告の言語を自動で切り替えます。",
  },
] as const;

export function isValidPreferredLanguage(value: unknown): value is PreferredLanguage {
  return value === "ja" || value === "en" || value === "auto";
}

export function getLanguageOption(lang: PreferredLanguage): LanguageOption {
  return LANGUAGE_OPTIONS.find((opt) => opt.id === lang) ?? LANGUAGE_OPTIONS[0]!;
}

export function buildOrchestratorLanguageInstruction(lang: PreferredLanguage): string {
  switch (lang) {
    case "ja":
      return [
        "Output Language Policy (Japanese / 日本語 — REQUIRED):",
        "Always write ALL chat replies, task `title`, task `summary`, and `current_step` arguments passed to `start_worker`, `create_task`, and `update_task` in natural Japanese (日本語), even if project names, code, error logs, or tool schemas are in English.",
        "Keep code identifiers, file paths, branch names, URLs, and CLI commands exact.",
      ].join(" ");
    case "en":
      return [
        "Output Language Policy (English — REQUIRED):",
        "Always write ALL chat replies, task `title`, task `summary`, and `current_step` arguments passed to `start_worker`, `create_task`, and `update_task` in clear, natural English, even if the user writes in another language.",
        "Keep code identifiers, file paths, branch names, URLs, and CLI commands exact.",
      ].join(" ");
    case "auto":
      return [
        "Output Language Policy (Auto — Match User Language):",
        "Match the user's input language (e.g., natural Japanese when the user writes Japanese, English when the user writes English) for ALL chat replies, task `title`, task `summary`, and `current_step` arguments passed to `start_worker`, `create_task`, and `update_task`.",
        "Keep code identifiers, file paths, branch names, URLs, and CLI commands exact.",
      ].join(" ");
  }
}

export function buildOrchestratorLiveLanguageLine(lang: PreferredLanguage): string {
  switch (lang) {
    case "ja":
      return "Output language preference: Japanese (ja) — reply and write all task titles, summaries, and current_step values in natural Japanese (日本語).";
    case "en":
      return "Output language preference: English (en) — reply and write all task titles, summaries, and current_step values in clear English.";
    case "auto":
      return "Output language preference: Auto (auto) — match the user's input language for replies and all task titles, summaries, and current_step values.";
  }
}

export function buildWorkerLanguageInstruction(lang: PreferredLanguage): string {
  switch (lang) {
    case "ja":
      return "Output Language (REQUIRED): Write all progress summaries, final completion reports, and user-facing explanations in natural Japanese (日本語), while keeping code symbols, file paths, branch names, URLs, and CLI commands exact.";
    case "en":
      return "Output Language (REQUIRED): Write all progress summaries, final completion reports, and user-facing explanations in clear English, while keeping code symbols, file paths, branch names, URLs, and CLI commands exact.";
    case "auto":
      return "Output Language: Match the language of the task request (natural Japanese when the prompt is in Japanese, clear English when in English) for all progress summaries, final completion reports, and user-facing explanations, while keeping code symbols, file paths, branch names, URLs, and CLI commands exact.";
  }
}
