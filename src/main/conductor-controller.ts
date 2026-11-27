import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentProvider,
  AgentTask,
  AgentTaskStatus,
  AppSnapshot,
  ChatAttachment,
  ChatMessage,
  ChatMessageMentionRef,
  ChatSession,
  ExplicitMentionTarget,
  IntegrationMode,
  LandTaskResult,
  ModelOption,
  PreferredLanguage,
  Project,
  ProviderQuotaSnapshot,
  ProviderQuotasMap,
  ProviderQuotaWindow,
  ProviderStatus,
  RemoteAccessStatus,
  SendMessagePayload,
  TaskStatusUpdateResult,
  TaskWorktreeStatus,
  TokenUsage,
  UsageBudgetSettings,
  UsageRecord,
  UsageSource,
} from "../shared/types.js";
import { PROJECT_PALETTE } from "../shared/types.js";
import {
  appendUsageRecord,
  createUsageRecord,
  mergeProviderQuotaSnapshot,
  normalizeRawTokenUsage,
  normalizeUsageBudgetSettings,
  normalizeUsageRecords,
  type NormalizedRawUsage,
} from "../shared/usage.js";
import {
  DEFAULT_PREFERRED_LANGUAGE,
  buildOrchestratorLanguageInstruction,
  buildOrchestratorLiveLanguageLine,
  buildWorkerLanguageInstruction,
  isValidPreferredLanguage,
} from "../shared/language.js";
import { DEFAULT_VOICE_READBACK_ENABLED } from "../shared/voice.js";
import {
  getFriendlyToolLabel,
  resolveUiLocale,
  t,
  type UiLocale,
} from "../shared/i18n.js";
import {
  MAX_CHAT_SESSIONS,
  MAX_MESSAGES_PER_SESSION,
  capChatSessionsPreservingActive,
  createEmptyChatSession,
  deriveChatSessionPreview,
  deriveChatSessionTitle,
  normalizeChatSessions,
  toChatSessionSummary,
} from "../shared/chat-sessions.js";
import {
  buildExplicitMentionContextSection,
  createProjectMentionRef,
  createTaskMentionRef,
  extractMentionRefsForMessage,
  formatTaskCode,
  mergeChatMessageMentionRefs,
  normalizeTaskNumbers,
} from "../shared/mentions.js";
import {
  RUNNING_TASK_DONE_BLOCKED_REASON,
  validateManualTaskStatusTransition,
} from "../shared/task-status.js";
import type { BrowserManager } from "./browser-manager.js";
import {
  AgyAcpClient,
  parseAgySessionUpdate,
  type AgyAcpMcpServerConfig,
  type AgyAcpSessionUpdate,
} from "./agy-acp-client.js";
import {
  defaultClaudeModels,
  fastestAgyModel,
  listAgyModels,
  runAgyTurn,
  runClaudeTurn,
  strongestAgyModel,
  writeAgyOrchestratorMcpPlugin,
  writeClaudeMcpConfig,
  type CliTurnUsage,
  type RunningCliTurn,
} from "./cli-agent-runner.js";
import {
  CodexAppServerClient,
  extractCodexRateLimitUpdate,
  extractCodexTokenUsage,
  type CodexExtractedTokenUsage,
  type CodexNotification,
} from "./codex-client.js";
import {
  createTaskWorktree,
  getGitHeadCommit,
  inspectTaskWorktree,
  isValidIntegrationMode,
  landTaskWorktree,
  removeTaskWorktree,
  resolveEffectiveIntegrationMode,
} from "./git-worktree.js";
import {
  LocalMCPServer,
  conductorMCPTools,
  type MCPToolCallContext,
  type MCPToolResult,
} from "./local-mcp-server.js";
import { getMimeTypeForImagePath, MAX_IMAGE_FILE_BYTES } from "./image-viewer.js";
import { mergeDiscoveredProjects, scanLocalProjectSeeds } from "./project-discovery.js";
import {
  DEFAULT_REMOTE_ACCESS_PORT,
  RemoteBridgeServer,
  generateRemoteAccessToken,
  normalizeRemoteAccessPort,
  parseImageDataUrl,
  type TailscaleNetworkInfo,
} from "./remote-server.js";
import {
  canonicalDirectory,
  getGitBranch,
  getGitStatusSummary,
  resolveClaudeExecutable,
  resolveCodexExecutable,
} from "./shell-env.js";
import type { StateStore } from "./state-store.js";
import {
  buildFallbackRerunPrompt,
  buildSessionResumePrompt,
  markTasksForAutoResumeOnShutdown,
  prepareTasksForStartupAutoResume,
} from "./task-auto-resume.js";
import {
  buildCliFallbackFollowUpPrompt,
  buildCliSteerPrompt,
  getGitDiffStat,
  readRecentAgyTranscriptExcerpt,
  resolveAgyTranscriptPath,
  resolveTaskWorkingDir,
  truncateTaskText,
} from "./task-inspection.js";

interface ResponderLane {
  threadId: string;
  activeTurnId: string | null;
  activeAssistantMessageId: string | null;
  activeModel?: string | null;
  pendingUsage?: TokenUsage | null;
  streamedItemIds?: Set<string>;
  lastAgentMessageItemId?: string | null;
}

interface AgyResponderLane {
  laneId?: string;
  sessionId: string;
  activeAssistantMessageId: string | null;
  currentModel: string | null;
  currentEffort: string | null;
  cancelled: boolean;
  hasStreamedText: boolean;
  syncPromise: Promise<void> | null;
  pendingTools: Map<string, string>;
  pendingUsage?: NormalizedRawUsage | null;
}

interface InFlightMcpToolCall {
  itemId: string;
  assistantMessageId: string;
  toolName: string;
  argsKey: string | null;
  startedAt: number;
}

interface PendingUnattributedMcpRef {
  toolName: string;
  argsKey: string | null;
  ref: ChatMessageMentionRef;
  createdAt: number;
}

function appendUrlQueryParam(baseUrl: string, key: string, value: string): string {
  try {
    const parsed = new URL(baseUrl);
    parsed.searchParams.set(key, value);
    return parsed.toString();
  } catch {
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

function buildMcpArgsCorrelationKey(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
): string | null {
  if (!args) return null;
  const pick = (k: string): string => {
    const v = args[k];
    return typeof v === "string" ? v.trim() : "";
  };
  switch (toolName) {
    case "send_to_worker":
    case "get_task_detail":
    case "update_task":
    case "stop_worker": {
      const taskId = pick("task_id").toLowerCase();
      return taskId ? `task:${taskId}` : null;
    }
    case "browser_open": {
      const taskId = pick("task_id").toLowerCase();
      const url = pick("url");
      return taskId ? `browser:${taskId}:${url}` : url ? `browser::${url}` : null;
    }
    case "start_worker": {
      const taskId = pick("task_id").toLowerCase();
      const proj = (pick("project_name") || pick("project_path")).toLowerCase();
      const title = pick("title");
      const promptPrefix = pick("prompt").slice(0, 64);
      if (taskId || proj || title || promptPrefix) {
        return `start:${taskId}|${proj}|${title}|${promptPrefix}`;
      }
      return null;
    }
    case "create_task": {
      const proj = pick("project_name").toLowerCase();
      const title = pick("title");
      return proj || title ? `create:${proj}|${title}` : null;
    }
    case "register_project": {
      const p = pick("path");
      return p ? `register:${p}` : null;
    }
    default:
      return null;
  }
}

export function fastestEffortForModel(model: ModelOption): string {
  for (const preferred of ["low", "minimal", "none", "medium"]) {
    if (model.supportedEfforts.includes(preferred)) {
      return preferred;
    }
  }
  return model.supportedEfforts[0] ?? model.defaultEffort;
}

export function buildOrchestratorDeveloperInstructions(
  preferredLanguage: PreferredLanguage = DEFAULT_PREFERRED_LANGUAGE,
): string {
  return [
    "You are **Conductor**, the fast, responsive single-chat orchestrator inside a macOS desktop workspace.",
    "",
    "Core Philosophy (CRITICAL):",
    "1. **Speed first**: The user may rapid-fire multiple questions or requests without waiting. Keep chat replies fast, crisp, and non-blocking.",
    "2. **Always execute work via `start_worker` by default (DO NOT use `create_task` for work requests)**: Whenever the user asks to add, implement, fix, investigate, edit, build, test, or work on something in a project—including short phrases like 「追加して」「やって」「直して」「調べて」—DO NOT block this chat turn with long shell commands. ALWAYS call `start_worker` immediately (which both creates the task card in the left Agent Tasks sidebar and starts an asynchronous background worker in that project's cwd), then reply concisely confirming what you kicked off. Note that `start_worker` also accepts `task_id` (UUID or `T#` code) to start an existing `queued` task. Do NOT call `create_task` unless the user explicitly asks to only queue/memo/register a task without running it yet (e.g., 「キューに入れといて」「まだ動かさないで」「タスクだけ登録して」).",
    "   - **Respect repository `AGENTS.md` policies in `start_worker` prompts**: Do NOT write narrower completion criteria in `start_worker`'s `prompt` than the target repository's `AGENTS.md` (or `CLAUDE.md` / `GEMINI.md`) verification, deployment, or operational policy (for example, do not tell a worker to stop at local tests when the repository requires dev deployment or live testing). Write instructions on the assumption that the worker will follow the repository's guidelines unless the user explicitly asks to exclude specific steps.",
    "3. **Non-blocking read-only task Q&A vs. `send_to_worker` steering (STRICT)**:",
    "   - When the user asks a **question, status/progress check, design/code inquiry, or error-cause investigation about a task** (e.g., 「今どうなってる？」「どこまで進んだ？」「どんな実装？」「なんでエラー？」), ONLY call `get_task_detail` (and read-only inspection of files/logs/worktree if needed) and answer **immediately**.",
    "   - NEVER call `send_to_worker` just to ask a question about a task, and NEVER wait or poll for a running task to finish before answering.",
    "   - Call `send_to_worker` **ONLY** when the user explicitly wants to give additional instructions, change direction / steer a running worker, fix something, or resume work on that task.",
    "4. **Full Chromium Browser Automation**: The right pane is a real Chromium browser controlled via CDP tools (`browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_scroll`, `browser_screenshot`, `browser_console_errors`). When the user asks to test, inspect, click, fill forms, or debug console/network errors in the browser, use `browser_snapshot` to inspect refs (`e1`, `e2`, ...) and interact directly!",
    "5. **Project discovery & memory**: If the user mentions a project not in the top list, call `search_projects` first. If you locate a new project directory via filesystem or the user asks to add a parent directory's repos, call `register_project` or `scan_directory_projects` so Conductor permanently remembers it in its project list.",
    "6. **Explicit target mentions**: Users may explicitly attach project/task mention chips (without repeating `@...` in the message text) or type `@<projectName>`, `@T<number>`, or `@<projectName>/T<number>` inline (e.g., `@agent_terminal_2`, `@T1`, `@agent_terminal_2/T1`). When an `[Explicitly Mentioned Context]` section is provided, treat those resolved projects and tasks as authoritative targets—operate directly on their exact path, project name, `task_id` (UUID), or `T#` code without guessing.",
    "7. **Answer quick questions directly**: For quick questions, status checks, or browser inspection, reply directly without creating unnecessary tasks.",
    `8. **Language (STRICT)**: ${buildOrchestratorLanguageInstruction(preferredLanguage)}`,
  ].join("\n");
}

export const WORKER_REPO_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;

function findInstructionFileInDir(dir: string): string | null {
  for (const fileName of WORKER_REPO_INSTRUCTION_FILES) {
    const candidate = path.join(dir, fileName);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // ignore missing/inaccessible candidate
    }
  }
  return null;
}

export function findWorkerRepoInstructionFile(
  cwd: string,
  fallbackDir?: string | null,
): string | null {
  const trimmedCwd = cwd.trim();
  if (trimmedCwd) {
    const inCwd = findInstructionFileInDir(trimmedCwd);
    if (inCwd) return inCwd;
  }
  const trimmedFallback = fallbackDir?.trim();
  if (
    trimmedFallback &&
    (!trimmedCwd || path.resolve(trimmedFallback) !== path.resolve(trimmedCwd))
  ) {
    return findInstructionFileInDir(trimmedFallback);
  }
  return null;
}

export function buildWorkerRepoGuidelinesInstruction(
  cwd: string,
  fallbackDir?: string | null,
): string | null {
  const instructionFilePath = findWorkerRepoInstructionFile(cwd, fallbackDir);
  if (!instructionFilePath) return null;
  return [
    "Repository Guidelines (REQUIRED):",
    `- Required reading: ${instructionFilePath}`,
    "- Read and follow this file BEFORE starting work.",
    "- Include all deployment, verification, and operational rules documented there (e.g., mandatory dev deployment, live/staging checks, test procedures, cleanup steps) in this task's completion criteria unless explicitly excluded by the task instructions. Do not stop at local tests alone when the file requires further steps.",
  ].join("\n");
}

export function buildWorkerVisualVerificationInstruction(): string {
  return [
    "Frontend / UI Visual Verification (REQUIRED):",
    "- Whenever your task modifies frontend UI, layout, styles, CSS, or visual components, BEFORE returning your final completion report, capture the updated UI as a screenshot (PNG/JPG/WebP/GIF) or screen recording video (MP4/WebM/MOV) and save it to a persistent local file path.",
    "- ALWAYS embed the captured media directly in your final Markdown completion report using standard Markdown image syntax with an absolute path or `file://` URL, e.g. `![Updated UI](/absolute/path/to/screenshot.png)` or `![UI Walkthrough](/absolute/path/to/demo.mp4)` (if the path contains spaces such as macOS `Application Support`, wrap it in angle brackets like `![Updated UI](</abs/path/with spaces/screenshot.png>)`; Conductor renders local images and `.mp4`/`.webm`/`.mov` videos inline in chat and task details).",
    "- Only omit media when capturing a screenshot or video is technically impossible in the current environment (for example, no runnable UI/dev server or headless display limitation); in that case, explicitly state the concrete technical reason in your final report.",
  ].join("\n");
}

export function buildWorkerDeveloperInstructions(options: {
  projectName: string;
  cwd: string;
  projectPath?: string | null;
  worktreeBranch?: string | null;
  preferredLanguage?: PreferredLanguage;
}): string {
  const base = options.worktreeBranch
    ? `You are a focused coding worker for project "${options.projectName}" working in an isolated git worktree at ${options.cwd} (branch "${options.worktreeBranch}"). Complete the assigned task thoroughly, run checks/tests, and return a concise summary including changed files or local preview URLs.`
    : `You are a focused coding worker for project "${options.projectName}" (${options.cwd}). Complete the assigned task thoroughly, run checks/tests, and return a concise summary including changed files or local preview URLs.`;
  const repoGuidelinesInstruction = buildWorkerRepoGuidelinesInstruction(
    options.cwd,
    options.projectPath,
  );
  const visualInstruction = buildWorkerVisualVerificationInstruction();
  const langInstruction = buildWorkerLanguageInstruction(
    options.preferredLanguage ?? DEFAULT_PREFERRED_LANGUAGE,
  );
  return [base, repoGuidelinesInstruction, visualInstruction, langInstruction]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

export const DEFAULT_TASK_COMPLETION_EXCERPT_CHARS = 420;
const MAX_TASK_COMPLETION_EXCERPT_MEDIA = 6;

interface ExtractedMediaSpan {
  start: number;
  end: number;
  raw: string;
  key: string;
}

function findFencedCodeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const lineRe = /[^\r\n]*(?:\r?\n|$)/g;
  let activeFence: { char: string; length: number; start: number } | null = null;
  let match: RegExpExecArray | null;

  while ((match = lineRe.exec(text)) !== null) {
    const line = match[0];
    if (!line) break;
    const lineStart = match.index;
    const lineEnd = lineStart + line.length;
    const stripped = line.replace(/\r?\n$/, "");
    const fenceMatch = stripped.match(/^\s{0,3}(`{3,}|~{3,})/);

    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      const char = marker[0]!;
      if (!activeFence) {
        activeFence = { char, length: marker.length, start: lineStart };
      } else if (
        activeFence.char === char &&
        marker.length >= activeFence.length &&
        /^\s{0,3}(`{3,}|~{3,})\s*$/.test(stripped)
      ) {
        ranges.push({ start: activeFence.start, end: lineEnd });
        activeFence = null;
      }
    }
  }

  if (activeFence) {
    ranges.push({ start: activeFence.start, end: text.length });
  }
  return ranges;
}

function isInsideRanges(
  start: number,
  end: number,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  return ranges.some((r) => start >= r.start && end <= r.end);
}

function extractMediaKey(raw: string): string {
  const mdAngleMatch = raw.match(/^!\[[^\]\r\n]*\]\(\s*<([^>\r\n]+)>/);
  if (mdAngleMatch) {
    return (mdAngleMatch[1] ?? raw).trim();
  }
  const mdMatch = raw.match(
    /^!\[[^\]\r\n]*\]\(\s*([^)\r\n]+?)(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?\s*\)$/,
  );
  if (mdMatch) {
    return (mdMatch[1] ?? raw).trim();
  }
  const srcMatch = raw.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
  if (srcMatch) {
    return (srcMatch[1] ?? srcMatch[2] ?? srcMatch[3] ?? raw).trim();
  }
  return raw.trim();
}

function extractTaskReportMediaSpans(text: string): ExtractedMediaSpan[] {
  const codeRanges = findFencedCodeRanges(text);
  const candidates: ExtractedMediaSpan[] = [];

  const patterns = [
    /!\[[^\]\r\n]*\]\((?:<[^>\r\n]+>|(?:\/|~\/|~\\|\.\.?[\\/]|file:\/\/|[a-zA-Z]:[\\/])[^)\r\n<>]*?\.(?:png|jpe?g|jfif|webp|gif|bmp|svg|ico|avif|mp4|webm|mov)(?:[?#][^\s)]*)?(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?|[^)\s\r\n]+(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'))?)\)/gi,
    /<video\b[^>]*>[\s\S]*?<\/video>/gi,
    /<img\b[^>]*\/?>/gi,
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (isInsideRanges(start, end, codeRanges)) continue;
      candidates.push({
        start,
        end,
        raw: m[0].trim(),
        key: extractMediaKey(m[0]),
      });
    }
  }

  candidates.sort((a, b) => a.start - b.start || b.end - a.end);

  // Drop spans contained within an earlier span (e.g. <img> inside <video>)
  const spans: ExtractedMediaSpan[] = [];
  for (const item of candidates) {
    const prev = spans[spans.length - 1];
    if (prev && item.start < prev.end) {
      continue;
    }
    spans.push(item);
  }
  return spans;
}

function closeUnclosedFenceIfNeeded(text: string): string {
  const lines = text.split(/\r?\n/);
  let activeFence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!fenceMatch) continue;
    const marker = fenceMatch[1]!;
    const char = marker[0]!;
    if (!activeFence) {
      activeFence = { char, length: marker.length };
    } else if (
      activeFence.char === char &&
      marker.length >= activeFence.length &&
      /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)
    ) {
      activeFence = null;
    }
  }
  if (!activeFence) return text;
  return `${text}\n${activeFence.char.repeat(activeFence.length)}`;
}

/**
 * Builds a concise excerpt of a worker's completion output for chat `TaskEvent` cards
 * while preserving attached Markdown/HTML images and videos that would otherwise be cut off.
 */
export function buildTaskCompletionExcerpt(
  output: string,
  maxTextChars = DEFAULT_TASK_COMPLETION_EXCERPT_CHARS,
): string {
  const trimmed = output.trim();
  if (!trimmed) return "";

  const limit = Math.max(1, maxTextChars);
  if (trimmed.length <= limit) {
    return trimmed;
  }

  const mediaSpans = extractTaskReportMediaSpans(trimmed);
  let cutIndex = limit;

  // Never slice through the middle of a Markdown image/video or HTML media tag
  const overlapping = mediaSpans.find((span) => span.start < cutIndex && span.end > cutIndex);
  if (overlapping) {
    cutIndex = overlapping.start;
  }

  let head = trimmed.slice(0, cutIndex).trimEnd();
  if (head) {
    head = closeUnclosedFenceIfNeeded(head);
    if (!/[…]$/.test(head)) {
      head = `${head}…`;
    }
  }

  if (mediaSpans.length === 0) {
    return head || trimmed.slice(0, limit);
  }

  const includedKeys = new Set(
    mediaSpans.filter((span) => span.end <= cutIndex).map((span) => span.key),
  );
  const appendedMedia: string[] = [];

  for (const span of mediaSpans) {
    if (includedKeys.has(span.key)) continue;
    includedKeys.add(span.key);
    appendedMedia.push(span.raw);
    if (appendedMedia.length >= MAX_TASK_COMPLETION_EXCERPT_MEDIA) {
      break;
    }
  }

  if (appendedMedia.length === 0) {
    return head;
  }

  return head ? `${head}\n\n${appendedMedia.join("\n\n")}` : appendedMedia.join("\n\n");
}

export const MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS = 2;

export function buildConflictResolutionPrompt(options: {
  taskTitle: string;
  worktreePath: string;
  worktreeBranch: string;
  targetBranch: string;
  parentHead: string;
  conflictFiles: string[];
  attempt: number;
  maxAttempts?: number;
  preferredLanguage?: PreferredLanguage;
}): string {
  const maxAttempts = options.maxAttempts ?? MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS;
  const filesSection =
    options.conflictFiles.length > 0
      ? options.conflictFiles.map((f) => `- ${f}`).join("\n")
      : "- (Run `git status` after starting rebase/merge to inspect conflicted files)";

  const langInstruction = buildWorkerLanguageInstruction(
    options.preferredLanguage ?? DEFAULT_PREFERRED_LANGUAGE,
  );

  return [
    `Automatic landing of your worktree branch "${options.worktreeBranch}" onto "${options.targetBranch}" (commit ${options.parentHead}) encountered a merge/rebase conflict (attempt ${options.attempt}/${maxAttempts}).`,
    `The failed rebase was cleanly aborted so your isolated worktree at ${options.worktreePath} is clean and ready for conflict resolution.`,
    "",
    `Task: ${options.taskTitle}`,
    `Target branch: ${options.targetBranch}`,
    `Target commit SHA (parentHead): ${options.parentHead}`,
    "Conflicted files:",
    filesSection,
    "",
    "Instructions (execute ONLY inside your isolated worktree — NEVER modify the parent repository):",
    `1. Integrate target commit \`${options.parentHead}\` into your current branch via \`git rebase ${options.parentHead}\` (or \`git merge ${options.parentHead}\` if the history is complex) so that \`${options.parentHead}\` becomes an ancestor of \`HEAD\`.`,
    `2. Carefully resolve ALL conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) while **preserving BOTH this task's intent/changes AND the already-landed changes on \`${options.parentHead}\`** — never blindly drop either side.`,
    "3. Run the project's verification checks (typecheck / tests / build if applicable) to confirm the merged code compiles and works cleanly.",
    "4. Commit all resolved changes cleanly (`git rebase --continue` or `git commit`), verify `git status` is clean, and make sure NO rebase/merge/cherry-pick is left in progress.",
    "5. Return a concise summary of how the conflicts were resolved and the verification results.",
    "",
    langInstruction,
  ].join("\n");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function extractFirstLocalUrl(text: string): string | null {
  const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s)\]`"']*)?/);
  return match ? match[0] : null;
}

function friendlyToolLabel(name: string, locale: UiLocale = "ja"): string {
  return getFriendlyToolLabel(name, locale);
}

export class ConductorController {
  private readonly store: StateStore;
  private readonly browser: BrowserManager;
  private readonly emitSnapshot: (snapshot: AppSnapshot) => void;

  private projects: Project[] = [];
  private scanRoots: string[] = [];
  private tasks: AgentTask[] = [];
  private nextTaskNumber = 1;
  private chatSessions: ChatSession[] = [];
  private activeChatSessionId = "";
  private messages: ChatMessage[] = [];
  private chatSessionEpoch = 0;
  private chatSessionTransitionQueue: Promise<void> = Promise.resolve();
  private readonly snapshotEpoch = crypto.randomUUID();
  private snapshotVersion = 0;
  private readonly cancelledCodexTurns = new Set<string>();
  private readonly interruptingCodexThreadIds = new Set<string>();
  private codexPrewarmPromise: Promise<void> | null = null;
  private readonly rebindContextNeeded = new Set<string>();
  private readonly failedResumeIds = new Set<string>();
  private showTaskSidebar = true;
  private showBrowserPane = true;
  private isConnected = false;
  private connectionStatus = "起動中...";
  private providers: Record<AgentProvider, ProviderStatus> = {
    codex: { id: "codex", label: "Codex", available: false, detail: "確認中...", models: [] },
    agy: { id: "agy", label: "AGY", available: false, detail: "確認中...", models: [] },
    claude: { id: "claude", label: "Claude", available: false, detail: "確認中...", models: [] },
  };
  private chatProvider: AgentProvider = "codex";
  private workerProvider: AgentProvider = "codex";
  private chatModel: string | null = null;
  private chatEffort: string | null = null;
  private workerModel: string | null = null;
  private workerEffort: string | null = null;
  private defaultIntegrationMode: IntegrationMode = "feature-branch";
  private autoLandOnComplete = true;
  private preferredLanguage: PreferredLanguage = DEFAULT_PREFERRED_LANGUAGE;
  private voiceReadbackEnabled: boolean = DEFAULT_VOICE_READBACK_ENABLED;
  private remoteAccessEnabled = false;
  private remoteAccessPort = DEFAULT_REMOTE_ACCESS_PORT;
  private remoteAccessToken = generateRemoteAccessToken();
  private usageRecords: UsageRecord[] = [];
  private usageBudgets: UsageBudgetSettings = normalizeUsageBudgetSettings(undefined);
  private providerQuotas: ProviderQuotasMap = {};
  private readonly codexThreadLastTotalUsage = new Map<string, NormalizedRawUsage>();
  private readonly codexWorkerPendingUsage = new Map<string, TokenUsage>();
  private lastErrorBanner: string | null = null;
  private readonly repoLandLocks = new Map<string, Promise<unknown>>();
  private readonly activeConflictResolveTaskIds = new Set<string>();

  private mcpServer: LocalMCPServer | null = null;
  private remoteServer: RemoteBridgeServer | null = null;
  private readonly detectRemoteNetwork?: () => TailscaleNetworkInfo;
  private claudeMcpConfigPath: string | null = null;
  private agyMcpConfig: AgyAcpMcpServerConfig | null = null;
  private readonly orchestratorClient: CodexAppServerClient;
  private readonly workerClient: CodexAppServerClient;
  private readonly agyOrchestratorClient: AgyAcpClient;
  private readonly cliWorkerRunner: {
    runAgyTurn: typeof runAgyTurn;
    runClaudeTurn: typeof runClaudeTurn;
  };
  private responderLanes: ResponderLane[] = [];
  private agyResponderLanes: AgyResponderLane[] = [];
  private agyPrewarmPromise: Promise<void> | null = null;
  private isShuttingDown = false;
  private pendingAutoResumeTaskIds: string[] = [];
  private activeCliResponders = new Map<string, RunningCliTurn>();
  private activeCliWorkers = new Map<string, RunningCliTurn>();
  private readonly cliWorkerGenerations = new Map<string, number>();
  private readonly inFlightMcpToolCalls = new Map<string, InFlightMcpToolCall>();
  private pendingUnattributedMcpRefs: PendingUnattributedMcpRef[] = [];
  private readonly claudeTurnMcpConfigPaths = new Map<string, string>();
  private readonly agyBrainBaseDir: string;
  private readonly maxIdleLanes = 2;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private lastPersistedBrowserKey: string | null = null;

  constructor(options: {
    store: StateStore;
    browser: BrowserManager;
    onSnapshot: (snapshot: AppSnapshot) => void;
    orchestratorClient?: CodexAppServerClient;
    agyOrchestratorClient?: AgyAcpClient;
    workerClient?: CodexAppServerClient;
    cliWorkerRunner?: {
      runAgyTurn?: typeof runAgyTurn;
      runClaudeTurn?: typeof runClaudeTurn;
    };
    agyBrainBaseDir?: string;
    detectRemoteNetwork?: () => TailscaleNetworkInfo;
  }) {
    this.store = options.store;
    this.browser = options.browser;
    this.emitSnapshot = options.onSnapshot;
    this.orchestratorClient = options.orchestratorClient ?? new CodexAppServerClient("orchestrator");
    this.agyOrchestratorClient = options.agyOrchestratorClient ?? new AgyAcpClient("orchestrator");
    this.workerClient = options.workerClient ?? new CodexAppServerClient("worker");
    this.cliWorkerRunner = {
      runAgyTurn: options.cliWorkerRunner?.runAgyTurn ?? runAgyTurn,
      runClaudeTurn: options.cliWorkerRunner?.runClaudeTurn ?? runClaudeTurn,
    };
    this.agyBrainBaseDir =
      options.agyBrainBaseDir ?? path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
    this.detectRemoteNetwork = options.detectRemoteNetwork;

    this.loadPersisted();
    this.remoteServer = new RemoteBridgeServer(this, {
      port: this.remoteAccessPort,
      token: this.remoteAccessToken,
      detectNetwork: this.detectRemoteNetwork,
      onClientsChanged: () => this.scheduleBroadcast(),
    });

    this.orchestratorClient.onNotification((n) => this.handleOrchestratorNotification(n));
    this.orchestratorClient.onDisconnect((reason) => {
      this.isConnected = false;
      const interruptedMessageIds = this.responderLanes
        .map((l) => l.activeAssistantMessageId)
        .filter((id): id is string => Boolean(id));
      this.responderLanes = [];
      for (const msgId of interruptedMessageIds) {
        this.finishAssistantMessage(msgId, "接続が切断されました。");
      }
      if (interruptedMessageIds.length > 0) {
        this.persist();
      }
      this.connectionStatus = "切断されました";
      this.lastErrorBanner = reason;
      this.broadcastSnapshot();
    });

    this.agyOrchestratorClient.onSessionUpdate((update) => this.handleAgySessionUpdate(update));
    this.agyOrchestratorClient.onDisconnect((reason) => this.handleAgyOrchestratorDisconnect(reason));

    this.workerClient.onNotification((n) => this.handleWorkerNotification(n));
    this.workerClient.onDisconnect((reason) => {
      if (this.isShuttingDown) return;
      this.lastErrorBanner = `Worker接続エラー: ${reason}`;
      this.broadcastSnapshot();
    });
  }

  public getRunningTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.status === "running");
  }

  public getSnapshot(): AppSnapshot {
    const activeCodexLanes = this.responderLanes.filter((l) => l.activeAssistantMessageId !== null).length;
    const activeAgyLanes = this.agyResponderLanes.filter((l) => l.activeAssistantMessageId !== null).length;
    return {
      snapshotEpoch: this.snapshotEpoch,
      snapshotVersion: this.snapshotVersion,
      projects: this.projects,
      scanRoots: this.scanRoots,
      tasks: this.tasks,
      messages: this.messages,
      activeChatSessionId: this.activeChatSessionId,
      chatSessions: this.chatSessions.map((s) => toChatSessionSummary(s)),
      browserTabs: this.browser.getTabs(),
      activeBrowserTabId: this.browser.getActiveTabId(),
      isPickingElement: this.browser.isPickingElement(),
      showTaskSidebar: this.showTaskSidebar,
      showBrowserPane: this.showBrowserPane,
      isConnected: this.isConnected,
      connectionStatus: this.connectionStatus,
      activeResponderCount: activeCodexLanes + activeAgyLanes + this.activeCliResponders.size,
      providers: this.providers,
      chatProvider: this.chatProvider,
      workerProvider: this.workerProvider,
      models: this.providers[this.chatProvider].models,
      chatModel: this.chatModel,
      chatEffort: this.chatEffort,
      workerModel: this.workerModel,
      workerEffort: this.workerEffort,
      defaultIntegrationMode: this.defaultIntegrationMode,
      autoLandOnComplete: this.autoLandOnComplete,
      preferredLanguage: this.preferredLanguage,
      voiceReadbackEnabled: this.voiceReadbackEnabled,
      remoteAccessEnabled: this.remoteAccessEnabled,
      remoteAccessPort: this.remoteAccessPort,
      remoteAccessToken: this.remoteAccessToken,
      remoteAccess: this.getRemoteAccessStatus(),
      usageRecords: this.usageRecords,
      usageBudgets: this.usageBudgets,
      providerQuotas: this.providerQuotas,
      lastErrorBanner: this.lastErrorBanner,
    };
  }

  public notifyBrowserChanged(options?: { persist?: boolean }): void {
    const shouldPersist = options?.persist !== false;
    if (shouldPersist) {
      const nextBrowserKey = this.computePersistedBrowserKey();
      if (nextBrowserKey !== this.lastPersistedBrowserKey) {
        this.persist();
      }
      this.broadcastSnapshot();
      return;
    }
    // Coalesce transient browser metadata updates (isLoading, console/network errors, picker state)
    // so rapid CDP / navigation events never storm IPC or disk writes.
    this.scheduleBroadcast();
  }

  private computePersistedBrowserKey(): string {
    const activeId = this.browser.getActiveTabId() ?? "";
    const tabs = this.browser
      .getTabs()
      .map((t) => `${t.id}\0${t.title}\0${t.url}\0${t.projectId ?? ""}`)
      .join("\n");
    return `${activeId}\n${tabs}`;
  }

  public async start(): Promise<void> {
    this.isShuttingDown = false;
    this.connectionStatus = "ローカルMCP & エージェント接続中...";
    this.lastErrorBanner = null;
    this.discoverLocalWorkspaceProjects();
    this.broadcastSnapshot();

    try {
      if (!this.mcpServer) {
        this.mcpServer = new LocalMCPServer(conductorMCPTools(), (name, args, context) =>
          this.handleMCPToolCall(name, args, context),
        );
        await this.mcpServer.start();
      }
      const mcpUrl = this.mcpServer.getUrl();
      if (!mcpUrl) throw new Error("Failed to start embedded MCP server");

      this.agyMcpConfig = {
        name: "conductor",
        url: mcpUrl,
        bearerToken: this.mcpServer.bearerToken,
      };

      // Prepare isolated MCP configs for AGY and Claude inside Conductor's userData directory
      writeAgyOrchestratorMcpPlugin(this.store.baseDir, mcpUrl, this.mcpServer.bearerToken);
      this.claudeMcpConfigPath = writeClaudeMcpConfig(
        this.store.baseDir,
        mcpUrl,
        this.mcpServer.bearerToken,
      );

      // Probe & initialize Codex, AGY, and Claude in parallel
      await Promise.all([
        this.initCodexProvider(mcpUrl, this.mcpServer.bearerToken),
        this.initAgyProvider(),
        this.initClaudeProvider(),
      ]);

      // Pick an available default provider if the currently selected one isn't installed
      if (!this.providers[this.chatProvider].available) {
        const fallback = (["codex", "agy", "claude"] as AgentProvider[]).find(
          (p) => this.providers[p].available,
        );
        if (fallback) this.chatProvider = fallback;
      }
      if (!this.providers[this.workerProvider].available) {
        const fallback = (["codex", "agy", "claude"] as AgentProvider[]).find(
          (p) => this.providers[p].available,
        );
        if (fallback) this.workerProvider = fallback;
      }

      this.ensureValidChatModelForProvider();
      this.ensureValidWorkerModelForProvider();

      const readyLabels = (["codex", "agy", "claude"] as AgentProvider[])
        .filter((p) => this.providers[p].available)
        .map((p) => this.providers[p].label);

      this.isConnected = readyLabels.length > 0;
      this.connectionStatus =
        readyLabels.length > 0 ? `${readyLabels.join(" / ")} 利用可能` : "利用可能なCLIなし";
      if (this.remoteAccessEnabled && this.remoteServer && !this.remoteServer.isRunning()) {
        await this.remoteServer.start({
          port: this.remoteAccessPort,
          token: this.remoteAccessToken,
        });
      }
      this.persist();
      this.broadcastSnapshot();

      if (this.pendingAutoResumeTaskIds.length > 0 && !this.isShuttingDown) {
        void this.resumePendingInterruptedTasks();
      }

      if (this.providers.codex.available) {
        void this.discoverCodexHistoryProjects();
        void this.prewarmIdleLane();
      }
      if (this.chatProvider === "agy" && this.providers.agy.available) {
        if (this.agyOrchestratorClient.isConnected() && this.agyResponderLanes.length > 0) {
          void this.syncIdleAgyLanesModel();
        } else {
          void this.ensureAgyReadyAndPrewarm();
        }
      }
    } catch (err) {
      this.isConnected = false;
      this.connectionStatus = "接続エラー";
      this.lastErrorBanner = err instanceof Error ? err.message : String(err);
      if (this.pendingAutoResumeTaskIds.length > 0) {
        this.failPendingInterruptedTasks(
          `起動時の初期化エラーのため自動再開できませんでした: ${this.lastErrorBanner}`,
        );
      }
      this.broadcastSnapshot();
    }
  }

  private async initCodexProvider(mcpUrl: string, bearerToken: string): Promise<void> {
    if (!resolveCodexExecutable()) {
      this.providers = {
        ...this.providers,
        codex: { id: "codex", label: "Codex", available: false, detail: "codex CLI 未検出", models: [] },
      };
      return;
    }
    try {
      await Promise.all([
        this.orchestratorClient.connect({
          serverName: "conductor",
          url: mcpUrl,
          bearerTokenEnvVar: "CONDUCTOR_MCP_TOKEN",
          bearerToken,
        }),
        this.workerClient.connect(),
      ]);
      const models = await this.orchestratorClient.listModels().catch(() => []);
      this.providers = {
        ...this.providers,
        codex: {
          id: "codex",
          label: "Codex",
          available: true,
          detail: `接続済み (${models.length} models)`,
          models,
        },
      };
      void this.refreshProviderQuotas();
    } catch (err) {
      this.providers = {
        ...this.providers,
        codex: {
          id: "codex",
          label: "Codex",
          available: false,
          detail: err instanceof Error ? err.message : "接続失敗",
          models: [],
        },
      };
    }
  }

  private async initAgyProvider(): Promise<void> {
    if (!this.agyOrchestratorClient.isAvailable()) {
      this.providers = {
        ...this.providers,
        agy: { id: "agy", label: "AGY", available: false, detail: "agy CLI 未検出", models: [] },
      };
      return;
    }

    // Eagerly start resident `agy acp` when AGY is the active Orchestrator provider;
    // otherwise stay lazy (zero background process until switched to AGY).
    if (this.chatProvider === "agy") {
      try {
        const epoch = this.chatSessionEpoch;
        await this.ensureAgyOrchestratorConnected();
        const preferredSessionId = this.getPreferredResumableAgySessionId();
        const { lane: prewarmed } = await this.createOrResumeAgyLane(
          null,
          this.chatModel,
          this.chatEffort,
          preferredSessionId,
        );
        if (epoch === this.chatSessionEpoch) {
          this.agyResponderLanes.push(prewarmed);
        } else {
          void this.agyOrchestratorClient.closeSession(prewarmed.sessionId);
        }
        const acpModels = this.agyOrchestratorClient.getCachedModels();
        const models = acpModels.length > 0 ? acpModels : await listAgyModels();
        this.providers = {
          ...this.providers,
          agy: {
            id: "agy",
            label: "AGY",
            available: true,
            detail: `ACP 常駐接続済み (${models.length} models)`,
            models,
          },
        };
        return;
      } catch {
        // Fall back to CLI model probe; ACP will reconnect lazily on first message
      }
    }

    const models = await listAgyModels();
    this.providers = {
      ...this.providers,
      agy: {
        id: "agy",
        label: "AGY",
        available: true,
        detail: `利用可能 (${models.length} models · ACP待機)`,
        models,
      },
    };
  }

  private async initClaudeProvider(): Promise<void> {
    if (!resolveClaudeExecutable()) {
      this.providers = {
        ...this.providers,
        claude: { id: "claude", label: "Claude", available: false, detail: "claude CLI 未検出", models: [] },
      };
      return;
    }
    const models = defaultClaudeModels();
    this.providers = {
      ...this.providers,
      claude: {
        id: "claude",
        label: "Claude",
        available: true,
        detail: "利用可能 (Claude Code)",
        models,
      },
    };
  }

  private ensureValidChatModelForProvider(): void {
    const models = this.providers[this.chatProvider].models;
    if (models.length === 0) return;
    if (!this.chatModel || !models.some((m) => m.model === this.chatModel)) {
      if (this.chatProvider === "agy") {
        this.chatModel = fastestAgyModel(models);
        this.chatEffort = null;
      } else {
        const def = models.find((m) => m.isDefault) ?? models[0];
        this.chatModel = def.model;
        this.chatEffort = fastestEffortForModel(def);
      }
    } else if (this.chatProvider === "agy") {
      this.chatEffort = null;
    } else {
      const found = models.find((m) => m.model === this.chatModel);
      if (found && found.supportedEfforts.length > 0 && (!this.chatEffort || !found.supportedEfforts.includes(this.chatEffort))) {
        this.chatEffort = fastestEffortForModel(found);
      }
    }
  }

  private ensureValidWorkerModelForProvider(): void {
    const models = this.providers[this.workerProvider].models;
    if (models.length === 0) return;
    if (!this.workerModel || !models.some((m) => m.model === this.workerModel)) {
      if (this.workerProvider === "agy") {
        this.workerModel = strongestAgyModel(models);
        this.workerEffort = null;
      } else {
        const def = models.find((m) => m.isDefault) ?? models[0];
        this.workerModel = def.model;
        this.workerEffort = def.defaultEffort;
      }
    } else if (this.workerProvider === "agy") {
      this.workerEffort = null;
    } else {
      const found = models.find((m) => m.model === this.workerModel);
      if (found && found.supportedEfforts.length > 0 && (!this.workerEffort || !found.supportedEfforts.includes(this.workerEffort))) {
        this.workerEffort = found.defaultEffort;
      }
    }
  }

  private discoverLocalWorkspaceProjects(): void {
    const home = os.homedir();
    const defaultDocs = canonicalDirectory(path.join(home, "Documents"));
    const customRoots = this.scanRoots
      .map((dir) => ({ dir, requireGitOnly: false }));
    const roots: Array<{ dir: string; requireGitOnly: boolean }> = [
      ...customRoots,
      ...(defaultDocs && !this.scanRoots.includes(defaultDocs)
        ? [{ dir: defaultDocs, requireGitOnly: false }]
        : []),
      { dir: home, requireGitOnly: true },
    ];
    const seeds = scanLocalProjectSeeds({ roots, excludePaths: [this.store.baseDir] });
    this.projects = mergeDiscoveredProjects({
      existing: this.projects,
      seeds,
      excludePaths: [this.store.baseDir],
      resolveGitBranchForTopN: 25,
    });
    this.persist();
  }

  public scanDirectoryAndRegisterProjects(dirPath: string): Project[] {
    const canonical = canonicalDirectory(dirPath);
    if (!canonical) return [];
    if (!this.scanRoots.includes(canonical)) {
      this.scanRoots = [...this.scanRoots, canonical];
    }
    const beforePaths = new Set(this.projects.map((p) => p.path));
    const seeds = scanLocalProjectSeeds({
      roots: [{ dir: canonical, requireGitOnly: false }],
      excludePaths: [this.store.baseDir],
    });
    this.projects = mergeDiscoveredProjects({
      existing: this.projects,
      seeds,
      excludePaths: [this.store.baseDir],
      resolveGitBranchForTopN: 30,
    });
    this.persist();
    this.broadcastSnapshot();
    return this.projects.filter((p) => !beforePaths.has(p.path));
  }

  public async rescanAllProjects(): Promise<void> {
    this.discoverLocalWorkspaceProjects();
    this.broadcastSnapshot();
    if (this.isConnected) {
      await this.discoverCodexHistoryProjects();
    }
  }

  private async discoverCodexHistoryProjects(): Promise<void> {
    try {
      const cwds = await this.orchestratorClient.listRecentThreadCwds(150);
      if (cwds.length === 0) return;
      const seeds = cwds.map((item) => ({
        path: item.cwd,
        source: "codex_history" as const,
        lastActiveAt: item.updatedAtMs,
      }));
      this.projects = mergeDiscoveredProjects({
        existing: this.projects,
        seeds,
        excludePaths: [this.store.baseDir],
        resolveGitBranchForTopN: 30,
      });
      this.persist();
      this.broadcastSnapshot();
    } catch {
      // non-fatal if thread/list is unavailable
    }
  }

  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    const marked = markTasksForAutoResumeOnShutdown(this.tasks, this.pendingAutoResumeTaskIds);
    if (marked.markedTaskIds.length > 0) {
      this.tasks = marked.tasks;
    }
    this.pendingAutoResumeTaskIds = [];
    this.activeConflictResolveTaskIds.clear();
    // Persist auto-resume flags BEFORE terminating any child worker processes
    this.persist();
    for (const r of this.activeCliResponders.values()) r.cancel();
    this.activeCliResponders.clear();
    for (const assistantId of [...this.claudeTurnMcpConfigPaths.keys()]) {
      this.cleanupClaudeTurnMcpConfig(assistantId);
    }
    this.inFlightMcpToolCalls.clear();
    this.pendingUnattributedMcpRefs = [];
    for (const [taskId, w] of this.activeCliWorkers.entries()) {
      this.bumpCliWorkerGeneration(taskId);
      w.cancel();
    }
    this.activeCliWorkers.clear();
    for (const lane of this.agyResponderLanes) {
      if (lane.activeAssistantMessageId) {
        lane.cancelled = true;
        this.agyOrchestratorClient.cancelSession(lane.sessionId);
      }
    }
    this.agyResponderLanes = [];
    this.agyPrewarmPromise = null;
    this.agyOrchestratorClient.stop();
    this.orchestratorClient.stop();
    this.workerClient.stop();
    if (this.remoteServer) {
      await this.remoteServer.stop();
    }
    if (this.mcpServer) {
      await this.mcpServer.stop();
    }
  }

  // MARK: - Settings & Layout

  public setLayout(patch: { showTaskSidebar?: boolean; showBrowserPane?: boolean }): void {
    if (typeof patch.showTaskSidebar === "boolean") this.showTaskSidebar = patch.showTaskSidebar;
    if (typeof patch.showBrowserPane === "boolean") this.showBrowserPane = patch.showBrowserPane;
    this.persist();
    this.broadcastSnapshot();
  }

  public setChatProvider(provider: AgentProvider): void {
    const previousProvider = this.chatProvider;
    this.chatProvider = provider;
    this.chatModel = null;
    this.chatEffort = null;
    this.ensureValidChatModelForProvider();
    this.persist();
    this.broadcastSnapshot();

    if (provider === "agy" && this.providers.agy.available) {
      void this.ensureAgyReadyAndPrewarm();
    } else if (previousProvider === "agy" && provider !== "agy") {
      void this.shutdownAgyOrchestratorIfIdle();
    }
  }

  public setWorkerProvider(provider: AgentProvider): void {
    this.workerProvider = provider;
    this.workerModel = null;
    this.workerEffort = null;
    this.ensureValidWorkerModelForProvider();
    this.persist();
    this.broadcastSnapshot();
  }

  public setChatModel(model: string, effort?: string): void {
    this.chatModel = model;
    if (effort !== undefined) {
      this.chatEffort = effort || null;
    } else if (this.chatProvider === "agy") {
      this.chatEffort = null;
    } else {
      const found = this.providers[this.chatProvider].models.find((m) => m.model === model);
      if (found && (!this.chatEffort || !found.supportedEfforts.includes(this.chatEffort))) {
        this.chatEffort = fastestEffortForModel(found);
      }
    }
    this.persist();
    this.broadcastSnapshot();

    if (this.chatProvider === "agy" && this.agyOrchestratorClient.isConnected()) {
      void this.syncIdleAgyLanesModel();
    }
  }

  public setWorkerModel(model: string, effort?: string): void {
    this.workerModel = model;
    if (effort !== undefined) {
      this.workerEffort = effort || null;
    } else if (this.workerProvider === "agy") {
      this.workerEffort = null;
    } else {
      const found = this.providers[this.workerProvider].models.find((m) => m.model === model);
      if (found && (!this.workerEffort || !found.supportedEfforts.includes(this.workerEffort))) {
        this.workerEffort = found.defaultEffort;
      }
    }
    this.persist();
    this.broadcastSnapshot();
  }

  public dismissError(): void {
    this.lastErrorBanner = null;
    this.broadcastSnapshot();
  }

  public setDefaultIntegrationMode(mode: IntegrationMode): void {
    if (!isValidIntegrationMode(mode)) return;
    this.defaultIntegrationMode = mode;
    this.persist();
    this.broadcastSnapshot();
  }

  public setAutoLandOnComplete(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.autoLandOnComplete === next) return;
    this.autoLandOnComplete = next;
    this.persist();
    this.broadcastSnapshot();
  }

  public setPreferredLanguage(language: PreferredLanguage): void {
    if (!isValidPreferredLanguage(language)) return;
    if (this.preferredLanguage === language) return;
    this.preferredLanguage = language;
    this.persist();
    this.broadcastSnapshot();
    this.refreshIdleOrchestratorLanes();
  }

  public setVoiceReadbackEnabled(enabled: boolean): void {
    const next = Boolean(enabled);
    if (this.voiceReadbackEnabled === next) return;
    this.voiceReadbackEnabled = next;
    this.persist();
    this.broadcastSnapshot();
  }

  public clearUsageRecords(): void {
    if (this.usageRecords.length === 0) return;
    this.usageRecords = [];
    this.persist();
    this.broadcastSnapshot();
  }

  public setUsageBudgets(budgets: UsageBudgetSettings): void {
    this.usageBudgets = normalizeUsageBudgetSettings(budgets);
    this.persist();
    this.broadcastSnapshot();
  }

  private updateProviderQuota(snapshot: ProviderQuotaSnapshot): void {
    const prev = this.providerQuotas[snapshot.provider];
    const merged = mergeProviderQuotaSnapshot(prev, snapshot);
    this.providerQuotas = {
      ...this.providerQuotas,
      [snapshot.provider]: merged,
    };
    this.scheduleBroadcast();
  }

  private recordClaudeRateLimitWindow(window: ProviderQuotaWindow): void {
    this.updateProviderQuota({
      provider: "claude",
      status: "live",
      windows: [window],
      updatedAt: new Date().toISOString(),
    });
  }

  public async refreshProviderQuotas(): Promise<ProviderQuotasMap> {
    const codexClient = this.orchestratorClient.isConnected()
      ? this.orchestratorClient
      : this.workerClient.isConnected()
        ? this.workerClient
        : null;

    if (codexClient && typeof codexClient.readAccountRateLimits === "function") {
      try {
        const snapshot = await codexClient.readAccountRateLimits();
        if (snapshot) {
          this.providerQuotas = {
            ...this.providerQuotas,
            codex: mergeProviderQuotaSnapshot(this.providerQuotas.codex, snapshot),
          };
          this.broadcastSnapshot();
        }
      } catch {
        // Non-fatal: Codex quota endpoint may be unavailable for API-key or offline sessions
      }
    }

    return this.providerQuotas;
  }

  public getRemoteAccessStatus(): RemoteAccessStatus {
    if (this.remoteServer) {
      return this.remoteServer.getStatus(this.remoteAccessEnabled);
    }
    return {
      enabled: this.remoteAccessEnabled,
      running: false,
      port: this.remoteAccessPort,
      token: this.remoteAccessToken,
      bindHost: null,
      tailscaleIp: null,
      magicDnsName: null,
      lanIp: null,
      url: null,
      tailscaleUrl: null,
      magicDnsUrl: null,
      lanUrl: null,
      connectUri: null,
      linkUri: null,
      connectedClients: 0,
      error: null,
    };
  }

  public async setRemoteAccessEnabled(enabled: boolean): Promise<RemoteAccessStatus> {
    const next = Boolean(enabled);
    this.remoteAccessEnabled = next;
    if (this.remoteServer) {
      if (next) {
        await this.remoteServer.start({
          port: this.remoteAccessPort,
          token: this.remoteAccessToken,
        });
      } else {
        await this.remoteServer.stop();
      }
    }
    this.persist();
    this.broadcastSnapshot();
    return this.getRemoteAccessStatus();
  }

  public async setRemoteAccessPort(port: number): Promise<RemoteAccessStatus> {
    const normalized = normalizeRemoteAccessPort(port, this.remoteAccessPort);
    this.remoteAccessPort = normalized;
    if (this.remoteServer) {
      if (this.remoteAccessEnabled) {
        await this.remoteServer.start({
          port: this.remoteAccessPort,
          token: this.remoteAccessToken,
        });
      } else {
        // Recreate stopped server instance config with updated port
        await this.remoteServer.stop();
        this.remoteServer = new RemoteBridgeServer(this, {
          port: this.remoteAccessPort,
          token: this.remoteAccessToken,
          detectNetwork: this.detectRemoteNetwork,
          onClientsChanged: () => this.scheduleBroadcast(),
        });
      }
    }
    this.persist();
    this.broadcastSnapshot();
    return this.getRemoteAccessStatus();
  }

  public regenerateRemoteAccessToken(): RemoteAccessStatus {
    this.remoteAccessToken = generateRemoteAccessToken();
    this.remoteServer?.setToken(this.remoteAccessToken);
    this.persist();
    this.broadcastSnapshot();
    return this.getRemoteAccessStatus();
  }

  public refreshRemoteAccessStatus(): RemoteAccessStatus {
    this.remoteServer?.refreshNetwork();
    this.broadcastSnapshot();
    return this.getRemoteAccessStatus();
  }

  public saveRemoteImageAttachment(args: {
    buffer: Buffer;
    mimeType: string;
    label?: string;
  }): { imagePath: string; imageDataUrl: string } {
    return this.store.saveImageBuffer(args.buffer, args.mimeType, "mobile");
  }

  public getAttachmentImage(attachmentId: string): { buffer: Buffer; mimeType: string } | null {
    const trimmed = attachmentId.trim();
    if (!trimmed) return null;
    const orderedSessions = [
      this.getActiveChatSession(),
      ...this.chatSessions.filter((s) => s.id !== this.activeChatSessionId),
    ];
    for (const session of orderedSessions) {
      for (let i = session.messages.length - 1; i >= 0; i -= 1) {
        const msg = session.messages[i];
        const att = (msg.attachments ?? []).find((a) => a.id === trimmed && a.kind === "image");
        if (!att) continue;
        if (att.imagePath) {
          const mimeType = getMimeTypeForImagePath(att.imagePath);
          if (mimeType) {
            try {
              const stat = fs.statSync(att.imagePath);
              if (stat.isFile() && stat.size <= MAX_IMAGE_FILE_BYTES) {
                return { buffer: fs.readFileSync(att.imagePath), mimeType };
              }
            } catch {
              // fall back to imageDataUrl if available
            }
          }
        }
        if (att.imageDataUrl) {
          const parsed = parseImageDataUrl(att.imageDataUrl, MAX_IMAGE_FILE_BYTES);
          if (parsed.ok) {
            return { buffer: parsed.buffer, mimeType: parsed.mimeType };
          }
        }
        return null;
      }
    }
    return null;
  }

  private recordTurnUsage(input: {
    source: UsageSource;
    provider: AgentProvider;
    model?: string | null;
    projectName?: string | null;
    taskId?: string | null;
    tokens: TokenUsage;
    exactCostUsd?: number | null;
  }): void {
    const rec = createUsageRecord(input);
    if (!rec) return;
    this.usageRecords = appendUsageRecord(this.usageRecords, rec);
    this.persist();
    this.broadcastSnapshot();
  }

  private inferChatProjectName(assistantMessageId: string | null): string | null {
    if (!assistantMessageId) return null;
    const msg = this.messages.find((m) => m.id === assistantMessageId);
    if (!msg) return null;
    const names = new Set<string>();
    for (const ref of msg.inferredMentions ?? []) {
      if (ref.projectName) names.add(ref.projectName);
    }
    if (names.size === 0 && msg.replyToMessageId) {
      const userMsg = this.messages.find((m) => m.id === msg.replyToMessageId);
      for (const ref of userMsg?.mentions ?? []) {
        if (ref.projectName) names.add(ref.projectName);
      }
    }
    if (names.size === 1) {
      return [...names][0];
    }
    return null;
  }

  private accumulateCodexUsage(
    threadId: string,
    currentPending: TokenUsage | null | undefined,
    extracted: CodexExtractedTokenUsage,
  ): TokenUsage | null {
    let delta: TokenUsage | null = null;

    if (extracted.total) {
      const prevTotal = this.codexThreadLastTotalUsage.get(threadId);
      if (prevTotal) {
        delta = {
          inputTokens: Math.max(0, extracted.total.inputTokens - prevTotal.inputTokens),
          cachedInputTokens: Math.max(
            0,
            extracted.total.cachedInputTokens - prevTotal.cachedInputTokens,
          ),
          cacheCreationInputTokens: Math.max(
            0,
            extracted.total.cacheCreationInputTokens - prevTotal.cacheCreationInputTokens,
          ),
          outputTokens: Math.max(0, extracted.total.outputTokens - prevTotal.outputTokens),
          reasoningTokens: Math.max(
            0,
            extracted.total.reasoningTokens - prevTotal.reasoningTokens,
          ),
        };
      } else {
        delta = extracted.last ?? extracted.total;
      }
      this.codexThreadLastTotalUsage.set(threadId, extracted.total);
      if (this.codexThreadLastTotalUsage.size > 200) {
        const oldestKey = this.codexThreadLastTotalUsage.keys().next().value;
        if (oldestKey) this.codexThreadLastTotalUsage.delete(oldestKey);
      }
    } else if (extracted.last) {
      delta = extracted.last;
    } else if (extracted.direct && !currentPending) {
      delta = extracted.direct;
    }

    if (!delta) return currentPending ?? null;

    const deltaTotal =
      delta.inputTokens +
      delta.cachedInputTokens +
      (delta.cacheCreationInputTokens ?? 0) +
      delta.outputTokens;
    if (deltaTotal === 0) return currentPending ?? null;

    if (!currentPending) {
      return {
        inputTokens: delta.inputTokens,
        cachedInputTokens: delta.cachedInputTokens,
        ...(delta.cacheCreationInputTokens ? { cacheCreationInputTokens: delta.cacheCreationInputTokens } : {}),
        outputTokens: delta.outputTokens,
        ...(delta.reasoningTokens ? { reasoningTokens: delta.reasoningTokens } : {}),
      };
    }

    const cacheCreate =
      (currentPending.cacheCreationInputTokens ?? 0) + (delta.cacheCreationInputTokens ?? 0);
    const reasoning = (currentPending.reasoningTokens ?? 0) + (delta.reasoningTokens ?? 0);
    return {
      inputTokens: currentPending.inputTokens + delta.inputTokens,
      cachedInputTokens: currentPending.cachedInputTokens + delta.cachedInputTokens,
      ...(cacheCreate > 0 ? { cacheCreationInputTokens: cacheCreate } : {}),
      outputTokens: currentPending.outputTokens + delta.outputTokens,
      ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    };
  }

  private refreshIdleOrchestratorLanes(): void {
    this.responderLanes = this.responderLanes.filter((l) => l.activeAssistantMessageId !== null);

    const idleAgyLanes = this.agyResponderLanes.filter(
      (l) => l.activeAssistantMessageId === null && !l.cancelled,
    );
    if (idleAgyLanes.length > 0) {
      const idleSet = new Set(idleAgyLanes);
      this.agyResponderLanes = this.agyResponderLanes.filter((l) => !idleSet.has(l));
      for (const lane of idleAgyLanes) {
        void this.agyOrchestratorClient.closeSession(lane.sessionId);
      }
    }

    if (!this.isShuttingDown) {
      if (this.providers.codex.available && this.isConnected) {
        void this.prewarmIdleLane();
      }
      if (
        this.chatProvider === "agy" &&
        this.providers.agy.available &&
        this.agyOrchestratorClient.isConnected()
      ) {
        void this.prewarmAgyIdleLane();
      }
    }
  }

  public setProjectIntegrationMode(projectId: string, mode: IntegrationMode | null): void {
    if (mode !== null && !isValidIntegrationMode(mode)) return;
    let changed = false;
    this.projects = this.projects.map((p) => {
      if (p.id !== projectId) return p;
      changed = true;
      const next: Project = { ...p };
      if (mode === null) {
        delete next.integrationMode;
      } else {
        next.integrationMode = mode;
      }
      return next;
    });
    if (changed) {
      this.persist();
      this.broadcastSnapshot();
    }
  }

  public getEffectiveIntegrationModeForProject(
    projectId: string | null,
    projectPath: string | null,
  ): IntegrationMode {
    const project =
      (projectId ? this.projects.find((p) => p.id === projectId) : undefined) ??
      (projectPath ? this.projects.find((p) => p.path === projectPath) : undefined);
    return resolveEffectiveIntegrationMode({
      projectMode: project?.integrationMode,
      projectPath: project?.path ?? projectPath,
      globalDefault: this.defaultIntegrationMode,
    });
  }

  // MARK: - Projects

  public registerProject(inputPath: string, customName?: string): Project | null {
    const canonical = canonicalDirectory(inputPath);
    if (!canonical) return null;
    const now = new Date().toISOString();
    const existing = this.projects.find((p) => p.path === canonical);
    if (existing) {
      existing.source = "manual";
      existing.lastActiveAt = now;
      this.persist();
      this.broadcastSnapshot();
      return existing;
    }

    const name = customName?.trim() || path.basename(canonical) || canonical;
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      path: canonical,
      colorHex: PROJECT_PALETTE[this.projects.length % PROJECT_PALETTE.length],
      gitBranch: getGitBranch(canonical),
      addedAt: now,
      lastActiveAt: now,
      source: "manual",
    };
    this.projects = [project, ...this.projects];
    this.persist();
    this.broadcastSnapshot();
    return project;
  }

  public removeProject(projectId: string): void {
    this.projects = this.projects.filter((p) => p.id !== projectId);
    this.persist();
    this.broadcastSnapshot();
  }

  // MARK: - Unified Non-Blocking Chat (Rapid-Fire Parallel Responders)

  private getActiveChatSession(): ChatSession {
    const found = this.chatSessions.find((s) => s.id === this.activeChatSessionId);
    if (found) return found;
    const created = createEmptyChatSession(this.chatProvider);
    this.chatSessions = [created, ...this.chatSessions];
    this.activeChatSessionId = created.id;
    this.messages = created.messages;
    return created;
  }

  private syncActiveChatSession(touchUpdatedAt = false): void {
    const active = this.getActiveChatSession();
    const cappedMessages = this.messages.slice(-MAX_MESSAGES_PER_SESSION);
    if (cappedMessages.length !== this.messages.length) {
      this.messages = cappedMessages;
    }
    const nextUpdatedAt = touchUpdatedAt ? new Date().toISOString() : active.updatedAt;
    const updated: ChatSession = {
      ...active,
      title: deriveChatSessionTitle(cappedMessages),
      preview: deriveChatSessionPreview(cappedMessages),
      messages: cappedMessages,
      updatedAt: nextUpdatedAt,
      provider:
        cappedMessages.length > 0
          ? active.provider ?? this.chatProvider
          : this.chatProvider,
      backendSessionIds: { ...(active.backendSessionIds ?? {}) },
    };
    const nextSessions = this.chatSessions.map((s) => (s.id === active.id ? updated : s));
    this.chatSessions = capChatSessionsPreservingActive(
      nextSessions,
      active.id,
      MAX_CHAT_SESSIONS,
    );
  }

  private withChatSessionLock(action: () => Promise<void>): Promise<void> {
    const next = this.chatSessionTransitionQueue.then(action, action);
    this.chatSessionTransitionQueue = next.catch(() => {});
    return next;
  }

  private markCancelledCodexTurn(threadId: string, turnId: string | null): void {
    if (!threadId || !turnId) return;
    if (this.cancelledCodexTurns.size >= 200) {
      const oldest = this.cancelledCodexTurns.values().next().value;
      if (oldest) this.cancelledCodexTurns.delete(oldest);
    }
    this.cancelledCodexTurns.add(`${threadId}:${turnId}`);
  }

  private isMessageStreaming(messageId: string): boolean {
    const active = this.messages.find((m) => m.id === messageId);
    if (active) return active.isStreaming;
    for (const session of this.chatSessions) {
      const found = session.messages.find((m) => m.id === messageId);
      if (found) return found.isStreaming;
    }
    return false;
  }

  private appendMessagesToActiveChat(newMessages: ChatMessage[]): void {
    if (newMessages.length === 0) return;
    this.messages = [...this.messages, ...newMessages];
    this.snapshotVersion += 1;
    this.syncActiveChatSession(true);
  }

  private recordBackendSessionId(
    sessionId: string,
    provider: AgentProvider,
    backendId: string,
    options: { overwrite?: boolean } = {},
  ): void {
    if (!backendId) return;
    let changed = false;
    this.chatSessions = this.chatSessions.map((s) => {
      if (s.id !== sessionId) return s;
      const prev = s.backendSessionIds?.[provider];
      if (prev && !options.overwrite) return s;
      if (prev === backendId) return s;
      changed = true;
      return {
        ...s,
        backendSessionIds: {
          ...(s.backendSessionIds ?? {}),
          [provider]: backendId,
        },
      };
    });
    if (changed) {
      this.persist();
    }
  }

  private getPreferredResumableAgySessionId(sessionId = this.activeChatSessionId): string | null {
    const session = this.chatSessions.find((s) => s.id === sessionId);
    const savedId = session?.backendSessionIds?.agy ?? null;
    if (!savedId || this.failedResumeIds.has(`agy:${savedId}`)) return null;
    if (this.agyResponderLanes.some((l) => l.sessionId === savedId)) return null;
    return savedId;
  }

  private getPreferredResumableCodexThreadId(sessionId = this.activeChatSessionId): string | null {
    const session = this.chatSessions.find((s) => s.id === sessionId);
    const savedId = session?.backendSessionIds?.codex ?? null;
    if (!savedId || this.failedResumeIds.has(`codex:${savedId}`)) return null;
    if (this.interruptingCodexThreadIds.has(savedId)) return null;
    if (this.responderLanes.some((l) => l.threadId === savedId)) return null;
    return savedId;
  }

  private detachOrchestratorLanes(): void {
    this.chatSessionEpoch += 1;
    this.responderLanes = [];
    this.codexPrewarmPromise = null;
    const oldAgyLanes = this.agyResponderLanes;
    this.agyResponderLanes = [];
    this.agyPrewarmPromise = null;
    for (const lane of oldAgyLanes) {
      void this.agyOrchestratorClient.closeSession(lane.sessionId);
    }
  }

  public async sendMessage(payload: SendMessagePayload): Promise<void> {
    const trimmed = payload.text.trim();
    const rawAttachments = payload.attachments ?? [];
    const attachments: ChatAttachment[] = rawAttachments.map((att) => {
      if (att.kind === "image" && !att.imagePath && att.imageDataUrl) {
        const parsed = parseImageDataUrl(att.imageDataUrl, MAX_IMAGE_FILE_BYTES);
        if (parsed.ok) {
          const saved = this.store.saveImageBuffer(parsed.buffer, parsed.mimeType, "mobile");
          return {
            ...att,
            imagePath: saved.imagePath,
            imageDataUrl: saved.imageDataUrl,
          };
        }
      }
      return att;
    });
    const explicitMentions = Array.isArray(payload.mentions) ? payload.mentions : [];
    if (!trimmed && attachments.length === 0) return;

    this.lastErrorBanner = null;
    const displayUserText = trimmed || "(添付を参照してください)";
    const hadOtherActive =
      this.responderLanes.some((l) => l.activeAssistantMessageId !== null) ||
      this.agyResponderLanes.some((l) => l.activeAssistantMessageId !== null) ||
      this.activeCliResponders.size > 0;
    const activeSession = this.getActiveChatSession();
    const sessionId = activeSession.id;
    const selectedProvider = this.chatProvider;
    const recentHistoryWindow = this.buildRecentConversationWindow(10);
    const fullHistoryWindow = this.buildRecentConversationWindow(24);

    const mentionRefs = extractMentionRefsForMessage(
      displayUserText,
      this.projects,
      this.tasks,
      explicitMentions,
    );

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: displayUserText,
      attachments,
      ...(mentionRefs.length > 0 ? { mentions: mentionRefs } : {}),
      toolChips: [],
      isStreaming: false,
      createdAt: new Date().toISOString(),
    };

    const snippet = displayUserText.replace(/\s+/g, " ").slice(0, 44);
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      provider: selectedProvider,
      text: "",
      attachments: [],
      toolChips: [],
      replyToMessageId: userMsg.id,
      replyToSnippet: hadOtherActive ? snippet : undefined,
      isStreaming: true,
      createdAt: new Date().toISOString(),
    };

    this.appendMessagesToActiveChat([userMsg, assistantMsg]);
    this.persist();
    this.broadcastSnapshot();

    void this.dispatchParallelResponderTurn({
      chatSessionId: sessionId,
      provider: selectedProvider,
      assistantMessageId: assistantMsg.id,
      userText: displayUserText,
      attachments,
      explicitMentions,
      recentHistoryWindow,
      fullHistoryWindow,
      hadOtherActive,
    });
  }

  public async stopMessage(messageId: string): Promise<void> {
    const cliHandle = this.activeCliResponders.get(messageId);
    if (cliHandle) {
      this.activeCliResponders.delete(messageId);
      cliHandle.cancel();
      this.finishAssistantMessage(messageId, "停止しました。");
      this.persist();
      this.broadcastSnapshot();
      return;
    }

    const agyLaneIdx = this.agyResponderLanes.findIndex(
      (l) => l.activeAssistantMessageId === messageId,
    );
    if (agyLaneIdx !== -1) {
      const [lane] = this.agyResponderLanes.splice(agyLaneIdx, 1);
      lane.cancelled = true;
      lane.activeAssistantMessageId = null;
      this.agyOrchestratorClient.cancelSession(lane.sessionId);
      this.finishAssistantMessage(messageId, "停止しました。");
      this.persist();
      this.broadcastSnapshot();
      return;
    }

    const laneIdx = this.responderLanes.findIndex((l) => l.activeAssistantMessageId === messageId);
    if (laneIdx === -1) {
      this.finishAssistantMessage(messageId, "停止しました。");
      this.persist();
      this.broadcastSnapshot();
      return;
    }
    // Discard the interrupted lane from the pool so subsequent rapid-fire sends cannot reuse
    // the same thread while an interrupt / late turn/completed is still in flight.
    const [lane] = this.responderLanes.splice(laneIdx, 1);
    lane.activeAssistantMessageId = null;
    const interruptedTurnId = lane.activeTurnId;
    lane.activeTurnId = null;
    lane.pendingUsage = null;
    lane.streamedItemIds?.clear();
    lane.lastAgentMessageItemId = null;
    this.markCancelledCodexTurn(lane.threadId, interruptedTurnId);
    this.interruptingCodexThreadIds.add(lane.threadId);
    this.finishAssistantMessage(messageId, "停止しました。");
    this.persist();
    this.broadcastSnapshot();
    try {
      if (interruptedTurnId) {
        await this.orchestratorClient.interruptTurn(lane.threadId, interruptedTurnId).catch(() => {});
      }
    } finally {
      this.interruptingCodexThreadIds.delete(lane.threadId);
    }
    void this.prewarmIdleLane();
  }

  public async stopAllResponders(): Promise<void> {
    const activeCodexIds = this.responderLanes
      .map((l) => l.activeAssistantMessageId)
      .filter((id): id is string => Boolean(id));
    const activeAgyIds = this.agyResponderLanes
      .map((l) => l.activeAssistantMessageId)
      .filter((id): id is string => Boolean(id));
    const activeCliIds = [...this.activeCliResponders.keys()];
    await Promise.all(
      [...activeCodexIds, ...activeAgyIds, ...activeCliIds].map((id) => this.stopMessage(id)),
    );
  }

  public async startFreshChat(): Promise<void> {
    return this.withChatSessionLock(async () => {
      await this.stopAllResponders();
      this.syncActiveChatSession(false);

      const current = this.getActiveChatSession();
      this.detachOrchestratorLanes();

      if (current.messages.length === 0) {
        // Already on an empty chat — keep it clean without creating duplicate empty entries
        const now = new Date().toISOString();
        this.chatSessions = this.chatSessions.map((s) =>
          s.id === current.id
            ? { ...s, updatedAt: now, provider: this.chatProvider, backendSessionIds: {} }
            : s,
        );
        this.messages = [];
      } else {
        // Preserve the previous chat in history and create a fresh active session
        const fresh = createEmptyChatSession(this.chatProvider);
        this.chatSessions = capChatSessionsPreservingActive(
          [fresh, ...this.chatSessions],
          fresh.id,
          MAX_CHAT_SESSIONS,
        );
        this.activeChatSessionId = fresh.id;
        this.messages = [];
      }

      this.persist();
      this.broadcastSnapshot();
      if (this.providers.codex.available) {
        void this.prewarmIdleLane();
      }
      if (this.chatProvider === "agy" && this.providers.agy.available) {
        void this.ensureAgyReadyAndPrewarm();
      }
    });
  }

  public async selectChatSession(sessionId: string): Promise<void> {
    return this.withChatSessionLock(async () => {
      if (!sessionId || sessionId === this.activeChatSessionId) return;
      const target = this.chatSessions.find((s) => s.id === sessionId);
      if (!target) return;

      await this.stopAllResponders();
      this.syncActiveChatSession(false);

      const outgoingId = this.activeChatSessionId;
      const outgoing = this.chatSessions.find((s) => s.id === outgoingId);
      this.detachOrchestratorLanes();

      // Prune abandoned empty draft when switching back to a historical chat
      if (outgoing && outgoing.id !== sessionId && outgoing.messages.length === 0) {
        this.chatSessions = this.chatSessions.filter((s) => s.id !== outgoing.id);
      }

      const latestTarget = this.chatSessions.find((s) => s.id === sessionId);
      if (!latestTarget) return;

      this.activeChatSessionId = latestTarget.id;
      this.messages = latestTarget.messages;

      // Mark providers without a saved backend session ID as needing context rebind on next turn
      if (latestTarget.messages.length > 0) {
        for (const prov of ["codex", "agy", "claude"] as AgentProvider[]) {
          if (!latestTarget.backendSessionIds?.[prov]) {
            this.rebindContextNeeded.add(`${latestTarget.id}:${prov}`);
          }
        }
      }

      this.persist();
      this.broadcastSnapshot();

      if (this.providers.codex.available) {
        void this.prewarmIdleLane();
      }
      if (this.chatProvider === "agy" && this.providers.agy.available) {
        void this.ensureAgyReadyAndPrewarm();
      }
    });
  }

  public async deleteChatSession(sessionId: string): Promise<void> {
    return this.withChatSessionLock(async () => {
      if (!sessionId) return;
      const exists = this.chatSessions.some((s) => s.id === sessionId);
      if (!exists) return;

      const deletingActive = sessionId === this.activeChatSessionId;
      if (deletingActive) {
        await this.stopAllResponders();
        this.detachOrchestratorLanes();
      }

      this.chatSessions = this.chatSessions.filter((s) => s.id !== sessionId);
      for (const prov of ["codex", "agy", "claude"] as AgentProvider[]) {
        this.rebindContextNeeded.delete(`${sessionId}:${prov}`);
      }

      if (deletingActive) {
        if (this.chatSessions.length === 0) {
          const fresh = createEmptyChatSession(this.chatProvider);
          this.chatSessions = [fresh];
        }
        const nextActive = this.chatSessions[0]!;
        this.activeChatSessionId = nextActive.id;
        this.messages = nextActive.messages;
        this.persist();
        this.broadcastSnapshot();
        if (this.providers.codex.available) {
          void this.prewarmIdleLane();
        }
        if (this.chatProvider === "agy" && this.providers.agy.available) {
          void this.ensureAgyReadyAndPrewarm();
        }
        return;
      }

      this.persist();
      this.broadcastSnapshot();
    });
  }

  private async dispatchParallelResponderTurn(args: {
    chatSessionId: string;
    provider: AgentProvider;
    assistantMessageId: string;
    userText: string;
    attachments: ChatAttachment[];
    explicitMentions?: readonly ExplicitMentionTarget[];
    recentHistoryWindow: string;
    fullHistoryWindow: string;
    hadOtherActive: boolean;
  }): Promise<void> {
    try {
      if (!this.isConnected) {
        await this.start();
      }

      const rebindKey = `${args.chatSessionId}:${args.provider}`;
      const buildPromptForTurn = (isRestoredRebind: boolean): string =>
        this.buildOrchestratorPrompt(
          args.userText,
          args.attachments,
          isRestoredRebind ? args.fullHistoryWindow : args.recentHistoryWindow,
          {
            isRestoredContextRebind: isRestoredRebind,
            explicitMentions: args.explicitMentions,
          },
        );

      const imagePaths = args.attachments
        .map((a) => a.imagePath)
        .filter((p): p is string => Boolean(p));

      if (args.provider === "agy") {
        await this.dispatchAgyOrchestratorTurn({
          chatSessionId: args.chatSessionId,
          assistantMessageId: args.assistantMessageId,
          buildPrompt: buildPromptForTurn,
          imagePaths,
          model: this.chatModel,
          effort: this.chatEffort,
        });
        return;
      }

      if (args.provider === "claude") {
        this.dispatchClaudeOrchestratorTurn({
          chatSessionId: args.chatSessionId,
          assistantMessageId: args.assistantMessageId,
          buildPrompt: buildPromptForTurn,
          imagePaths,
          hadOtherActive: args.hadOtherActive,
        });
        return;
      }

      // Codex app-server fast parallel lane pool
      if (!this.providers.codex.available) {
        throw new Error("Codex に接続できませんでした。");
      }

      const dispatchEpoch = this.chatSessionEpoch;
      const acquired = await this.acquireResponderLane(
        args.assistantMessageId,
        args.chatSessionId,
        dispatchEpoch,
      );
      if (!acquired) {
        return;
      }
      const { threadId, resumed, replacedStale } = acquired;
      if (dispatchEpoch !== this.chatSessionEpoch || !this.isMessageStreaming(args.assistantMessageId)) {
        this.responderLanes = this.responderLanes.filter(
          (l) => !(l.threadId === threadId && l.activeAssistantMessageId === args.assistantMessageId),
        );
        return;
      }
      const needsRebind =
        !resumed && this.rebindContextNeeded.has(rebindKey);
      if (resumed || needsRebind) {
        this.rebindContextNeeded.delete(rebindKey);
      }

      this.updateMessage(args.assistantMessageId, (m) => {
        m.responderThreadId = threadId;
      });
      this.recordBackendSessionId(args.chatSessionId, "codex", threadId, {
        overwrite: replacedStale,
      });

      const promptPayload = buildPromptForTurn(needsRebind);
      const selectedModel = this.chatModel;
      const laneBeforeStart = this.responderLanes.find(
        (l) => l.threadId === threadId && l.activeAssistantMessageId === args.assistantMessageId,
      );
      if (!laneBeforeStart) {
        return;
      }
      laneBeforeStart.activeModel = selectedModel;
      laneBeforeStart.pendingUsage = null;
      const turnId = await this.orchestratorClient.startTurn({
        threadId,
        text: promptPayload,
        imagePaths,
        model: selectedModel,
        effort: this.chatEffort,
      });

      const lane = this.responderLanes.find(
        (l) => l.threadId === threadId && l.activeAssistantMessageId === args.assistantMessageId,
      );
      if (!lane || dispatchEpoch !== this.chatSessionEpoch || !this.isMessageStreaming(args.assistantMessageId)) {
        this.markCancelledCodexTurn(threadId, turnId);
        void this.orchestratorClient.interruptTurn(threadId, turnId).catch(() => {});
        return;
      }
      lane.activeTurnId = turnId;
      lane.activeModel = selectedModel;
      this.updateMessage(args.assistantMessageId, (m) => {
        m.responderTurnId = turnId;
      });
      this.broadcastSnapshot();
    } catch (err) {
      this.activeCliResponders.delete(args.assistantMessageId);
      const laneIdx = this.responderLanes.findIndex(
        (l) => l.activeAssistantMessageId === args.assistantMessageId,
      );
      if (laneIdx !== -1) {
        this.responderLanes[laneIdx].activeAssistantMessageId = null;
        this.responderLanes[laneIdx].activeTurnId = null;
      }
      const agyLaneIdx = this.agyResponderLanes.findIndex(
        (l) => l.activeAssistantMessageId === args.assistantMessageId,
      );
      if (agyLaneIdx !== -1) {
        const [failedLane] = this.agyResponderLanes.splice(agyLaneIdx, 1);
        void this.agyOrchestratorClient.closeSession(failedLane.sessionId);
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.updateMessage(args.assistantMessageId, (m) => {
        m.text = m.text
          ? `${m.text}\n\nエラー: ${msg}`
          : `エラーが発生しました: ${msg}`;
        m.isStreaming = false;
      });
      this.lastErrorBanner = msg;
      this.persist();
      this.broadcastSnapshot();
    }
  }

  private dispatchClaudeOrchestratorTurn(args: {
    chatSessionId: string;
    assistantMessageId: string;
    buildPrompt: (isRestoredRebind: boolean) => string;
    imagePaths: string[];
    hadOtherActive: boolean;
    retriedWithoutResume?: boolean;
  }): void {
    const instructions = this.buildOrchestratorDeveloperInstructions();
    const session = this.chatSessions.find((s) => s.id === args.chatSessionId);
    const savedClaudeId =
      !args.hadOtherActive && !args.retriedWithoutResume
        ? session?.backendSessionIds?.claude ?? null
        : null;
    const resumeId =
      savedClaudeId && !this.failedResumeIds.has(`claude:${savedClaudeId}`)
        ? savedClaudeId
        : null;
    const rebindKey = `${args.chatSessionId}:claude`;
    const needsRebind =
      !resumeId &&
      (Boolean(args.retriedWithoutResume) || this.rebindContextNeeded.has(rebindKey));
    const promptPayload = args.buildPrompt(needsRebind);
    let sawOutput = false;
    let runningHandle: RunningCliTurn | null = null;
    const isStaleClaudeCallback = (): boolean =>
      runningHandle !== null && this.activeCliResponders.get(args.assistantMessageId) !== runningHandle;

    const callbacks = {
      onSessionId: (sid: string) => {
        if (isStaleClaudeCallback()) return;
        this.updateMessage(args.assistantMessageId, (m) => {
          m.responderThreadId = sid;
        });
        this.recordBackendSessionId(args.chatSessionId, "claude", sid, {
          overwrite: Boolean(args.retriedWithoutResume),
        });
      },
      onTextDelta: (delta: string) => {
        if (isStaleClaudeCallback()) return;
        sawOutput = true;
        this.updateMessage(args.assistantMessageId, (m) => {
          m.text += delta;
        });
        this.scheduleBroadcast();
      },
      onReasoningDelta: (delta: string) => {
        if (isStaleClaudeCallback()) return;
        sawOutput = true;
        this.updateMessage(args.assistantMessageId, (m) => {
          m.reasoningSummary = (m.reasoningSummary ?? "") + delta;
        });
        this.scheduleBroadcast();
      },
      onToolEvent: (ev: {
        id: string;
        name: string;
        detail?: string;
        completed: boolean;
        isError?: boolean;
      }) => {
        if (isStaleClaudeCallback()) return;
        sawOutput = true;
        const cleanName = ev.name.replace(/^mcp_+conductor_+/, "");
        this.upsertToolChip(
          args.assistantMessageId,
          ev.id,
          friendlyToolLabel(cleanName, this.getUiLocale()),
          ev.detail ?? null,
          ev.completed,
          Boolean(ev.isError),
          cleanName,
        );
        this.broadcastSnapshot();
      },
      onRateLimit: (window: ProviderQuotaWindow) => {
        this.recordClaudeRateLimitWindow(window);
      },
      onComplete: (outcome: {
        ok: boolean;
        finalText: string;
        errorMessage?: string;
        interrupted?: boolean;
        usage?: CliTurnUsage;
      }) => {
        if (isStaleClaudeCallback()) {
          this.cleanupClaudeTurnMcpConfig(args.assistantMessageId);
          return;
        }
        this.activeCliResponders.delete(args.assistantMessageId);
        // If --resume failed before streaming anything, fall back cleanly with re-bound context
        if (!outcome.ok && !outcome.interrupted && !sawOutput && resumeId && !args.retriedWithoutResume) {
          this.failedResumeIds.add(`claude:${resumeId}`);
          this.rebindContextNeeded.add(rebindKey);
          this.dispatchClaudeOrchestratorTurn({
            ...args,
            retriedWithoutResume: true,
          });
          return;
        }
        this.cleanupClaudeTurnMcpConfig(args.assistantMessageId);
        if (outcome.ok) {
          this.rebindContextNeeded.delete(rebindKey);
        }
        if (outcome.usage) {
          this.recordTurnUsage({
            source: "chat",
            provider: "claude",
            model: outcome.usage.model ?? this.chatModel ?? "claude",
            projectName: this.inferChatProjectName(args.assistantMessageId),
            tokens: outcome.usage,
            exactCostUsd: outcome.usage.costUsd,
          });
        }
        if (!outcome.ok && outcome.errorMessage && !outcome.interrupted) {
          this.updateMessage(args.assistantMessageId, (m) => {
            m.text = m.text
              ? `${m.text}\n\nエラー: ${outcome.errorMessage}`
              : `エラーが発生しました: ${outcome.errorMessage}`;
            m.isStreaming = false;
          });
          this.lastErrorBanner = outcome.errorMessage;
        } else {
          this.finishAssistantMessage(
            args.assistantMessageId,
            outcome.interrupted ? "停止しました。" : undefined,
          );
        }
        this.persist();
        this.broadcastSnapshot();
      },
    };

    let turnMcpConfigPath = this.claudeMcpConfigPath;
    const mcpUrl = this.mcpServer?.getUrl();
    if (mcpUrl && this.mcpServer) {
      try {
        const safeId = args.assistantMessageId.replace(/[^A-Za-z0-9_-]/g, "_");
        const createdPath = writeClaudeMcpConfig(
          this.store.baseDir,
          appendUrlQueryParam(mcpUrl, "assistantMessageId", args.assistantMessageId),
          this.mcpServer.bearerToken,
          `claude-mcp-${safeId}.json`,
        );
        turnMcpConfigPath = createdPath;
        this.claudeTurnMcpConfigPaths.set(args.assistantMessageId, createdPath);
      } catch {
        turnMcpConfigPath = this.claudeMcpConfigPath;
      }
    }

    const running = runClaudeTurn(
      {
        cwd: this.store.baseDir,
        prompt: promptPayload,
        systemPrompt: instructions,
        model: this.chatModel,
        effort: this.chatEffort,
        sessionId: resumeId,
        mcpConfigPath: turnMcpConfigPath,
        imagePaths: args.imagePaths,
      },
      callbacks,
    );

    runningHandle = running;
    this.activeCliResponders.set(args.assistantMessageId, running);
    this.broadcastSnapshot();
  }

  // MARK: - Resident AGY ACP Orchestrator Pool

  private async ensureAgyOrchestratorConnected(): Promise<void> {
    if (this.agyOrchestratorClient.isConnected()) return;
    await this.agyOrchestratorClient.connect({ cwd: this.store.baseDir });
    const count = this.providers.agy.models.length;
    if (this.providers.agy.available) {
      this.providers = {
        ...this.providers,
        agy: {
          ...this.providers.agy,
          detail: `ACP 常駐接続済み (${count} models)`,
        },
      };
      this.broadcastSnapshot();
    }
  }

  private async ensureAgyReadyAndPrewarm(): Promise<void> {
    if (this.isShuttingDown || this.chatProvider !== "agy" || !this.providers.agy.available) {
      return;
    }
    try {
      await this.ensureAgyOrchestratorConnected();
      if (this.isShuttingDown || this.chatProvider !== "agy") {
        await this.shutdownAgyOrchestratorIfIdle();
        return;
      }
      await this.prewarmAgyIdleLane();
    } catch {
      // Non-fatal during background prewarm; explicit error surfaces if a user turn fails
    }
  }

  private async createOrResumeAgyLane(
    assistantMessageId: string | null,
    targetModel: string | null,
    targetEffort: string | null,
    preferredSessionId: string | null = null,
    chatSessionId: string = this.activeChatSessionId,
  ): Promise<{ lane: AgyResponderLane; resumed: boolean; replacedStale: boolean }> {
    const laneId = crypto.randomUUID();
    const mcpServers = this.agyMcpConfig
      ? [
          {
            ...this.agyMcpConfig,
            url: appendUrlQueryParam(this.agyMcpConfig.url, "lane", laneId),
          },
        ]
      : [];
    const systemPromptAppend = this.buildOrchestratorDeveloperInstructions();

    let info: Awaited<ReturnType<AgyAcpClient["createSession"]>> | null = null;
    let resumed = false;
    let replacedStale = false;

    if (preferredSessionId) {
      try {
        info = await this.agyOrchestratorClient.resumeSession({
          sessionId: preferredSessionId,
          cwd: this.store.baseDir,
          mcpServers,
          systemPromptAppend,
        });
        resumed = true;
      } catch {
        this.failedResumeIds.add(`agy:${preferredSessionId}`);
        this.rebindContextNeeded.add(`${chatSessionId}:agy`);
        replacedStale = true;
      }
    }

    if (!info) {
      info = await this.agyOrchestratorClient.createSession({
        cwd: this.store.baseDir,
        mcpServers,
        systemPromptAppend,
      });
    }

    const lane: AgyResponderLane = {
      laneId,
      sessionId: info.sessionId,
      activeAssistantMessageId: assistantMessageId,
      currentModel: info.currentModelId,
      currentEffort: info.currentThoughtLevel,
      cancelled: false,
      hasStreamedText: false,
      syncPromise: null,
      pendingTools: new Map(),
    };

    await this.syncAgyLaneConfig(lane, targetModel, targetEffort);
    return { lane, resumed, replacedStale };
  }

  private async syncAgyLaneConfig(
    lane: AgyResponderLane,
    targetModel: string | null,
    targetEffort: string | null,
  ): Promise<void> {
    if (targetModel && lane.currentModel !== targetModel) {
      await this.agyOrchestratorClient.setModel(lane.sessionId, targetModel);
      lane.currentModel = targetModel;
      // session/set_model updates the session's thought_level to match the selected model
      lane.currentEffort = null;
    }
    if (targetEffort && lane.currentEffort !== targetEffort) {
      await this.agyOrchestratorClient.setEffort(lane.sessionId, targetEffort);
      lane.currentEffort = targetEffort;
    }
  }

  private async syncIdleAgyLanesModel(): Promise<void> {
    if (this.chatProvider !== "agy" || !this.agyOrchestratorClient.isConnected()) return;
    const targetModel = this.chatModel;
    const targetEffort = this.chatEffort;
    for (const lane of this.agyResponderLanes) {
      if (lane.activeAssistantMessageId !== null || lane.cancelled) continue;
      const syncTask = this.syncAgyLaneConfig(lane, targetModel, targetEffort).catch(() => {
        // Non-fatal; next acquire will re-verify or recreate lane
      });
      lane.syncPromise = syncTask;
      void syncTask.finally(() => {
        if (lane.syncPromise === syncTask) lane.syncPromise = null;
      });
    }
  }

  private async acquireAgyResponderLane(
    assistantMessageId: string,
    targetModel: string | null,
    targetEffort: string | null,
    chatSessionId: string,
    expectedEpoch = this.chatSessionEpoch,
  ): Promise<{ lane: AgyResponderLane; resumed: boolean; replacedStale: boolean } | null> {
    const savedId = this.chatSessions.find((s) => s.id === chatSessionId)?.backendSessionIds?.agy ?? null;
    const idle = this.agyResponderLanes.find(
      (l) => l.activeAssistantMessageId === null && !l.cancelled,
    );
    if (idle) {
      idle.activeAssistantMessageId = assistantMessageId;
      idle.cancelled = false;
      idle.hasStreamedText = false;
      idle.pendingTools.clear();
      this.broadcastSnapshot();
      if (idle.syncPromise) {
        await idle.syncPromise.catch(() => {});
      }
      if (expectedEpoch !== this.chatSessionEpoch || idle.cancelled || !this.isMessageStreaming(assistantMessageId)) {
        idle.activeAssistantMessageId = null;
        return null;
      }
      await this.syncAgyLaneConfig(idle, targetModel, targetEffort);
      if (expectedEpoch !== this.chatSessionEpoch || idle.cancelled || !this.isMessageStreaming(assistantMessageId)) {
        idle.activeAssistantMessageId = null;
        return null;
      }
      return {
        lane: idle,
        resumed: Boolean(savedId && idle.sessionId === savedId),
        replacedStale: false,
      };
    }

    const preferredSessionId = this.getPreferredResumableAgySessionId(chatSessionId);
    const created = await this.createOrResumeAgyLane(
      assistantMessageId,
      targetModel,
      targetEffort,
      preferredSessionId,
      chatSessionId,
    );
    if (expectedEpoch !== this.chatSessionEpoch || !this.isMessageStreaming(assistantMessageId)) {
      void this.agyOrchestratorClient.closeSession(created.lane.sessionId);
      return null;
    }
    this.agyResponderLanes.push(created.lane);
    this.broadcastSnapshot();
    return created;
  }

  private async prewarmAgyIdleLane(): Promise<void> {
    if (
      this.isShuttingDown ||
      this.chatProvider !== "agy" ||
      !this.providers.agy.available ||
      !this.agyOrchestratorClient.isConnected()
    ) {
      return;
    }
    const idleCount = this.agyResponderLanes.filter(
      (l) => l.activeAssistantMessageId === null && !l.cancelled,
    ).length;
    if (idleCount >= 1) return;
    if (this.agyPrewarmPromise) return this.agyPrewarmPromise;

    const epoch = this.chatSessionEpoch;
    const targetSessionId = this.activeChatSessionId;
    const preferredSessionId = this.getPreferredResumableAgySessionId(targetSessionId);

    const promise = (async () => {
      try {
        const { lane } = await this.createOrResumeAgyLane(
          null,
          this.chatModel,
          this.chatEffort,
          preferredSessionId,
          targetSessionId,
        );
        if (
          epoch !== this.chatSessionEpoch ||
          this.isShuttingDown ||
          this.chatProvider !== "agy" ||
          !this.agyOrchestratorClient.isConnected()
        ) {
          void this.agyOrchestratorClient.closeSession(lane.sessionId);
          if (this.chatProvider !== "agy") {
            void this.shutdownAgyOrchestratorIfIdle();
          }
          return;
        }
        this.agyResponderLanes.push(lane);
      } catch {
        // non-fatal
      }
    })();

    this.agyPrewarmPromise = promise;
    try {
      await promise;
    } finally {
      if (this.agyPrewarmPromise === promise) {
        this.agyPrewarmPromise = null;
      }
    }
  }

  private releaseAgyLane(
    lane: AgyResponderLane,
    options: { fallbackText?: string; discard?: boolean } = {},
  ): void {
    const msgId = lane.activeAssistantMessageId;
    lane.activeAssistantMessageId = null;
    lane.pendingTools.clear();

    if (msgId) {
      this.finishAssistantMessage(msgId, options.fallbackText);
    }

    if (options.discard) {
      this.agyResponderLanes = this.agyResponderLanes.filter((l) => l !== lane);
      void this.agyOrchestratorClient.closeSession(lane.sessionId);
    } else {
      // Trim extra idle lanes and close their ACP sessions cleanly
      let idleSeen = 0;
      const kept: AgyResponderLane[] = [];
      for (const candidate of this.agyResponderLanes) {
        if (candidate.activeAssistantMessageId !== null) {
          kept.push(candidate);
          continue;
        }
        idleSeen += 1;
        if (idleSeen <= this.maxIdleLanes) {
          kept.push(candidate);
        } else {
          void this.agyOrchestratorClient.closeSession(candidate.sessionId);
        }
      }
      this.agyResponderLanes = kept;
    }

    this.persist();
    this.broadcastSnapshot();

    if (this.chatProvider !== "agy") {
      void this.shutdownAgyOrchestratorIfIdle();
    } else if (!this.isShuttingDown) {
      void this.prewarmAgyIdleLane();
    }
  }

  private async shutdownAgyOrchestratorIfIdle(): Promise<void> {
    const hasActive = this.agyResponderLanes.some((l) => l.activeAssistantMessageId !== null);
    if (hasActive) return;

    const lanesToClose = this.agyResponderLanes;
    this.agyResponderLanes = [];
    this.agyPrewarmPromise = null;

    if (this.agyOrchestratorClient.isConnected()) {
      await Promise.all(
        lanesToClose.map((l) => this.agyOrchestratorClient.closeSession(l.sessionId)),
      );
      this.agyOrchestratorClient.stop();
    }

    if (this.providers.agy.available) {
      this.providers = {
        ...this.providers,
        agy: {
          ...this.providers.agy,
          detail: `利用可能 (${this.providers.agy.models.length} models · ACP待機)`,
        },
      };
      this.broadcastSnapshot();
    }
  }

  private async dispatchAgyOrchestratorTurn(args: {
    chatSessionId: string;
    assistantMessageId: string;
    buildPrompt: (isRestoredRebind: boolean) => string;
    imagePaths: string[];
    model: string | null;
    effort: string | null;
  }): Promise<void> {
    if (!this.providers.agy.available && !this.agyOrchestratorClient.isAvailable()) {
      throw new Error("agy CLI が見つかりませんでした。`~/.local/bin/agy` を確認してください。");
    }

    const rebindKey = `${args.chatSessionId}:agy`;
    const dispatchEpoch = this.chatSessionEpoch;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let lane: AgyResponderLane | null = null;
      try {
        await this.ensureAgyOrchestratorConnected();
        if (dispatchEpoch !== this.chatSessionEpoch || !this.isMessageStreaming(args.assistantMessageId)) {
          return;
        }
        const acquired = await this.acquireAgyResponderLane(
          args.assistantMessageId,
          args.model,
          args.effort,
          args.chatSessionId,
          dispatchEpoch,
        );
        if (!acquired) {
          return;
        }
        lane = acquired.lane;
        const needsRebind =
          !acquired.resumed && this.rebindContextNeeded.has(rebindKey);
        if (acquired.resumed || needsRebind) {
          this.rebindContextNeeded.delete(rebindKey);
        }

        this.updateMessage(args.assistantMessageId, (m) => {
          m.responderThreadId = lane!.sessionId;
        });
        this.recordBackendSessionId(args.chatSessionId, "agy", lane.sessionId, {
          overwrite: acquired.replacedStale,
        });
        this.broadcastSnapshot();

        const promptPayload = args.buildPrompt(needsRebind);
        lane.pendingUsage = null;
        const result = await this.agyOrchestratorClient.prompt({
          sessionId: lane.sessionId,
          text: promptPayload,
          imagePaths: args.imagePaths,
        });

        const agyUsage =
          result.normalizedUsage ??
          (result.usage ? normalizeRawTokenUsage(result.usage, "agy") : null) ??
          lane.pendingUsage ??
          null;
        lane.pendingUsage = null;
        if (agyUsage) {
          this.recordTurnUsage({
            source: "chat",
            provider: "agy",
            model: agyUsage.model ?? lane.currentModel ?? args.model ?? this.chatModel ?? "agy",
            projectName: this.inferChatProjectName(args.assistantMessageId),
            tokens: agyUsage,
            exactCostUsd: agyUsage.costUsd,
          });
        }

        if (lane.cancelled) {
          void this.agyOrchestratorClient.closeSession(lane.sessionId);
          if (this.chatProvider !== "agy") {
            void this.shutdownAgyOrchestratorIfIdle();
          } else if (!this.isShuttingDown) {
            void this.prewarmAgyIdleLane();
          }
          return;
        }

        const wasCancelled = result.stopReason === "cancelled";
        this.releaseAgyLane(lane, {
          fallbackText: wasCancelled ? "停止しました。" : undefined,
          discard: wasCancelled,
        });
        return;
      } catch (err) {
        if (lane?.cancelled) {
          void this.agyOrchestratorClient.closeSession(lane.sessionId);
          return;
        }
        if (lane) {
          this.agyResponderLanes = this.agyResponderLanes.filter((l) => l !== lane);
          if (this.agyOrchestratorClient.isConnected()) {
            void this.agyOrchestratorClient.closeSession(lane.sessionId);
          }
        }
        const canRetryAfterCrash =
          attempt === 0 &&
          !this.isShuttingDown &&
          !(lane?.hasStreamedText) &&
          !this.agyOrchestratorClient.isConnected();
        if (canRetryAfterCrash) {
          continue;
        }
        throw err;
      }
    }
  }

  private handleAgySessionUpdate(event: AgyAcpSessionUpdate): void {
    const lane = this.agyResponderLanes.find((l) => l.sessionId === event.sessionId);
    if (!lane || !lane.activeAssistantMessageId || lane.cancelled) return;
    const messageId = lane.activeAssistantMessageId;
    const parsed = parseAgySessionUpdate(event.raw);

    switch (parsed.kind) {
      case "textDelta":
        lane.hasStreamedText = true;
        this.updateMessage(messageId, (m) => {
          m.text += parsed.text;
        });
        this.scheduleBroadcast();
        break;

      case "reasoningDelta":
        this.updateMessage(messageId, (m) => {
          m.reasoningSummary = (m.reasoningSummary ?? "") + parsed.text;
        });
        this.scheduleBroadcast();
        break;

      case "toolEvent": {
        const toolId = parsed.id || `agy-tool-${lane.pendingTools.size}`;
        if (parsed.name) {
          lane.pendingTools.set(toolId, parsed.name);
        }
        const resolvedName = parsed.name ?? lane.pendingTools.get(toolId) ?? null;
        const cleanName = resolvedName ? resolvedName.replace(/^mcp_+conductor_+/, "") : null;
        this.upsertToolChip(
          messageId,
          toolId,
          friendlyToolLabel(cleanName ?? "tool", this.getUiLocale()),
          parsed.detail ?? null,
          parsed.completed,
          parsed.isError,
          cleanName ?? undefined,
        );
        if (parsed.completed) {
          lane.pendingTools.delete(toolId);
        }
        this.broadcastSnapshot();
        break;
      }

      case "usageUpdate":
        lane.pendingUsage = parsed.usage;
        break;

      default:
        break;
    }
  }

  private handleAgyOrchestratorDisconnect(_reason: string): void {
    const uptimeMs = this.agyOrchestratorClient.getUptimeMs();
    this.agyResponderLanes = [];
    this.agyPrewarmPromise = null;

    if (this.providers.agy.available) {
      this.providers = {
        ...this.providers,
        agy: {
          ...this.providers.agy,
          detail: `利用可能 (${this.providers.agy.models.length} models · ACP再接続待機)`,
        },
      };
      this.broadcastSnapshot();
    }

    // Proactively respawn only if the previous process had been healthy (avoids crash loops);
    // otherwise the next user turn will transparently reconnect on demand.
    if (!this.isShuttingDown && this.chatProvider === "agy" && uptimeMs >= 5_000) {
      void this.ensureAgyReadyAndPrewarm();
    }
  }

  private async startOrResumeCodexThread(
    preferredThreadId: string | null,
    chatSessionId: string,
  ): Promise<{ threadId: string; resumed: boolean; replacedStale: boolean }> {
    const developerInstructions = this.buildOrchestratorDeveloperInstructions();
    if (preferredThreadId) {
      try {
        const threadId = await this.orchestratorClient.resumeThread({
          threadId: preferredThreadId,
          cwd: this.store.baseDir,
          model: this.chatModel,
          developerInstructions,
        });
        return { threadId, resumed: true, replacedStale: false };
      } catch {
        this.failedResumeIds.add(`codex:${preferredThreadId}`);
        this.rebindContextNeeded.add(`${chatSessionId}:codex`);
        const threadId = await this.orchestratorClient.startThread({
          cwd: this.store.baseDir,
          model: this.chatModel,
          developerInstructions,
        });
        return { threadId, resumed: false, replacedStale: true };
      }
    }

    const threadId = await this.orchestratorClient.startThread({
      cwd: this.store.baseDir,
      model: this.chatModel,
      developerInstructions,
    });
    return { threadId, resumed: false, replacedStale: false };
  }

  private async acquireResponderLane(
    assistantMessageId: string,
    chatSessionId: string,
    expectedEpoch = this.chatSessionEpoch,
  ): Promise<{ threadId: string; resumed: boolean; replacedStale: boolean } | null> {
    const savedId =
      this.chatSessions.find((s) => s.id === chatSessionId)?.backendSessionIds?.codex ?? null;
    const idle = this.responderLanes.find((l) => l.activeAssistantMessageId === null);
    if (idle) {
      idle.activeAssistantMessageId = assistantMessageId;
      idle.activeTurnId = null;
      idle.streamedItemIds = new Set();
      idle.lastAgentMessageItemId = null;
      this.broadcastSnapshot();
      return {
        threadId: idle.threadId,
        resumed: Boolean(savedId && idle.threadId === savedId),
        replacedStale: false,
      };
    }

    const preferredThreadId = this.getPreferredResumableCodexThreadId(chatSessionId);
    const created = await this.startOrResumeCodexThread(preferredThreadId, chatSessionId);
    if (expectedEpoch !== this.chatSessionEpoch || !this.isMessageStreaming(assistantMessageId)) {
      return null;
    }
    const existingSameThread = this.responderLanes.find((l) => l.threadId === created.threadId);
    if (existingSameThread) {
      if (existingSameThread.activeAssistantMessageId === null) {
        existingSameThread.activeAssistantMessageId = assistantMessageId;
        existingSameThread.activeTurnId = null;
        existingSameThread.streamedItemIds = new Set();
        existingSameThread.lastAgentMessageItemId = null;
        this.broadcastSnapshot();
        return created;
      }
      // Thread is already active on another lane; allocate a fresh thread so lanes never collide
      const freshThreadId = await this.orchestratorClient.startThread({
        cwd: this.store.baseDir,
        model: this.chatModel,
        developerInstructions: this.buildOrchestratorDeveloperInstructions(),
      });
      if (expectedEpoch !== this.chatSessionEpoch || !this.isMessageStreaming(assistantMessageId)) {
        return null;
      }
      this.responderLanes.push({
        threadId: freshThreadId,
        activeTurnId: null,
        activeAssistantMessageId: assistantMessageId,
        streamedItemIds: new Set(),
        lastAgentMessageItemId: null,
      });
      this.broadcastSnapshot();
      return { threadId: freshThreadId, resumed: false, replacedStale: false };
    }
    this.responderLanes.push({
      threadId: created.threadId,
      activeTurnId: null,
      activeAssistantMessageId: assistantMessageId,
      streamedItemIds: new Set(),
      lastAgentMessageItemId: null,
    });
    this.broadcastSnapshot();
    return created;
  }

  private async prewarmIdleLane(): Promise<void> {
    if (!this.isConnected) return;
    const idleCount = this.responderLanes.filter((l) => l.activeAssistantMessageId === null).length;
    if (idleCount >= 1) return;
    if (this.codexPrewarmPromise) return this.codexPrewarmPromise;
    const epoch = this.chatSessionEpoch;
    const targetSessionId = this.activeChatSessionId;
    const preferredThreadId = this.getPreferredResumableCodexThreadId(targetSessionId);
    const promise = (async () => {
      try {
        const { threadId } = await this.startOrResumeCodexThread(preferredThreadId, targetSessionId);
        if (epoch !== this.chatSessionEpoch || !this.isConnected) return;
        if (this.responderLanes.some((l) => l.threadId === threadId)) return;
        this.responderLanes.push({
          threadId,
          activeTurnId: null,
          activeAssistantMessageId: null,
          streamedItemIds: new Set(),
          lastAgentMessageItemId: null,
        });
      } catch {
        // non-fatal
      }
    })();
    this.codexPrewarmPromise = promise;
    try {
      await promise;
    } finally {
      if (this.codexPrewarmPromise === promise) {
        this.codexPrewarmPromise = null;
      }
    }
  }

  private releaseLane(laneIdx: number, fallbackText?: string): void {
    const lane = this.responderLanes[laneIdx];
    if (!lane) return;
    const msgId = lane.activeAssistantMessageId;
    lane.activeAssistantMessageId = null;
    lane.activeTurnId = null;
    lane.pendingUsage = null;
    lane.streamedItemIds?.clear();
    lane.lastAgentMessageItemId = null;
    if (msgId) {
      this.finishAssistantMessage(msgId, fallbackText);
    }

    // Trim extra idle lanes
    let idleSeen = 0;
    this.responderLanes = this.responderLanes.filter((l) => {
      if (l.activeAssistantMessageId !== null) return true;
      idleSeen += 1;
      return idleSeen <= this.maxIdleLanes;
    });

    this.persist();
    this.broadcastSnapshot();
  }

  private finishAssistantMessage(messageId: string, fallbackText?: string): void {
    for (const [itemId, entry] of this.inFlightMcpToolCalls.entries()) {
      if (entry.assistantMessageId === messageId) {
        this.inFlightMcpToolCalls.delete(itemId);
      }
    }
    this.updateMessage(messageId, (m) => {
      m.isStreaming = false;
      m.responderTurnId = undefined;
      if (!m.text.trim()) {
        if (m.toolChips.length > 0) {
          m.text = "操作を完了しました。";
        } else if (fallbackText) {
          m.text = fallbackText;
        }
      }
    });
  }

  private buildRecentConversationWindow(maxMessages: number): string {
    const slice = this.messages
      .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "taskEvent")
      .slice(-maxMessages);
    if (slice.length === 0) return "";
    return slice
      .map((m) => {
        const who =
          m.role === "user"
            ? "User"
            : m.role === "taskEvent"
              ? "TaskEvent"
              : m.isStreaming
                ? "Conductor (in-progress)"
                : "Conductor";
        const mentionPrefix =
          m.role === "user" && Array.isArray(m.mentions) && m.mentions.length > 0
            ? `[${m.mentions
                .map((ref) =>
                  ref.kind === "task"
                    ? `@${formatTaskCode(ref.taskNumber)}${ref.projectName ? `(${ref.projectName})` : ""}`
                    : `@${ref.projectName}`,
                )
                .join(", ")}] `
            : "";
        const body = m.text.trim().slice(0, 360) || "(working...)";
        return `${who}: ${mentionPrefix}${body}`;
      })
      .join("\n");
  }

  private buildOrchestratorDeveloperInstructions(): string {
    return buildOrchestratorDeveloperInstructions(this.preferredLanguage);
  }

  private buildOrchestratorPrompt(
    userText: string,
    attachments: ChatAttachment[],
    recentHistoryWindow: string,
    options: {
      isRestoredContextRebind?: boolean;
      explicitMentions?: readonly ExplicitMentionTarget[];
    } = {},
  ): string {
    const sections: string[] = [];
    const topProjects = this.projects.slice(0, 30);
    const projLines =
      topProjects.length === 0
        ? "Discovered projects: (none yet)"
        : `Discovered projects (showing top ${topProjects.length} of ${this.projects.length}; use search_projects for others):\n` +
          topProjects
            .map((p) => `- ${p.name}: ${p.path}${p.gitBranch ? ` (branch: ${p.gitBranch})` : ""}`)
            .join("\n");
    sections.push(
      `[Conductor Live Context]\n${buildOrchestratorLiveLanguageLine(this.preferredLanguage)}\n${projLines}`,
    );

    if (this.tasks.length > 0) {
      const taskLines = this.tasks
        .slice(0, 15)
        .map(
          (t) =>
            `- [${t.status}] ${formatTaskCode(t.taskNumber)} id=${t.id} project=${t.projectName} title="${t.title}"` +
            (t.currentStep ? ` step="${t.currentStep}"` : "") +
            (t.previewURL ? ` url=${t.previewURL}` : ""),
        )
        .join("\n");
      sections.push(`Current tasks:\n${taskLines}`);
    }

    const activeTab = this.browser.getActiveTab();
    if (activeTab?.url) {
      sections.push(
        `Active In-App Chromium Browser: "${activeTab.title}" — ${activeTab.url} (consoleErrors=${activeTab.consoleErrorCount}, networkErrors=${activeTab.networkErrorCount})`,
      );
    }

    if (recentHistoryWindow) {
      if (options.isRestoredContextRebind) {
        sections.push(
          `[Restored Chat Session Context — continue this conversation seamlessly]\n${recentHistoryWindow}`,
        );
      } else {
        sections.push(`[Recent Unified Chat Transcript]\n${recentHistoryWindow}`);
      }
    }

    for (const att of attachments) {
      if (att.metadataText) {
        sections.push(att.metadataText);
      }
    }

    const explicitMentionSection = buildExplicitMentionContextSection(
      userText,
      this.projects,
      this.tasks,
      options.explicitMentions,
    );
    if (explicitMentionSection) {
      sections.push(explicitMentionSection);
    }

    sections.push(`[Current User Message to Answer Now]\n${userText}`);
    return sections.join("\n\n");
  }

  // MARK: - Orchestrator Notifications

  private handleOrchestratorNotification(notification: CodexNotification): void {
    const quotaUpdate = extractCodexRateLimitUpdate(notification);
    if (quotaUpdate) {
      this.updateProviderQuota(quotaUpdate);
    }
    if (!notification.threadId) return;
    if (notification.turnId) {
      const turnKey = `${notification.threadId}:${notification.turnId}`;
      if (this.cancelledCodexTurns.has(turnKey)) {
        if (notification.method === "turn/completed") {
          this.cancelledCodexTurns.delete(turnKey);
        }
        return;
      }
    }
    let laneIdx = -1;
    if (notification.turnId) {
      laneIdx = this.responderLanes.findIndex(
        (l) =>
          l.threadId === notification.threadId &&
          l.activeAssistantMessageId !== null &&
          l.activeTurnId === notification.turnId,
      );
    }
    if (laneIdx === -1) {
      laneIdx = this.responderLanes.findIndex(
        (l) => l.threadId === notification.threadId && l.activeAssistantMessageId !== null,
      );
    }
    if (laneIdx === -1) return;
    const lane = this.responderLanes[laneIdx];
    const messageId = lane.activeAssistantMessageId;
    if (!messageId) return;

    // Guard against stale / auxiliary / compaction turns sharing the same threadId
    if (
      lane.activeTurnId &&
      notification.turnId &&
      notification.turnId !== lane.activeTurnId
    ) {
      return;
    }

    switch (notification.method) {
      case "turn/started":
        if (notification.turnId && !lane.activeTurnId) {
          lane.activeTurnId = notification.turnId;
          this.updateMessage(messageId, (m) => {
            m.responderTurnId = notification.turnId ?? undefined;
          });
        }
        break;

      case "item/agentMessage/delta": {
        const delta = asString(notification.params.delta);
        if (!delta) return;
        const itemId = notification.itemId ?? null;
        if (!lane.streamedItemIds) lane.streamedItemIds = new Set();
        const isNewAgentMessageItem = Boolean(
          itemId &&
            lane.lastAgentMessageItemId &&
            lane.lastAgentMessageItemId !== itemId,
        );
        if (itemId) {
          lane.streamedItemIds.add(itemId);
          lane.lastAgentMessageItemId = itemId;
        }
        this.updateMessage(messageId, (m) => {
          if (isNewAgentMessageItem && m.text.trim().length > 0 && !/\n\n$/.test(m.text)) {
            m.text = `${m.text.replace(/\s+$/, "")}\n\n`;
          }
          m.text += delta;
        });
        this.scheduleBroadcast();
        break;
      }

      case "item/reasoning/summaryTextDelta": {
        const delta = asString(notification.params.delta);
        if (!delta) return;
        this.updateMessage(messageId, (m) => {
          m.reasoningSummary = (m.reasoningSummary ?? "") + delta;
        });
        this.scheduleBroadcast();
        break;
      }

      case "item/started":
      case "item/completed": {
        const completed = notification.method === "item/completed";
        const item = asRecord(notification.params.item);
        if (item) {
          this.handleOrchestratorItem(messageId, item, completed, lane);
          this.broadcastSnapshot();
        }
        break;
      }

      case "thread/tokenUsage/updated":
      case "token_count":
      case "codex/event/token_count": {
        const extracted = extractCodexTokenUsage(notification);
        if (extracted) {
          lane.pendingUsage = this.accumulateCodexUsage(
            notification.threadId,
            lane.pendingUsage,
            extracted,
          );
        }
        break;
      }

      case "turn/completed": {
        const completedUsage = extractCodexTokenUsage(notification);
        if (completedUsage) {
          lane.pendingUsage = this.accumulateCodexUsage(
            notification.threadId,
            lane.pendingUsage,
            completedUsage,
          );
        }
        if (lane.pendingUsage) {
          this.recordTurnUsage({
            source: "chat",
            provider: "codex",
            model: lane.activeModel ?? this.chatModel ?? "codex",
            projectName: this.inferChatProjectName(messageId),
            tokens: lane.pendingUsage,
          });
          lane.pendingUsage = null;
        }
        this.releaseLane(laneIdx);
        void this.prewarmIdleLane();
        break;
      }

      case "error": {
        if (notification.params.willRetry === true) return;
        const errRec = asRecord(notification.params.error);
        const msg = asString(errRec?.message) ?? asString(notification.params.message) ?? "Codex error";
        this.lastErrorBanner = msg;
        this.broadcastSnapshot();
        break;
      }
    }
  }

  private handleOrchestratorItem(
    messageId: string,
    item: Record<string, unknown>,
    completed: boolean,
    lane?: ResponderLane,
  ): void {
    const type = asString(item.type);
    const rawItemId = asString(item.id);
    const itemId = rawItemId ?? crypto.randomUUID();
    if (!type) return;

    if (type === "agentMessage" && completed) {
      const text = asString(item.text);
      if (text) {
        if (rawItemId && lane?.streamedItemIds?.has(rawItemId)) {
          // Already streamed via item/agentMessage/delta for this item
          return;
        }
        const hadUntrackedStream = Boolean(lane && (!lane.streamedItemIds || lane.streamedItemIds.size === 0));
        this.updateMessage(messageId, (m) => {
          if (!m.text.trim()) {
            m.text = text;
            return;
          }
          // Backward compatibility: if deltas arrived without itemId and already match this text, avoid duplicating
          if (hadUntrackedStream && m.text.trimEnd().endsWith(text.trim())) {
            return;
          }
          m.text = `${m.text.replace(/\s+$/, "")}\n\n${text}`;
        });
        if (lane && rawItemId) {
          if (!lane.streamedItemIds) lane.streamedItemIds = new Set();
          lane.streamedItemIds.add(rawItemId);
          lane.lastAgentMessageItemId = rawItemId;
        }
      }
      return;
    }

    if (type === "mcpToolCall") {
      const rawTool = asString(item.tool);
      const tool = rawTool ?? "tool";
      const server = asString(item.server) ?? "";
      const label =
        server === "conductor" ? friendlyToolLabel(tool, this.getUiLocale()) : `${server}.${tool}`;
      const toolName = rawTool
        ? server === "conductor"
          ? rawTool
          : server
            ? `${server}:${rawTool}`
            : rawTool
        : undefined;
      const isError = item.error !== null && item.error !== undefined;
      if (server === "conductor" && rawTool) {
        const rawArgs = asRecord(item.arguments) ?? asRecord(item.args);
        const argsKey = buildMcpArgsCorrelationKey(rawTool, rawArgs);
        if (!completed) {
          this.inFlightMcpToolCalls.set(itemId, {
            itemId,
            assistantMessageId: messageId,
            toolName: rawTool,
            argsKey,
            startedAt: Date.now(),
          });
          this.tryClaimPendingUnattributedMcpRef(messageId, rawTool, argsKey, null);
        } else {
          this.inFlightMcpToolCalls.delete(itemId);
          if (!isError) {
            this.tryClaimPendingUnattributedMcpRef(messageId, rawTool, argsKey, item.result);
          }
        }
      }
      this.upsertToolChip(messageId, itemId, label, null, completed, isError, toolName);
      return;
    }

    if (type === "commandExecution") {
      const cmd = asString(item.command) ?? "command";
      this.upsertToolChip(
        messageId,
        itemId,
        `$ ${cmd.slice(0, 40)}`,
        cmd,
        completed,
        asString(item.status) === "failed",
        "commandExecution",
      );
      return;
    }

    if (type === "fileChange") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      this.upsertToolChip(
        messageId,
        itemId,
        `Files updated (${changes.length})`,
        null,
        completed,
        false,
        "fileChange",
      );
      return;
    }

    if (type === "webSearch") {
      const q = asString(item.query) ?? "search";
      this.upsertToolChip(messageId, itemId, `Web: ${q.slice(0, 36)}`, q, completed, false, "webSearch");
    }
  }

  private upsertToolChip(
    messageId: string,
    chipId: string,
    label: string,
    detail: string | null,
    isCompleted: boolean,
    isError: boolean,
    toolName?: string,
  ): void {
    this.updateMessage(messageId, (m) => {
      const existing = m.toolChips.find((c) => c.id === chipId);
      if (existing) {
        existing.label = label;
        existing.isCompleted = isCompleted;
        existing.isError = isError;
        if (toolName) {
          existing.toolName = toolName;
        }
      } else {
        m.toolChips.push({
          id: chipId,
          ...(toolName ? { toolName } : {}),
          label,
          detail,
          isCompleted,
          isError,
        });
      }
    });
  }

  // MARK: - Background Project Workers

  private hasActiveWorkerForTask(task: AgentTask): boolean {
    return this.activeCliWorkers.has(task.id) || Boolean(task.activeTurnId);
  }

  private bumpCliWorkerGeneration(taskId: string): number {
    const next = (this.cliWorkerGenerations.get(taskId) ?? 0) + 1;
    this.cliWorkerGenerations.set(taskId, next);
    return next;
  }

  private isCurrentCliWorkerGeneration(taskId: string, generation: number): boolean {
    return this.cliWorkerGenerations.get(taskId) === generation;
  }

  private async waitForCliWorkerExit(worker: RunningCliTurn, timeoutMs = 1500): Promise<void> {
    if (!worker.waitForExit) return;
    let timer: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        worker.waitForExit().catch(() => {}),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  public updateTaskStatus(taskId: string, status: AgentTaskStatus): TaskStatusUpdateResult {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) {
      return { ok: false, error: "Task not found" };
    }
    const validation = validateManualTaskStatusTransition({
      currentStatus: task.status,
      nextStatus: status,
      hasActiveWorker: this.hasActiveWorkerForTask(task),
      worktreePath: task.worktreePath,
      worktreeBranch: task.worktreeBranch,
      landStatus: task.landStatus,
    });
    if (!validation.ok) {
      return {
        ok: false,
        error: validation.error ?? RUNNING_TASK_DONE_BLOCKED_REASON,
      };
    }

    this.pendingAutoResumeTaskIds = this.pendingAutoResumeTaskIds.filter((id) => id !== taskId);
    this.updateTask(taskId, (t) => {
      t.status = status;
      t.autoResumeOnStartup = false;
      t.updatedAt = new Date().toISOString();
    });
    this.persist();
    this.broadcastSnapshot();
    return { ok: true };
  }

  public async stopTaskWorker(taskId: string): Promise<void> {
    this.pendingAutoResumeTaskIds = this.pendingAutoResumeTaskIds.filter((id) => id !== taskId);
    this.activeConflictResolveTaskIds.delete(taskId);
    const cliWorker = this.activeCliWorkers.get(taskId);
    if (cliWorker) {
      this.bumpCliWorkerGeneration(taskId);
      this.activeCliWorkers.delete(taskId);
      cliWorker.cancel();
      this.updateTask(taskId, (t) => {
        t.status = "needs_review";
        t.autoResumeOnStartup = false;
        t.currentStep = "ユーザーにより停止";
        t.activeTurnId = null;
        t.updatedAt = new Date().toISOString();
      });
      this.persist();
      this.broadcastSnapshot();
      return;
    }

    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (task.workerThreadId && task.activeTurnId) {
      await this.workerClient.interruptTurn(task.workerThreadId, task.activeTurnId).catch(() => {});
    } else if (task.status !== "running" && !task.autoResumeOnStartup) {
      return;
    }
    this.updateTask(taskId, (t) => {
      t.status = "needs_review";
      t.autoResumeOnStartup = false;
      t.currentStep = "ユーザーにより停止";
      t.activeTurnId = null;
      t.updatedAt = new Date().toISOString();
    });
    this.persist();
    this.broadcastSnapshot();
  }

  public async deleteTask(taskId: string): Promise<void> {
    this.pendingAutoResumeTaskIds = this.pendingAutoResumeTaskIds.filter((id) => id !== taskId);
    await this.stopTaskWorker(taskId);
    const task = this.tasks.find((t) => t.id === taskId);
    if (task && (task.worktreePath || task.worktreeBranch)) {
      removeTaskWorktree({
        parentPath: task.projectPath,
        worktreePath: task.worktreePath,
        worktreeBranch: task.worktreeBranch,
        deleteBranch: task.landStatus !== "pushed" && task.landStatus !== "pr_created",
      });
    }
    this.tasks = this.tasks.filter((t) => t.id !== taskId);
    this.persist();
    this.broadcastSnapshot();
  }

  public getTaskGitStatus(taskId: string): string | null {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const targetDir =
      task.worktreePath && fs.existsSync(task.worktreePath) ? task.worktreePath : task.projectPath;
    if (!targetDir) return null;
    return getGitStatusSummary(targetDir);
  }

  public getTaskWorktreeStatus(taskId: string): TaskWorktreeStatus | null {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    const effectiveMode = this.getEffectiveIntegrationModeForProject(task.projectId, task.projectPath);
    return inspectTaskWorktree({
      parentPath: task.projectPath,
      worktreePath: task.worktreePath,
      worktreeBranch: task.worktreeBranch,
      baseCommit: task.baseCommit,
      taskTitle: task.title,
      taskNumber: task.taskNumber,
      taskId: task.id,
      effectiveMode,
    });
  }

  public provisionWorktreeForTask(
    taskId: string,
    project: Project,
  ): {
    cwd: string;
    created: boolean;
    worktreePath: string | null;
    worktreeBranch: string | null;
  } {
    const existing = this.tasks.find((t) => t.id === taskId);
    if (existing?.worktreePath && fs.existsSync(existing.worktreePath)) {
      return {
        cwd: existing.worktreePath,
        created: false,
        worktreePath: existing.worktreePath,
        worktreeBranch: existing.worktreeBranch ?? null,
      };
    }

    const res = createTaskWorktree({
      projectPath: project.path,
      projectName: project.name,
      worktreesBaseDir: this.store.worktreesDir,
      taskId,
      taskNumber: existing?.taskNumber,
    });

    if (res.created && res.worktreePath && res.worktreeBranch) {
      this.updateTask(taskId, (t) => {
        t.worktreePath = res.worktreePath;
        t.worktreeBranch = res.worktreeBranch;
        t.baseBranch = res.baseBranch ?? null;
        t.baseCommit = res.baseCommit ?? null;
        t.landStatus = "unlanded";
        t.landedBranch = null;
        t.landedCommit = null;
        t.prUrl = null;
        t.landError = null;
        t.conflictFiles = undefined;
        t.conflictParentHead = null;
        t.conflictTargetBranch = null;
        t.autoResolveConflictAttempts = undefined;
      });
      return {
        cwd: res.cwd,
        created: true,
        worktreePath: res.worktreePath,
        worktreeBranch: res.worktreeBranch,
      };
    }

    this.updateTask(taskId, (t) => {
      t.worktreePath = null;
      t.worktreeBranch = null;
      t.baseBranch = null;
      t.baseCommit = null;
    });
    return {
      cwd: project.path,
      created: false,
      worktreePath: null,
      worktreeBranch: null,
    };
  }

  public async cleanupTaskWorktree(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return { ok: false, error: "Task not found" };
    if (task.status === "running") {
      await this.stopTaskWorker(taskId);
    }
    const preserveLandedState =
      task.landStatus === "landed" ||
      task.landStatus === "pushed" ||
      task.landStatus === "pr_created";
    const res = removeTaskWorktree({
      parentPath: task.projectPath,
      worktreePath: task.worktreePath,
      worktreeBranch: task.worktreeBranch,
      deleteBranch: task.landStatus !== "pushed" && task.landStatus !== "pr_created",
    });
    if (res.ok) {
      this.updateTask(taskId, (t) => {
        t.worktreePath = null;
        if (!preserveLandedState) {
          t.worktreeBranch = null;
          t.landStatus = undefined;
          t.landError = null;
          t.conflictFiles = undefined;
          t.conflictParentHead = null;
          t.conflictTargetBranch = null;
          t.autoResolveConflictAttempts = undefined;
        }
        t.updatedAt = new Date().toISOString();
      });
      this.persist();
      this.broadcastSnapshot();
    }
    return res;
  }

  private async withRepoLandLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.repoLandLocks.get(repoKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.catch(() => {}).then(() => gate);
    this.repoLandLocks.set(repoKey, chained);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.repoLandLocks.get(repoKey) === chained) {
        this.repoLandLocks.delete(repoKey);
      }
    }
  }

  public async landTask(
    taskId: string,
    options?: { createPr?: boolean },
  ): Promise<LandTaskResult> {
    const initialTask = this.tasks.find((t) => t.id === taskId);
    if (!initialTask) {
      return {
        ok: false,
        mode: this.defaultIntegrationMode,
        action: "error",
        message: "タスクが見つかりませんでした。",
      };
    }

    const mode = this.getEffectiveIntegrationModeForProject(
      initialTask.projectId,
      initialTask.projectPath,
    );

    if (!initialTask.projectPath || !initialTask.worktreePath || !initialTask.worktreeBranch) {
      return {
        ok: false,
        mode,
        action: "error",
        message: "このタスクには独立した Git Worktree がありません。",
      };
    }

    if (initialTask.status === "running") {
      return {
        ok: false,
        mode,
        action: "error",
        message: "ワーカーが実行中のため Land できません。完了または停止後に実行してください。",
      };
    }

    const repoKey = initialTask.projectPath;
    return this.withRepoLandLock(repoKey, async () => {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task || !task.projectPath || !task.worktreePath || !task.worktreeBranch) {
        return {
          ok: false,
          mode,
          action: "error",
          message: "タスクまたは Worktree が既に存在しません。",
        };
      }

      const effectiveMode = this.getEffectiveIntegrationModeForProject(
        task.projectId,
        task.projectPath,
      );

      this.updateTask(taskId, (t) => {
        t.landStatus = "landing";
        t.landError = null;
        t.conflictFiles = undefined;
        t.updatedAt = new Date().toISOString();
      });
      this.broadcastSnapshot();

      const result = landTaskWorktree({
        parentPath: task.projectPath,
        worktreePath: task.worktreePath,
        worktreeBranch: task.worktreeBranch,
        baseBranch: task.baseBranch,
        baseCommit: task.baseCommit,
        taskTitle: task.title,
        taskSummary: task.summary,
        taskNumber: task.taskNumber,
        taskId: task.id,
        mode: effectiveMode,
        createPr: options?.createPr ?? false,
      });

      const now = new Date().toISOString();
      this.updateTask(taskId, (t) => {
        if (result.action === "landed") {
          t.landStatus = "landed";
          t.landedBranch = result.targetBranch ?? null;
          t.landedCommit = result.commitHash ?? null;
          t.worktreePath = null;
          t.worktreeBranch = null;
          t.landError = null;
          t.conflictFiles = undefined;
          t.conflictParentHead = null;
          t.conflictTargetBranch = null;
          t.autoResolveConflictAttempts = undefined;
          t.status = "done";
          t.currentStep = result.targetBranch ? `Landed → ${result.targetBranch}` : "Landed";
        } else if (result.action === "noop") {
          if (effectiveMode === "per-task-pr") {
            t.landStatus = "unlanded";
            t.landError = result.message;
          } else {
            t.landStatus = "landed";
            t.landedBranch = result.targetBranch ?? null;
            t.landedCommit = result.commitHash ?? null;
            t.worktreePath = null;
            t.worktreeBranch = null;
            t.landError = null;
            t.conflictFiles = undefined;
            t.conflictParentHead = null;
            t.conflictTargetBranch = null;
            t.autoResolveConflictAttempts = undefined;
            t.status = "done";
            t.currentStep = "変更なし (Worktree 削除済み)";
          }
        } else if (result.action === "pushed") {
          t.landStatus = "pushed";
          t.landedBranch = result.targetBranch ?? t.worktreeBranch ?? null;
          t.landedCommit = result.commitHash ?? null;
          t.landError = null;
          t.conflictFiles = undefined;
          t.conflictParentHead = null;
          t.conflictTargetBranch = null;
          t.currentStep = `Pushed → ${t.landedBranch ?? ""}`;
        } else if (result.action === "pr_created") {
          t.landStatus = "pr_created";
          t.landedBranch = result.targetBranch ?? t.worktreeBranch ?? null;
          t.landedCommit = result.commitHash ?? null;
          t.prUrl = result.prUrl ?? null;
          t.landError = null;
          t.conflictFiles = undefined;
          t.conflictParentHead = null;
          t.conflictTargetBranch = null;
          t.currentStep = "PR 作成済み";
        } else if (result.action === "conflict") {
          t.landStatus = "conflict";
          t.landError = result.message;
          t.conflictFiles = result.conflictFiles ?? [];
          t.conflictParentHead = result.parentHead ?? null;
          t.conflictTargetBranch = result.targetBranch ?? null;
          t.currentStep = "リベースコンフリクト";
        } else {
          t.landStatus = "error";
          t.landError = result.message;
        }

        t.activities.push({
          id: crypto.randomUUID(),
          kind: result.ok ? "system" : "error",
          title:
            result.action === "landed"
              ? `Landed to ${result.targetBranch ?? "branch"}`
              : result.action === "pr_created"
                ? `PR created (${result.targetBranch ?? ""})`
                : result.action === "pushed"
                  ? `Pushed ${result.targetBranch ?? ""}`
                  : result.action === "conflict"
                    ? "Land conflict (aborted cleanly)"
                    : result.action === "noop"
                      ? "Land no-op"
                      : "Land error",
          detail: result.message,
          timestamp: now,
        });
        t.updatedAt = now;
      });

      // Refresh parent project's active gitBranch so sidebar & settings immediately reflect branch changes
      if (task.projectPath) {
        const refreshedBranch = getGitBranch(task.projectPath);
        this.projects = this.projects.map((p) =>
          p.path === task.projectPath || (task.projectId && p.id === task.projectId)
            ? { ...p, gitBranch: refreshedBranch }
            : p,
        );
      }

      this.persist();
      this.broadcastSnapshot();
      return result;
    });
  }

  private getUiLocale(): UiLocale {
    return resolveUiLocale(this.preferredLanguage);
  }

  private formatTaskEventHeader(task: AgentTask): string {
    const providerLabel =
      task.provider === "agy" ? " · AGY" : task.provider === "claude" ? " · Claude" : "";
    return `**[${formatTaskCode(task.taskNumber)} · ${task.projectName}${providerLabel}] ${task.title}**`;
  }

  private appendTaskEventMessage(task: AgentTask, statusLabel: string, body: string): void {
    const now = new Date().toISOString();
    const banner: ChatMessage = {
      id: crypto.randomUUID(),
      role: "taskEvent",
      ...(task.provider === "agy" || task.provider === "claude" ? { provider: task.provider } : {}),
      text: `${this.formatTaskEventHeader(task)} — ${statusLabel}\n${body}`,
      attachments: [],
      toolChips: [],
      relatedTaskId: task.id,
      isStreaming: false,
      createdAt: now,
    };
    this.appendMessagesToActiveChat([banner]);
  }

  private isTaskEligibleForAutoLand(task: AgentTask): boolean {
    if (!task.projectPath || !task.worktreePath || !task.worktreeBranch) {
      return false;
    }
    if (task.landStatus === "landed") {
      return false;
    }
    if (!fs.existsSync(task.worktreePath)) {
      return false;
    }
    const effectiveMode = this.getEffectiveIntegrationModeForProject(
      task.projectId,
      task.projectPath,
    );
    return effectiveMode === "feature-branch" || effectiveMode === "direct";
  }

  private finalizeConflictResolutionFailure(
    taskId: string,
    reason: string,
    options?: { exhausted?: boolean },
  ): void {
    this.activeConflictResolveTaskIds.delete(taskId);
    const now = new Date().toISOString();
    let updatedTask: AgentTask | undefined;
    this.updateTask(taskId, (t) => {
      t.status = "needs_review";
      t.landStatus = "conflict";
      t.activeTurnId = null;
      t.autoResumeOnStartup = false;
      if (!t.landError) {
        t.landError = reason;
      }
      t.currentStep = options?.exhausted
        ? `コンフリクト自動解消の上限に到達 (${MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS}/${MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS})`
        : "コンフリクト自動解消に失敗（手動確認が必要）";
      t.activities.push({
        id: crypto.randomUUID(),
        kind: "error",
        title: options?.exhausted
          ? "コンフリクト自動解消の上限に到達"
          : "コンフリクト自動解消に失敗",
        detail: reason,
        timestamp: now,
      });
      t.updatedAt = now;
      updatedTask = t;
    });

    if (updatedTask) {
      const locale = this.getUiLocale();
      const filesLine =
        updatedTask.conflictFiles && updatedTask.conflictFiles.length > 0
          ? `\n${t(locale, "inspector.conflictFiles", { files: updatedTask.conflictFiles.join(", ") })}`
          : "";
      const targetLine = updatedTask.conflictTargetBranch
        ? locale === "en"
          ? ` (target branch: ${updatedTask.conflictTargetBranch})`
          : `（対象ブランチ: ${updatedTask.conflictTargetBranch}）`
        : "";
      const body = [
        locale === "en"
          ? `⚠️ Automatic conflict resolution could not be completed${targetLine}. The worktree has been kept — review manually or click "Resolve Conflict with AI" in Task Inspector.`
          : `⚠️ コンフリクトの自動解消を完了できませんでした${targetLine}。Worktree は保持されているため、Task Inspector から手動確認または「AIでコンフリクト解消」を再実行してください。`,
        reason,
      ]
        .filter(Boolean)
        .join("\n") + filesLine;
      this.appendTaskEventMessage(
        updatedTask,
        options?.exhausted
          ? t(locale, "taskEvent.conflictLimitReached")
          : t(locale, "taskEvent.conflictResolveFailed"),
        body,
      );
    }
    this.persist();
    this.broadcastSnapshot();
  }

  private async launchConflictResolutionWorker(options: {
    taskId: string;
    targetBranch: string;
    parentHead: string;
    conflictFiles: string[];
    attempt: number;
    triggeredManually?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    const task = this.tasks.find((t) => t.id === options.taskId);
    if (!task || this.isShuttingDown) {
      return { ok: false, error: "タスクが見つからないか終了処理中です。" };
    }
    if (
      !task.projectPath ||
      !task.worktreePath ||
      !task.worktreeBranch ||
      !fs.existsSync(task.worktreePath)
    ) {
      return { ok: false, error: "有効な Worktree が見つかりません。" };
    }

    const project =
      (task.projectId ? this.projects.find((p) => p.id === task.projectId) : null) ??
      this.projects.find((p) => p.path === task.projectPath) ?? {
        id: task.projectId ?? "",
        name: task.projectName,
        path: task.projectPath,
        colorHex: "#6366F1",
        gitBranch: getGitBranch(task.projectPath),
        addedAt: task.createdAt,
      };

    const prov: AgentProvider = task.provider ?? this.workerProvider;
    const workerCwd = task.worktreePath;
    const stepText = `コンフリクトを自力解消中... (${options.attempt}/${MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS})`;
    const activityTitle = options.triggeredManually
      ? "手動トリガーで AI コンフリクト解消を実行"
      : "自動Landでコンフリクト検出 → ワーカーが自力解消を実行";
    const fileSummary =
      options.conflictFiles.length > 0 ? options.conflictFiles.join(", ") : "(検出ファイルなし)";
    const activityDetail = `試行 ${options.attempt}/${MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS} · target=${options.targetBranch} (${options.parentHead.slice(0, 8)}) · files=${fileSummary}`;

    const conflictPrompt = buildConflictResolutionPrompt({
      taskTitle: task.title,
      worktreePath: workerCwd,
      worktreeBranch: task.worktreeBranch,
      targetBranch: options.targetBranch,
      parentHead: options.parentHead,
      conflictFiles: options.conflictFiles,
      attempt: options.attempt,
      maxAttempts: MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS,
      preferredLanguage: this.preferredLanguage,
    });

    const fullWorkerInstructions = buildWorkerDeveloperInstructions({
      projectName: project.name,
      cwd: workerCwd,
      projectPath: project.path,
      worktreeBranch: task.worktreeBranch,
      preferredLanguage: this.preferredLanguage,
    });

    const effectiveModel =
      task.workerModel ??
      (prov === this.workerProvider
        ? this.workerModel
        : prov === "agy"
          ? strongestAgyModel(this.providers.agy.models)
          : this.providers[prov].models[0]?.model ?? null);
    const effectiveEffort =
      task.workerEffort ?? (prov === this.workerProvider ? this.workerEffort : null);

    const now = new Date().toISOString();
    this.updateTask(task.id, (t) => {
      t.status = "running";
      t.landStatus = "conflict";
      t.autoResolveConflictAttempts = options.attempt;
      t.conflictParentHead = options.parentHead;
      t.conflictTargetBranch = options.targetBranch;
      t.conflictFiles = options.conflictFiles;
      t.autoResumeOnStartup = false;
      t.currentStep = stepText;
      t.updatedAt = now;
    });

    this.activeConflictResolveTaskIds.add(task.id);

    if (prov === "agy" || prov === "claude") {
      const resumeSessionId = task.workerThreadId ?? null;
      const workerInstructions = resumeSessionId
        ? buildWorkerLanguageInstruction(this.preferredLanguage)
        : fullWorkerInstructions;

      this.launchCliProjectWorker({
        taskId: task.id,
        provider: prov,
        project,
        cwd: workerCwd,
        worktreeBranch: task.worktreeBranch,
        prompt: conflictPrompt,
        workerInstructions,
        fallbackWorkerInstructions: resumeSessionId ? fullWorkerInstructions : undefined,
        model: effectiveModel,
        effort: effectiveEffort,
        resumeSessionId,
        fallbackPromptOnResumeFailure: resumeSessionId ? conflictPrompt : undefined,
        initialStep: stepText,
        startActivityTitle: activityTitle,
        startActivityDetail: activityDetail,
      });
      return { ok: true };
    }

    // Codex worker: resume existing worker thread cleanly, falling back to a fresh thread if needed
    try {
      if (!this.workerClient.isConnected()) {
        throw new Error("Codex Worker に接続されていないためコンフリクト解消を開始できませんでした。");
      }

      let threadId: string | null = null;
      let turnId: string | null = null;

      if (task.workerThreadId) {
        try {
          turnId = await this.workerClient.startTurn({
            threadId: task.workerThreadId,
            text: conflictPrompt,
            model: effectiveModel,
            effort: effectiveEffort,
          });
          threadId = task.workerThreadId;
        } catch {
          try {
            const resumedThreadId = await this.workerClient.resumeThread({
              threadId: task.workerThreadId,
              cwd: workerCwd,
              model: effectiveModel,
              developerInstructions: fullWorkerInstructions,
            });
            turnId = await this.workerClient.startTurn({
              threadId: resumedThreadId,
              text: conflictPrompt,
              model: effectiveModel,
              effort: effectiveEffort,
            });
            threadId = resumedThreadId;
          } catch {
            // Fall through to fresh thread creation
          }
        }
      }

      if (this.isShuttingDown) {
        this.activeConflictResolveTaskIds.delete(task.id);
        return { ok: false, error: "終了処理中です。" };
      }

      if (!threadId || !turnId) {
        threadId = await this.workerClient.startThread({
          cwd: workerCwd,
          model: effectiveModel,
          developerInstructions: fullWorkerInstructions,
        });
        turnId = await this.workerClient.startTurn({
          threadId,
          text: conflictPrompt,
          model: effectiveModel,
          effort: effectiveEffort,
        });
      }

      if (this.isShuttingDown) {
        this.activeConflictResolveTaskIds.delete(task.id);
        return { ok: false, error: "終了処理中です。" };
      }

      const launchedAt = new Date().toISOString();
      this.updateTask(task.id, (t) => {
        t.provider = "codex";
        t.workerThreadId = threadId;
        t.activeTurnId = turnId;
        t.status = "running";
        t.autoResumeOnStartup = false;
        t.latestOutput = "";
        t.currentStep = stepText;
        t.activities.push({
          id: crypto.randomUUID(),
          kind: "system",
          title: activityTitle,
          detail: activityDetail,
          timestamp: launchedAt,
        });
        t.updatedAt = launchedAt;
      });
      this.persist();
      this.broadcastSnapshot();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finalizeConflictResolutionFailure(task.id, msg);
      return { ok: false, error: msg };
    }
  }

  private async runAutoLandForCompletedTask(
    taskId: string,
    options: { completionExcerpt: string; wasConflictResolveTurn: boolean },
  ): Promise<void> {
    if (this.isShuttingDown) return;
    const initialTask = this.tasks.find((t) => t.id === taskId);
    if (!initialTask || !initialTask.projectPath) return;

    const repoKey = initialTask.projectPath;
    const lockedOutcome = await this.withRepoLandLock(repoKey, async () => {
      if (this.isShuttingDown) return null;
      const task = this.tasks.find((t) => t.id === taskId);
      if (
        !task ||
        task.status !== "running" ||
        !task.projectPath ||
        !task.worktreePath ||
        !task.worktreeBranch ||
        !fs.existsSync(task.worktreePath)
      ) {
        return null;
      }

      const effectiveMode = this.getEffectiveIntegrationModeForProject(
        task.projectId,
        task.projectPath,
      );
      if (effectiveMode !== "feature-branch" && effectiveMode !== "direct") {
        return { skippedNonLocalMode: true as const };
      }

      this.updateTask(taskId, (t) => {
        t.landStatus = "landing";
        t.currentStep = "自動 Land を実行中...";
        t.updatedAt = new Date().toISOString();
      });
      this.broadcastSnapshot();

      const result = landTaskWorktree({
        parentPath: task.projectPath,
        worktreePath: task.worktreePath,
        worktreeBranch: task.worktreeBranch,
        baseBranch: task.baseBranch,
        baseCommit: task.baseCommit,
        taskTitle: task.title,
        taskSummary: task.summary,
        taskNumber: task.taskNumber,
        taskId: task.id,
        mode: effectiveMode,
        createPr: false,
      });

      if (task.projectPath) {
        const refreshedBranch = getGitBranch(task.projectPath);
        this.projects = this.projects.map((p) =>
          p.path === task.projectPath || (task.projectId && p.id === task.projectId)
            ? { ...p, gitBranch: refreshedBranch }
            : p,
        );
      }

      return { skippedNonLocalMode: false as const, result };
    });

    if (this.isShuttingDown || !lockedOutcome) return;

    const latestTask = this.tasks.find((t) => t.id === taskId);
    if (!latestTask) return;

    if (lockedOutcome.skippedNonLocalMode) {
      const locale = this.getUiLocale();
      let finishedTask: AgentTask | undefined;
      this.updateTask(taskId, (tTask) => {
        tTask.status = "needs_review";
        if (tTask.landStatus === "landing") tTask.landStatus = "unlanded";
        tTask.currentStep = t(locale, "taskStep.completedReview");
        tTask.updatedAt = new Date().toISOString();
        finishedTask = tTask;
      });
      if (finishedTask) {
        this.appendTaskEventMessage(
          finishedTask,
          t(locale, "taskEvent.completedReview"),
          options.completionExcerpt || t(locale, "taskEvent.noOutput"),
        );
      }
      this.persist();
      this.broadcastSnapshot();
      return;
    }

    const { result } = lockedOutcome;
    const now = new Date().toISOString();
    const locale = this.getUiLocale();

    if (result.action === "landed" || result.action === "noop") {
      let updatedTask: AgentTask | undefined;
      const resolvedAfterConflict =
        options.wasConflictResolveTurn || (latestTask.autoResolveConflictAttempts ?? 0) > 0;
      this.updateTask(taskId, (tTask) => {
        tTask.status = "needs_review";
        tTask.landStatus = "landed";
        tTask.landedBranch = result.targetBranch ?? null;
        tTask.landedCommit = result.commitHash ?? null;
        tTask.worktreePath = null;
        tTask.worktreeBranch = null;
        tTask.landError = null;
        tTask.conflictFiles = undefined;
        tTask.conflictParentHead = null;
        tTask.conflictTargetBranch = null;
        tTask.autoResolveConflictAttempts = undefined;
        tTask.currentStep =
          result.action === "noop"
            ? t(locale, "taskStep.completedNoChanges")
            : result.targetBranch
              ? t(locale, "taskStep.completedLandedBranch", { branch: result.targetBranch })
              : t(locale, "taskStep.completedLanded");
        tTask.activities.push({
          id: crypto.randomUUID(),
          kind: "system",
          title:
            result.action === "noop"
              ? locale === "en"
                ? "Auto-land (no changes)"
                : "自動 Land (変更なし)"
              : locale === "en"
                ? `Auto-land completed → ${result.targetBranch ?? "branch"}`
                : `自動 Land 完了 → ${result.targetBranch ?? "branch"}`,
          detail: result.message,
          timestamp: now,
        });
        tTask.updatedAt = now;
        updatedTask = tTask;
      });

      if (updatedTask) {
        const targetLabel = result.targetBranch ?? t(locale, "taskEvent.noChangesLabel");
        const landSummaryLine =
          result.action === "noop"
            ? t(locale, "taskEvent.autoLandNoop", { target: targetLabel })
            : resolvedAfterConflict
              ? t(locale, "taskEvent.autoLandResolved", { target: targetLabel })
              : t(locale, "taskEvent.autoLandSuccess", { target: targetLabel });
        const body = `${landSummaryLine}\n${options.completionExcerpt || t(locale, "taskEvent.noOutput")}`;
        this.appendTaskEventMessage(updatedTask, t(locale, "taskEvent.completedReview"), body);
      }
      this.persist();
      this.broadcastSnapshot();
      return;
    }

    if (result.action === "conflict") {
      const currentAttempts = latestTask.autoResolveConflictAttempts ?? 0;
      const conflictFiles = result.conflictFiles ?? [];
      const parentHead =
        result.parentHead ??
        (latestTask.projectPath ? getGitHeadCommit(latestTask.projectPath) : null) ??
        "HEAD";
      const targetBranch = result.targetBranch ?? latestTask.baseBranch ?? "HEAD";

      this.updateTask(taskId, (t) => {
        t.landStatus = "conflict";
        t.landError = result.message;
        t.conflictFiles = conflictFiles;
        t.conflictParentHead = parentHead;
        t.conflictTargetBranch = targetBranch;
        t.updatedAt = now;
      });

      if (currentAttempts < MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS) {
        const nextAttempt = currentAttempts + 1;
        await this.launchConflictResolutionWorker({
          taskId,
          targetBranch,
          parentHead,
          conflictFiles,
          attempt: nextAttempt,
          triggeredManually: false,
        });
        return;
      }

      this.finalizeConflictResolutionFailure(
        taskId,
        `自動コンフリクト解消を ${MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS} 回試行しましたが解消できませんでした: ${result.message}`,
        { exhausted: true },
      );
      return;
    }

    // Non-conflict error (e.g., parent repo has uncommitted changes): NEVER run AI conflict resolution
    let updatedTask: AgentTask | undefined;
    this.updateTask(taskId, (tTask) => {
      tTask.status = "needs_review";
      tTask.landStatus = "error";
      tTask.landError = result.message;
      tTask.conflictFiles = undefined;
      tTask.currentStep = t(locale, "taskStep.autoLandError");
      tTask.activities.push({
        id: crypto.randomUUID(),
        kind: "error",
        title: locale === "en" ? "Auto-land error" : "自動 Land エラー",
        detail: result.message,
        timestamp: now,
      });
      tTask.updatedAt = now;
      updatedTask = tTask;
    });

    if (updatedTask) {
      const body = `${t(locale, "taskEvent.autoLandFailed", { message: result.message })}\n${options.completionExcerpt || t(locale, "taskEvent.noOutput")}`;
      this.appendTaskEventMessage(
        updatedTask,
        t(locale, "taskEvent.completedReviewUnlanded"),
        body,
      );
    }
    this.persist();
    this.broadcastSnapshot();
  }

  public async resolveTaskConflictWithAI(taskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) {
      return { ok: false, error: "タスクが見つかりませんでした。" };
    }
    if (task.status === "running") {
      return { ok: false, error: "ワーカーが実行中のため開始できません。" };
    }
    if (task.landStatus !== "conflict") {
      return { ok: false, error: "このタスクはコンフリクト状態ではありません。" };
    }
    if (
      !task.projectPath ||
      !task.worktreePath ||
      !task.worktreeBranch ||
      !fs.existsSync(task.worktreePath)
    ) {
      return { ok: false, error: "有効な Worktree が見つかりません。" };
    }

    const parentHead = getGitHeadCommit(task.projectPath) ?? task.conflictParentHead ?? null;
    if (!parentHead) {
      return { ok: false, error: "親リポジトリの HEAD コミットを取得できませんでした。" };
    }

    const targetBranch =
      task.conflictTargetBranch ?? getGitBranch(task.projectPath) ?? task.baseBranch ?? "HEAD";
    const conflictFiles = task.conflictFiles ?? [];

    // Reset attempt counter so manual trigger gets a fresh full retry budget (1/2, then up to 2/2)
    this.updateTask(task.id, (t) => {
      t.autoResolveConflictAttempts = 0;
      t.updatedAt = new Date().toISOString();
    });

    return this.launchConflictResolutionWorker({
      taskId: task.id,
      targetBranch,
      parentHead,
      conflictFiles,
      attempt: 1,
      triggeredManually: true,
    });
  }

  private handleWorkerNotification(notification: CodexNotification): void {
    if (this.isShuttingDown) return;
    const quotaUpdate = extractCodexRateLimitUpdate(notification);
    if (quotaUpdate) {
      this.updateProviderQuota(quotaUpdate);
    }
    if (!notification.threadId) return;
    const task = this.tasks.find((t) => t.workerThreadId === notification.threadId);
    if (!task) return;
    const taskId = task.id;

    switch (notification.method) {
      case "turn/started":
        this.codexWorkerPendingUsage.delete(taskId);
        this.updateTask(taskId, (t) => {
          t.status = "running";
          t.activeTurnId = notification.turnId;
          t.currentStep = this.activeConflictResolveTaskIds.has(taskId)
            ? `コンフリクトを自力解消中... (${t.autoResolveConflictAttempts ?? 1}/${MAX_AUTO_CONFLICT_RESOLVE_ATTEMPTS})`
            : "作業中...";
          t.updatedAt = new Date().toISOString();
        });
        this.broadcastSnapshot();
        break;

      case "item/agentMessage/delta": {
        const delta = asString(notification.params.delta);
        if (!delta) return;
        this.updateTask(taskId, (t) => {
          t.latestOutput += delta;
          t.currentStep = "報告を生成中...";
          t.updatedAt = new Date().toISOString();
        });
        this.scheduleBroadcast();
        break;
      }

      case "item/started":
      case "item/completed": {
        const completed = notification.method === "item/completed";
        const item = asRecord(notification.params.item);
        const type = asString(item?.type);
        if (!item || !type) return;

        this.updateTask(taskId, (t) => {
          const now = new Date().toISOString();
          if (type === "commandExecution") {
            const cmd = asString(item.command) ?? "command";
            t.currentStep = completed ? `コマンド完了: ${cmd.slice(0, 40)}` : `実行中: ${cmd.slice(0, 40)}`;
            if (completed) {
              const out = asString(item.aggregatedOutput);
              t.activities.push({
                id: crypto.randomUUID(),
                kind: "command",
                title: `$ ${cmd}`,
                detail: out ? out.slice(-800) : null,
                timestamp: now,
              });
            }
          } else if (type === "fileChange") {
            const changes = Array.isArray(item.changes) ? item.changes : [];
            const paths = changes
              .map((c) => asString(asRecord(c)?.path))
              .filter((p): p is string => Boolean(p))
              .slice(0, 5)
              .join(", ");
            t.currentStep = `ファイル変更: ${paths}`;
            if (completed) {
              t.activities.push({
                id: crypto.randomUUID(),
                kind: "file",
                title: `Modified ${changes.length} file(s)`,
                detail: paths || null,
                timestamp: now,
              });
            }
          } else if (type === "agentMessage" && completed) {
            const text = asString(item.text);
            if (text) {
              t.latestOutput = text;
              t.activities.push({
                id: crypto.randomUUID(),
                kind: "message",
                title: "Worker 報告",
                detail: text.slice(0, 1200),
                timestamp: now,
              });
              if (!t.previewURL) {
                const localUrl = extractFirstLocalUrl(text);
                if (localUrl) t.previewURL = localUrl;
              }
            }
          }
          t.updatedAt = now;
        });
        this.broadcastSnapshot();
        break;
      }

      case "thread/tokenUsage/updated":
      case "token_count":
      case "codex/event/token_count": {
        const extracted = extractCodexTokenUsage(notification);
        if (extracted) {
          const nextPending = this.accumulateCodexUsage(
            notification.threadId,
            this.codexWorkerPendingUsage.get(taskId),
            extracted,
          );
          if (nextPending) {
            this.codexWorkerPendingUsage.set(taskId, nextPending);
          }
        }
        break;
      }

      case "turn/completed": {
        if (notification.turnId && task.activeTurnId && notification.turnId !== task.activeTurnId) {
          return;
        }
        const completedUsage = extractCodexTokenUsage(notification);
        let turnUsage = this.codexWorkerPendingUsage.get(taskId) ?? null;
        if (completedUsage) {
          turnUsage = this.accumulateCodexUsage(notification.threadId, turnUsage, completedUsage);
        }
        this.codexWorkerPendingUsage.delete(taskId);
        if (turnUsage) {
          this.recordTurnUsage({
            source: "worker",
            provider: "codex",
            model: task.workerModel ?? this.workerModel ?? "codex",
            projectName: task.projectName,
            taskId: task.id,
            tokens: turnUsage,
          });
        }
        const turnStatus = asString(asRecord(notification.params.turn)?.status) ?? "completed";
        const wasConflictResolveTurn = this.activeConflictResolveTaskIds.has(taskId);
        this.activeConflictResolveTaskIds.delete(taskId);

        if (turnStatus === "failed" || turnStatus === "interrupted") {
          if (wasConflictResolveTurn) {
            this.finalizeConflictResolutionFailure(
              taskId,
              turnStatus === "interrupted"
                ? "コンフリクト解消ワーカーが中断されました。"
                : "コンフリクト解消ワーカーがエラーで終了しました。",
            );
            break;
          }
          const locale = this.getUiLocale();
          let updatedTask: AgentTask | undefined;
          this.updateTask(taskId, (tTask) => {
            tTask.activeTurnId = null;
            tTask.autoResumeOnStartup = false;
            tTask.updatedAt = new Date().toISOString();
            if (turnStatus === "failed") {
              tTask.status = "failed";
              tTask.currentStep = t(locale, "taskStep.failed");
            } else {
              tTask.status = "needs_review";
              tTask.currentStep = t(locale, "taskStep.interrupted");
            }
            updatedTask = tTask;
          });
          if (updatedTask) {
            const excerpt = buildTaskCompletionExcerpt(updatedTask.latestOutput);
            this.appendTaskEventMessage(
              updatedTask,
              updatedTask.status === "failed"
                ? t(locale, "taskEvent.failed")
                : t(locale, "taskEvent.completedReview"),
              excerpt || t(locale, "taskEvent.noOutput"),
            );
          }
          this.persist();
          this.broadcastSnapshot();
          break;
        }

        const shouldAutoLand =
          (this.autoLandOnComplete || wasConflictResolveTurn) &&
          this.isTaskEligibleForAutoLand(task);

        if (shouldAutoLand) {
          const locale = this.getUiLocale();
          let excerpt = "";
          this.updateTask(taskId, (tTask) => {
            tTask.activeTurnId = null;
            tTask.autoResumeOnStartup = false;
            tTask.status = "running";
            tTask.landStatus = "landing";
            tTask.currentStep = t(locale, "taskStep.autoLanding");
            tTask.updatedAt = new Date().toISOString();
            excerpt = buildTaskCompletionExcerpt(tTask.latestOutput);
          });
          this.persist();
          this.broadcastSnapshot();
          void this.runAutoLandForCompletedTask(taskId, {
            completionExcerpt: excerpt,
            wasConflictResolveTurn,
          });
          break;
        }

        const locale = this.getUiLocale();
        let updatedTask: AgentTask | undefined;
        this.updateTask(taskId, (tTask) => {
          tTask.activeTurnId = null;
          tTask.autoResumeOnStartup = false;
          tTask.updatedAt = new Date().toISOString();
          tTask.status = "needs_review";
          tTask.currentStep = t(locale, "taskStep.completedReview");
          updatedTask = tTask;
        });

        if (updatedTask) {
          const excerpt = buildTaskCompletionExcerpt(updatedTask.latestOutput);
          this.appendTaskEventMessage(
            updatedTask,
            t(locale, "taskEvent.completedReview"),
            excerpt || t(locale, "taskEvent.noOutput"),
          );
        }
        this.persist();
        this.broadcastSnapshot();
        break;
      }

      case "error": {
        const errRec = asRecord(notification.params.error);
        const msg = asString(errRec?.message) ?? asString(notification.params.message) ?? "Worker error";
        this.updateTask(taskId, (t) => {
          t.activities.push({
            id: crypto.randomUUID(),
            kind: "error",
            title: "Error",
            detail: msg,
            timestamp: new Date().toISOString(),
          });
          t.updatedAt = new Date().toISOString();
        });
        this.broadcastSnapshot();
        break;
      }
    }
  }

  // MARK: - MCP Tool Dispatch

  private async handleMCPToolCall(
    name: string,
    args: Record<string, unknown>,
    context?: MCPToolCallContext,
  ): Promise<MCPToolResult> {
    switch (name) {
      case "list_projects": {
        const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, args.limit)) : 40;
        return {
          text: JSON.stringify(
            {
              total: this.projects.length,
              projects: this.projects.slice(0, limit),
            },
            null,
            2,
          ),
        };
      }

      case "search_projects": {
        const q = (asString(args.query) ?? "").trim().toLowerCase();
        const matches = this.projects
          .filter((p) => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
          .slice(0, 30);
        return { text: JSON.stringify(matches, null, 2) };
      }

      case "register_project": {
        const p = asString(args.path);
        if (!p) return { text: "Missing path", isError: true };
        const proj = this.registerProject(p, asString(args.name) ?? undefined);
        if (!proj) return { text: `Directory does not exist: ${p}`, isError: true };
        this.recordMcpMentionAssociation(
          "register_project",
          args,
          createProjectMentionRef(proj),
          context,
        );
        return { text: JSON.stringify(proj, null, 2) };
      }

      case "scan_directory_projects": {
        const dir = asString(args.directory);
        if (!dir) return { text: "Missing directory", isError: true };
        const canonical = canonicalDirectory(dir);
        if (!canonical) return { text: `Directory does not exist: ${dir}`, isError: true };
        const added = this.scanDirectoryAndRegisterProjects(canonical);
        return {
          text: JSON.stringify(
            {
              scanned_directory: canonical,
              newly_added_count: added.length,
              newly_added: added.map((p) => ({ name: p.name, path: p.path })),
              total_projects: this.projects.length,
            },
            null,
            2,
          ),
        };
      }

      case "list_tasks":
        return { text: JSON.stringify(this.tasks.map((t) => this.taskSummary(t)), null, 2) };

      case "create_task": {
        const title = asString(args.title);
        if (!title) return { text: "Missing title", isError: true };
        const projQuery = asString(args.project_name) ?? "General";
        const matched = this.findProject(projQuery);
        const rawStatus = asString(args.status) as AgentTaskStatus | null;
        const validStatuses: AgentTaskStatus[] = ["queued", "running", "needs_review", "done", "failed"];
        const status: AgentTaskStatus = rawStatus && validStatuses.includes(rawStatus) ? rawStatus : "queued";
        const now = new Date().toISOString();
        const task: AgentTask = {
          id: crypto.randomUUID(),
          taskNumber: this.allocateTaskNumber(),
          title,
          summary: asString(args.summary) ?? "",
          projectId: matched?.id ?? null,
          projectName: matched?.name ?? projQuery,
          projectPath: matched?.path ?? null,
          status,
          currentStep: asString(args.current_step),
          workerThreadId: null,
          activeTurnId: null,
          previewURL: asString(args.preview_url),
          latestOutput: "",
          activities: [],
          createdAt: now,
          updatedAt: now,
        };
        this.tasks = [task, ...this.tasks];
        this.recordMcpMentionAssociation(
          "create_task",
          args,
          createTaskMentionRef(task, this.projects),
          context,
        );
        this.persist();
        this.broadcastSnapshot();
        return { text: JSON.stringify(this.taskSummary(task), null, 2) };
      }

      case "update_task": {
        const taskRef = asString(args.task_id);
        const targetTask = this.resolveTaskByIdOrCode(taskRef);
        if (!targetTask) {
          return { text: "Task not found", isError: true };
        }
        const taskId = targetTask.id;
        const validStatuses: AgentTaskStatus[] = ["queued", "running", "needs_review", "done", "failed"];
        const requestedStatus =
          typeof args.status === "string" && validStatuses.includes(args.status as AgentTaskStatus)
            ? (args.status as AgentTaskStatus)
            : null;
        if (requestedStatus) {
          const validation = validateManualTaskStatusTransition({
            currentStatus: targetTask.status,
            nextStatus: requestedStatus,
            hasActiveWorker: this.hasActiveWorkerForTask(targetTask),
            worktreePath: targetTask.worktreePath,
            worktreeBranch: targetTask.worktreeBranch,
            landStatus: targetTask.landStatus,
          });
          if (!validation.ok) {
            return {
              text: validation.error ?? RUNNING_TASK_DONE_BLOCKED_REASON,
              isError: true,
            };
          }
        }
        this.updateTask(taskId, (t) => {
          if (typeof args.title === "string") t.title = args.title;
          if (typeof args.summary === "string") t.summary = args.summary;
          if (typeof args.current_step === "string") t.currentStep = args.current_step;
          if (typeof args.preview_url === "string") t.previewURL = args.preview_url;
          if (requestedStatus) {
            t.status = requestedStatus;
            t.autoResumeOnStartup = false;
          }
          t.updatedAt = new Date().toISOString();
        });
        const updated = this.tasks.find((t) => t.id === taskId)!;
        this.recordMcpMentionAssociation(
          "update_task",
          args,
          createTaskMentionRef(updated, this.projects),
          context,
        );
        this.persist();
        this.broadcastSnapshot();
        return { text: JSON.stringify(this.taskSummary(updated), null, 2) };
      }

      case "start_worker": {
        const prompt = asString(args.prompt);
        if (!prompt) return { text: "Missing prompt", isError: true };
        const existingTaskId = asString(args.task_id);
        let task = this.resolveTaskByIdOrCode(existingTaskId);

        const projQuery = asString(args.project_name) ?? asString(args.project_path);
        let project = projQuery ? this.findProject(projQuery) : null;
        if (!project && asString(args.project_path)) {
          project = this.registerProject(asString(args.project_path)!, asString(args.project_name) ?? undefined);
        }
        if (!project && task?.projectId) {
          project = this.projects.find((p) => p.id === task?.projectId) ?? null;
        }
        if (!project && task?.projectPath) {
          project = this.registerProject(task.projectPath, task.projectName);
        }
        if (!project) {
          return {
            text: "Project not found. Register a project first or pass a valid project_name / project_path.",
            isError: true,
          };
        }

        const rawProvider = asString(args.provider);
        const chosenProvider: AgentProvider =
          rawProvider === "codex" || rawProvider === "agy" || rawProvider === "claude"
            ? rawProvider
            : this.workerProvider;

        const effectiveModel =
          asString(args.model) ??
          (chosenProvider === this.workerProvider
            ? this.workerModel
            : chosenProvider === "agy"
              ? strongestAgyModel(this.providers.agy.models)
              : this.providers[chosenProvider].models[0]?.model ?? null);
        const effectiveEffort =
          chosenProvider === this.workerProvider ? this.workerEffort : null;

        const now = new Date().toISOString();
        if (!task) {
          task = {
            id: crypto.randomUUID(),
            taskNumber: this.allocateTaskNumber(),
            title: asString(args.title) ?? prompt.slice(0, 48),
            summary: asString(args.summary) ?? "",
            projectId: project.id,
            projectName: project.name,
            projectPath: project.path,
            status: "running",
            provider: chosenProvider,
            autoResumeOnStartup: false,
            workerPrompt: prompt,
            lastWorkerPrompt: prompt,
            workerModel: effectiveModel,
            workerEffort: effectiveEffort,
            currentStep: `${this.providers[chosenProvider].label} ワーカー起動中...`,
            workerThreadId: null,
            activeTurnId: null,
            previewURL: null,
            latestOutput: "",
            activities: [],
            createdAt: now,
            updatedAt: now,
          };
          this.tasks = [task, ...this.tasks];
        } else {
          this.pendingAutoResumeTaskIds = this.pendingAutoResumeTaskIds.filter(
            (id) => id !== task!.id,
          );
          this.updateTask(task.id, (t) => {
            t.projectId = project!.id;
            t.projectName = project!.name;
            t.projectPath = project!.path;
            t.provider = chosenProvider;
            t.status = "running";
            t.autoResumeOnStartup = false;
            t.workerPrompt = prompt;
            t.lastWorkerPrompt = prompt;
            t.workerModel = effectiveModel;
            t.workerEffort = effectiveEffort;
            t.currentStep = `${this.providers[chosenProvider].label} ワーカー起動中...`;
            t.updatedAt = now;
          });
        }

        const startedTask = this.tasks.find((t) => t.id === task!.id) ?? task;
        this.recordMcpMentionAssociation(
          "start_worker",
          args,
          createTaskMentionRef(startedTask, this.projects),
          context,
        );

        const wt = this.provisionWorktreeForTask(task.id, project);
        const workerCwd = wt.cwd;
        const workerInstructions = buildWorkerDeveloperInstructions({
          projectName: project.name,
          cwd: workerCwd,
          projectPath: project.path,
          worktreeBranch: wt.worktreeBranch,
          preferredLanguage: this.preferredLanguage,
        });

        if (chosenProvider === "agy" || chosenProvider === "claude") {
          this.launchCliProjectWorker({
            taskId: task.id,
            provider: chosenProvider,
            project,
            cwd: workerCwd,
            worktreeBranch: wt.worktreeBranch,
            prompt,
            workerInstructions,
            model: effectiveModel,
            effort: effectiveEffort,
            resumeSessionId: null,
          });
          const latest = this.tasks.find((t) => t.id === task!.id)!;
          return { text: JSON.stringify({ status: "started", provider: chosenProvider, task: this.taskSummary(latest) }, null, 2) };
        }

        const threadId = await this.workerClient.startThread({
          cwd: workerCwd,
          model: effectiveModel,
          developerInstructions: workerInstructions,
        });
        const turnId = await this.workerClient.startTurn({
          threadId,
          text: prompt,
          model: effectiveModel,
          effort: effectiveEffort,
        });

        this.updateTask(task.id, (t) => {
          t.workerThreadId = threadId;
          t.activeTurnId = turnId;
          t.provider = "codex";
          t.status = "running";
          t.autoResumeOnStartup = false;
          t.latestOutput = "";
          t.currentStep = "作業中...";
          t.activities.push({
            id: crypto.randomUUID(),
            kind: "system",
            title: wt.worktreeBranch
              ? `Codex worker started in ${project!.name} (${wt.worktreeBranch})`
              : `Codex worker started in ${project!.name}`,
            detail: prompt.slice(0, 300),
            timestamp: new Date().toISOString(),
          });
          t.updatedAt = new Date().toISOString();
        });
        this.persist();
        this.broadcastSnapshot();
        const latest = this.tasks.find((t) => t.id === task!.id)!;
        return { text: JSON.stringify({ status: "started", provider: "codex", task: this.taskSummary(latest) }, null, 2) };
      }

      case "send_to_worker": {
        const taskId = asString(args.task_id);
        const prompt = asString(args.prompt);
        const res = await this.sendToTaskWorker(taskId ?? "", prompt ?? "");
        if (!res.ok) {
          return { text: res.error ?? "Failed to send to worker", isError: true };
        }
        const linkedTask = this.resolveTaskByIdOrCode(res.taskId ?? taskId);
        if (linkedTask) {
          this.recordMcpMentionAssociation(
            "send_to_worker",
            args,
            createTaskMentionRef(linkedTask, this.projects),
            context,
          );
        }
        return {
          text: JSON.stringify({
            status: res.status,
            provider: res.provider,
            task_id: res.taskId,
            task_code: res.taskCode,
            ...(res.turnId ? { turn_id: res.turnId } : {}),
          }),
        };
      }

      case "stop_worker": {
        const taskId = asString(args.task_id);
        const task = this.resolveTaskByIdOrCode(taskId);
        if (!task) return { text: "Missing task_id", isError: true };
        await this.stopTaskWorker(task.id);
        const latestTask = this.tasks.find((t) => t.id === task.id) ?? task;
        this.recordMcpMentionAssociation(
          "stop_worker",
          args,
          createTaskMentionRef(latestTask, this.projects),
          context,
        );
        return { text: JSON.stringify({ status: "stop_requested", task_id: task.id, task_code: formatTaskCode(task.taskNumber) }) };
      }

      case "get_task_detail": {
        const taskId = asString(args.task_id);
        const task = this.resolveTaskByIdOrCode(taskId);
        if (!task) return { text: "Task not found", isError: true };
        this.recordMcpMentionAssociation(
          "get_task_detail",
          args,
          createTaskMentionRef(task, this.projects),
          context,
        );
        const gitDir = resolveTaskWorkingDir(task);
        const provider: AgentProvider = task.provider ?? "codex";
        const transcriptPath =
          provider === "agy"
            ? resolveAgyTranscriptPath(task.workerThreadId, this.agyBrainBaseDir)
            : null;
        const recentTranscriptExcerpt = transcriptPath
          ? readRecentAgyTranscriptExcerpt(transcriptPath)
          : null;
        return {
          text: JSON.stringify(
            {
              task: this.taskSummary(task),
              is_worker_active: this.hasActiveWorkerForTask(task),
              worker_prompt: truncateTaskText(task.workerPrompt, 2000),
              last_worker_prompt: truncateTaskText(task.lastWorkerPrompt, 2000),
              worktree_path: gitDir,
              latest_output: task.latestOutput.slice(-4000),
              git_status: gitDir ? getGitStatusSummary(gitDir) : null,
              git_diff_stat: gitDir ? getGitDiffStat(gitDir) : null,
              transcript_path: transcriptPath,
              recent_transcript_excerpt: recentTranscriptExcerpt,
              recent_activities: task.activities.slice(-20),
            },
            null,
            2,
          ),
        };
      }

      // --- Real Chromium CDP Browser Automation ---
      case "browser_open": {
        const url = asString(args.url);
        if (!url) return { text: "Missing url", isError: true };
        const taskId = asString(args.task_id);
        const linkedTask = this.resolveTaskByIdOrCode(taskId);
        const linkedProjectId = linkedTask
          ? (linkedTask.projectId ??
              this.projects.find(
                (p) => p.name.toLowerCase() === linkedTask.projectName.toLowerCase(),
              )?.id ??
              null)
          : undefined;
        this.showBrowserPane = true;
        const opened = await this.browser.navigate(url, args.new_tab === true, linkedProjectId);
        if (linkedTask) {
          this.updateTask(linkedTask.id, (t) => {
            t.previewURL = opened;
          });
          const latestLinked = this.tasks.find((t) => t.id === linkedTask.id) ?? linkedTask;
          this.recordMcpMentionAssociation(
            "browser_open",
            args,
            createTaskMentionRef(latestLinked, this.projects),
            context,
          );
        }
        this.persist();
        this.broadcastSnapshot();
        return { text: JSON.stringify({ opened, new_tab: args.new_tab === true }) };
      }

      case "browser_snapshot": {
        const snap = await this.browser.agentSnapshot();
        return { text: JSON.stringify(snap, null, 2) };
      }

      case "browser_click": {
        const target = asString(args.target);
        if (!target) return { text: "Missing target", isError: true };
        const res = await this.browser.agentClick(target);
        return { text: JSON.stringify(res) };
      }

      case "browser_type": {
        const target = asString(args.target);
        const text = asString(args.text);
        if (!target || text === null) return { text: "Missing target or text", isError: true };
        const res = await this.browser.agentType(
          target,
          text,
          args.clear !== false,
          args.submit === true,
        );
        return { text: JSON.stringify(res) };
      }

      case "browser_press_key": {
        const key = asString(args.key);
        if (!key) return { text: "Missing key", isError: true };
        const res = await this.browser.agentPressKey(key);
        return { text: JSON.stringify(res) };
      }

      case "browser_scroll": {
        const deltaY = typeof args.delta_y === "number" ? args.delta_y : 500;
        const res = await this.browser.agentScroll(deltaY);
        return { text: JSON.stringify(res) };
      }

      case "browser_screenshot": {
        const att = await this.browser.captureViewportAttachment();
        if (!att) return { text: "No active page to screenshot", isError: true };
        return {
          text: JSON.stringify({
            image_path: att.imagePath,
            url: att.url,
            label: att.label,
          }),
        };
      }

      case "browser_console_errors": {
        const diag = this.browser.getDiagnostics();
        return { text: JSON.stringify(diag, null, 2) };
      }

      default:
        return { text: `Unknown tool: ${name}`, isError: true };
    }
  }

  // MARK: - Helpers

  private cleanupClaudeTurnMcpConfig(assistantMessageId: string): void {
    const configPath = this.claudeTurnMcpConfigPaths.get(assistantMessageId);
    if (!configPath) return;
    this.claudeTurnMcpConfigPaths.delete(assistantMessageId);
    try {
      fs.rmSync(configPath, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  private findMessageById(messageId: string): ChatMessage | undefined {
    const inActive = this.messages.find((m) => m.id === messageId);
    if (inActive) return inActive;
    for (const session of this.chatSessions) {
      const found = session.messages.find((m) => m.id === messageId);
      if (found) return found;
    }
    return undefined;
  }

  private resolveUserMessageIdForAssistantMessage(assistantMessageId: string | null | undefined): string | null {
    if (!assistantMessageId) return null;
    const msg = this.findMessageById(assistantMessageId);
    return msg?.replyToMessageId ?? null;
  }

  private getActiveResponderAssistantMessageIds(): string[] {
    const ids = new Set<string>();
    for (const lane of this.responderLanes) {
      if (lane.activeAssistantMessageId) ids.add(lane.activeAssistantMessageId);
    }
    for (const lane of this.agyResponderLanes) {
      if (lane.activeAssistantMessageId) ids.add(lane.activeAssistantMessageId);
    }
    for (const assistantId of this.activeCliResponders.keys()) {
      ids.add(assistantId);
    }
    return [...ids];
  }

  private resolveUserMessageIdForMcpCall(
    toolName: string,
    args: Record<string, unknown>,
    context?: MCPToolCallContext,
  ): string | null {
    if (context?.userMessageId) {
      return context.userMessageId;
    }
    if (context?.assistantMessageId) {
      return this.resolveUserMessageIdForAssistantMessage(context.assistantMessageId);
    }
    if (context?.laneId) {
      const agyLane = this.agyResponderLanes.find((l) => l.laneId === context.laneId);
      return this.resolveUserMessageIdForAssistantMessage(agyLane?.activeAssistantMessageId);
    }

    const activeAssistantIds = this.getActiveResponderAssistantMessageIds();
    if (activeAssistantIds.length === 0) return null;
    if (activeAssistantIds.length === 1) {
      return this.resolveUserMessageIdForAssistantMessage(activeAssistantIds[0]);
    }

    // Multiple parallel responders active without explicit HTTP context (e.g. concurrent Codex lanes):
    // correlate using in-flight MCP tool call events tracked per responder thread/message.
    const activeSet = new Set(activeAssistantIds);
    const matchingToolCalls = [...this.inFlightMcpToolCalls.values()].filter(
      (entry) => activeSet.has(entry.assistantMessageId) && entry.toolName === toolName,
    );
    if (matchingToolCalls.length === 0) return null;

    const argsKey = buildMcpArgsCorrelationKey(toolName, args);
    const compatibleToolCalls = matchingToolCalls.filter(
      (entry) => !argsKey || !entry.argsKey || entry.argsKey === argsKey,
    );
    if (compatibleToolCalls.length === 0) return null;

    if (argsKey) {
      const exactMatches = compatibleToolCalls.filter((entry) => entry.argsKey === argsKey);
      const exactAssistantIds = new Set(exactMatches.map((e) => e.assistantMessageId));
      if (exactAssistantIds.size === 1) {
        const [matchedAssistantId] = exactAssistantIds;
        return this.resolveUserMessageIdForAssistantMessage(matchedAssistantId);
      }
    }

    const distinctAssistantIds = new Set(compatibleToolCalls.map((e) => e.assistantMessageId));
    if (distinctAssistantIds.size === 1) {
      const [matchedAssistantId] = distinctAssistantIds;
      return this.resolveUserMessageIdForAssistantMessage(matchedAssistantId);
    }

    return null;
  }

  private recordMcpMentionAssociation(
    toolName: string,
    args: Record<string, unknown>,
    ref: ChatMessageMentionRef,
    context?: MCPToolCallContext,
  ): void {
    const userMessageId = this.resolveUserMessageIdForMcpCall(toolName, args, context);
    if (userMessageId) {
      this.attachInferredMentionToUserMessage(userMessageId, ref);
      return;
    }

    // If multiple parallel responders are active and Codex's stdio item/started hasn't arrived yet,
    // buffer the resolved ref briefly so handleOrchestratorItem can attribute it to the exact turn.
    if (!context?.laneId && !context?.assistantMessageId && !context?.userMessageId) {
      const activeCount = this.getActiveResponderAssistantMessageIds().length;
      if (activeCount > 1) {
        const now = Date.now();
        this.pendingUnattributedMcpRefs = this.pendingUnattributedMcpRefs
          .filter((entry) => now - entry.createdAt < 30_000)
          .slice(-31);
        this.pendingUnattributedMcpRefs.push({
          toolName,
          argsKey: buildMcpArgsCorrelationKey(toolName, args),
          ref,
          createdAt: now,
        });
      }
    }
  }

  private tryClaimPendingUnattributedMcpRef(
    assistantMessageId: string,
    toolName: string,
    argsKey: string | null,
    rawResult: unknown,
  ): void {
    if (this.pendingUnattributedMcpRefs.length === 0) return;
    const now = Date.now();
    this.pendingUnattributedMcpRefs = this.pendingUnattributedMcpRefs.filter(
      (entry) => now - entry.createdAt < 30_000,
    );
    if (this.pendingUnattributedMcpRefs.length === 0) return;

    let matchIdx = -1;
    if (argsKey) {
      matchIdx = this.pendingUnattributedMcpRefs.findIndex(
        (entry) => entry.toolName === toolName && entry.argsKey === argsKey,
      );
    }

    if (matchIdx === -1 && rawResult !== null && rawResult !== undefined) {
      let serializedResult = "";
      try {
        serializedResult =
          typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
      } catch {
        serializedResult = "";
      }
      if (serializedResult) {
        matchIdx = this.pendingUnattributedMcpRefs.findIndex((entry) => {
          if (entry.toolName !== toolName) return false;
          if (entry.ref.kind === "task") {
            return (
              serializedResult.includes(entry.ref.taskId) ||
              serializedResult.includes(`"${formatTaskCode(entry.ref.taskNumber)}"`)
            );
          }
          return Boolean(
            (entry.ref.projectId && serializedResult.includes(entry.ref.projectId)) ||
              (entry.ref.projectPath && serializedResult.includes(entry.ref.projectPath)),
          );
        });
      }
    }

    if (matchIdx === -1) {
      const sameToolIndices: number[] = [];
      for (let i = 0; i < this.pendingUnattributedMcpRefs.length; i += 1) {
        if (this.pendingUnattributedMcpRefs[i]!.toolName === toolName) {
          sameToolIndices.push(i);
        }
      }
      if (sameToolIndices.length === 1) {
        matchIdx = sameToolIndices[0]!;
      }
    }

    if (matchIdx === -1) return;
    const [claimed] = this.pendingUnattributedMcpRefs.splice(matchIdx, 1);
    const userMessageId = this.resolveUserMessageIdForAssistantMessage(assistantMessageId);
    if (claimed && userMessageId) {
      this.attachInferredMentionToUserMessage(userMessageId, claimed.ref);
    }
  }

  private attachInferredMentionToUserMessage(
    userMessageId: string,
    ref: ChatMessageMentionRef,
  ): boolean {
    const userMsg = this.findMessageById(userMessageId);
    if (!userMsg || userMsg.role !== "user") return false;

    const explicitMentions: ChatMessageMentionRef[] = [
      ...(Array.isArray(userMsg.mentions) ? userMsg.mentions : []),
      ...extractMentionRefsForMessage(userMsg.text, this.projects, this.tasks),
    ];
    const merged = mergeChatMessageMentionRefs(userMsg.inferredMentions, [ref], explicitMentions);
    if (!merged.changed) return false;

    this.updateMessage(userMessageId, (m) => {
      m.inferredMentions = merged.refs;
    });
    this.persist();
    this.broadcastSnapshot();
    return true;
  }

  private findProject(query: string): Project | null {
    const q = query.trim();
    const byId = this.projects.find((p) => p.id === q);
    if (byId) return byId;
    const byName = this.projects.find((p) => p.name.toLowerCase() === q.toLowerCase());
    if (byName) return byName;
    const canonical = canonicalDirectory(q);
    if (canonical) {
      const byPath = this.projects.find((p) => p.path === canonical);
      if (byPath) return byPath;
    }
    return this.projects.find((p) => p.name.toLowerCase().includes(q.toLowerCase())) ?? null;
  }

  private allocateTaskNumber(): number {
    const num = this.nextTaskNumber;
    this.nextTaskNumber += 1;
    return num;
  }

  private resolveTaskByIdOrCode(idOrCode: string | null | undefined): AgentTask | undefined {
    const q = idOrCode?.trim();
    if (!q) return undefined;
    const byId = this.tasks.find((t) => t.id === q);
    if (byId) return byId;
    const match = q.match(/^@?(?:[^/\s]+\/)?[Tt](\d+)$/);
    if (match) {
      const num = Number(match[1]);
      return this.tasks.find((t) => t.taskNumber === num);
    }
    return undefined;
  }

  private taskSummary(t: AgentTask): Record<string, unknown> {
    return {
      id: t.id,
      task_number: t.taskNumber,
      task_code: formatTaskCode(t.taskNumber),
      title: t.title,
      summary: t.summary,
      project_name: t.projectName,
      project_path: t.projectPath,
      status: t.status,
      current_step: t.currentStep,
      preview_url: t.previewURL,
      has_worker: Boolean(t.workerThreadId),
      worktree_path: t.worktreePath ?? null,
      worktree_branch: t.worktreeBranch ?? null,
      base_branch: t.baseBranch ?? null,
      land_status: t.landStatus ?? null,
      landed_branch: t.landedBranch ?? null,
      pr_url: t.prUrl ?? null,
    };
  }

  private updateMessage(id: string, mutate: (m: ChatMessage) => void): void {
    let touchedActive = false;
    this.messages = this.messages.map((m) => {
      if (m.id !== id) return m;
      touchedActive = true;
      const copy: ChatMessage = { ...m, toolChips: m.toolChips.map((c) => ({ ...c })) };
      mutate(copy);
      return copy;
    });

    if (touchedActive) {
      this.snapshotVersion += 1;
      this.syncActiveChatSession(false);
      return;
    }

    // Message may belong to a background/previous session (e.g., stopped while switching)
    this.chatSessions = this.chatSessions.map((session) => {
      if (!session.messages.some((m) => m.id === id)) return session;
      const nextMessages = session.messages.map((m) => {
        if (m.id !== id) return m;
        const copy: ChatMessage = { ...m, toolChips: m.toolChips.map((c) => ({ ...c })) };
        mutate(copy);
        return copy;
      });
      return {
        ...session,
        messages: nextMessages,
        title: deriveChatSessionTitle(nextMessages),
        preview: deriveChatSessionPreview(nextMessages),
      };
    });
  }

  private updateTask(id: string, mutate: (t: AgentTask) => void): void {
    this.tasks = this.tasks.map((t) => {
      if (t.id !== id) return t;
      const copy: AgentTask = { ...t, activities: [...t.activities] };
      mutate(copy);
      return copy;
    });
  }

  // MARK: - Startup Auto-Resume for Interrupted Tasks

  public async resumePendingInterruptedTasks(): Promise<void> {
    if (this.isShuttingDown || this.pendingAutoResumeTaskIds.length === 0) return;
    const taskIds = this.pendingAutoResumeTaskIds.splice(0);
    for (const taskId of taskIds) {
      if (this.isShuttingDown) {
        // Re-queue remaining unresumed tasks if shutdown starts mid-resume
        this.pendingAutoResumeTaskIds.push(taskId);
        continue;
      }
      await this.resumeInterruptedTask(taskId);
    }
  }

  private failPendingInterruptedTasks(reason: string): void {
    const taskIds = this.pendingAutoResumeTaskIds.splice(0);
    for (const taskId of taskIds) {
      this.markAutoResumeFailed(taskId, reason);
    }
  }

  private markAutoResumeFailed(taskId: string, reason: string): void {
    let failedTask: AgentTask | undefined;
    const now = new Date().toISOString();
    this.updateTask(taskId, (t) => {
      t.status = "failed";
      t.autoResumeOnStartup = false;
      t.activeTurnId = null;
      t.currentStep = "自動再開に失敗";
      t.activities.push({
        id: crypto.randomUUID(),
        kind: "error",
        title: "再起動後の自動再開に失敗",
        detail: reason,
        timestamp: now,
      });
      t.updatedAt = now;
      failedTask = t;
    });
    if (failedTask) {
      const locale = this.getUiLocale();
      this.appendMessagesToActiveChat([
        {
          id: crypto.randomUUID(),
          role: "taskEvent",
          provider: failedTask.provider,
          text: `**[${formatTaskCode(failedTask.taskNumber)} · ${failedTask.projectName}] ${failedTask.title}** — ${t(locale, "taskEvent.autoResumeFailed")}\n${reason}`,
          attachments: [],
          toolChips: [],
          relatedTaskId: failedTask.id,
          isStreaming: false,
          createdAt: now,
        },
      ]);
    }
    this.persist();
    this.broadcastSnapshot();
  }

  private async resumeInterruptedTask(taskId: string): Promise<void> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task || this.isShuttingDown || task.status === "done" || task.status === "running") {
      return;
    }

    try {
      const matchedProject =
        (task.projectId ? this.projects.find((p) => p.id === task.projectId) : null) ??
        (task.projectPath ? this.projects.find((p) => p.path === task.projectPath) : null);
      const rawProjectPath = task.projectPath ?? matchedProject?.path ?? null;
      const existingProjectPath = rawProjectPath ? canonicalDirectory(rawProjectPath) : null;
      if (!existingProjectPath) {
        this.markAutoResumeFailed(
          task.id,
          `プロジェクトディレクトリが見つからないため自動再開できませんでした: ${rawProjectPath ?? "(未設定)"}`,
        );
        return;
      }

      let workerCwd = existingProjectPath;
      if (task.worktreePath) {
        if (!fs.existsSync(task.worktreePath)) {
          this.markAutoResumeFailed(
            task.id,
            `Worktree ディレクトリが見つからないため自動再開できませんでした: ${task.worktreePath}`,
          );
          return;
        }
        workerCwd = task.worktreePath;
      }

      const project: Project = matchedProject ?? {
        id: task.projectId ?? "",
        name: task.projectName,
        path: existingProjectPath,
        colorHex: "#6366F1",
        gitBranch: getGitBranch(existingProjectPath),
        addedAt: task.createdAt,
      };

      const chosenProvider: AgentProvider = task.provider ?? this.workerProvider;
      if (!this.providers[chosenProvider].available) {
        this.markAutoResumeFailed(
          task.id,
          `${this.providers[chosenProvider].label} が利用できないため自動再開できませんでした。`,
        );
        return;
      }

      const effectiveModel =
        task.workerModel ??
        (chosenProvider === this.workerProvider
          ? this.workerModel
          : chosenProvider === "agy"
            ? strongestAgyModel(this.providers.agy.models)
            : this.providers[chosenProvider].models[0]?.model ?? null);
      const effectiveEffort =
        task.workerEffort ?? (chosenProvider === this.workerProvider ? this.workerEffort : null);

      const workerInstructions = buildWorkerDeveloperInstructions({
        projectName: project.name,
        cwd: workerCwd,
        projectPath: project.path,
        worktreeBranch: task.worktreeBranch,
        preferredLanguage: this.preferredLanguage,
      });

      const sessionResumePrompt = buildSessionResumePrompt(task);
      const fallbackRerunPrompt = buildFallbackRerunPrompt(task);

      if (chosenProvider === "agy" || chosenProvider === "claude") {
        const hasSavedSession = Boolean(task.workerThreadId);
        const label = chosenProvider === "agy" ? "AGY" : "Claude";
        this.launchCliProjectWorker({
          taskId: task.id,
          provider: chosenProvider,
          project,
          cwd: workerCwd,
          worktreeBranch: task.worktreeBranch ?? null,
          prompt: hasSavedSession ? sessionResumePrompt : fallbackRerunPrompt,
          workerInstructions,
          model: effectiveModel,
          effort: effectiveEffort,
          resumeSessionId: task.workerThreadId,
          fallbackPromptOnResumeFailure: hasSavedSession ? fallbackRerunPrompt : undefined,
          initialStep: hasSavedSession
            ? "再起動後にセッションを自動再開中..."
            : "再起動後にタスクを自動再開中...",
          startActivityTitle: hasSavedSession
            ? `再起動後に自動再開 (${label} セッション継続)`
            : `再起動後に自動再開 (${label} 新規セッション)`,
        });
        const locale = this.getUiLocale();
        this.appendMessagesToActiveChat([
          {
            id: crypto.randomUUID(),
            role: "taskEvent",
            provider: chosenProvider,
            text: `**[${formatTaskCode(task.taskNumber)} · ${task.projectName} · ${label}] ${task.title}** — ${
              hasSavedSession
                ? t(locale, "taskEvent.autoResumedSession")
                : t(locale, "taskEvent.autoResumedNew")
            }`,
            attachments: [],
            toolChips: [],
            relatedTaskId: task.id,
            isStreaming: false,
            createdAt: new Date().toISOString(),
          },
        ]);
        this.persist();
        this.broadcastSnapshot();
        return;
      }

      if (!this.workerClient.isConnected()) {
        this.markAutoResumeFailed(
          task.id,
          "Codex Worker に接続されていないため自動再開できませんでした。",
        );
        return;
      }

      let threadId: string | null = null;
      let turnId: string | null = null;
      let usedSessionResume = false;
      let resumeFallbackNote: string | null = null;

      if (task.workerThreadId) {
        try {
          const resumedThreadId = await this.workerClient.resumeThread({
            threadId: task.workerThreadId,
            cwd: workerCwd,
            model: effectiveModel,
            developerInstructions: workerInstructions,
          });
          turnId = await this.workerClient.startTurn({
            threadId: resumedThreadId,
            text: sessionResumePrompt,
            model: effectiveModel,
            effort: effectiveEffort,
          });
          threadId = resumedThreadId;
          usedSessionResume = true;
        } catch (resumeErr) {
          resumeFallbackNote = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
        }
      }

      if (this.isShuttingDown) return;

      if (!threadId || !turnId) {
        threadId = await this.workerClient.startThread({
          cwd: workerCwd,
          model: effectiveModel,
          developerInstructions: workerInstructions,
        });
        turnId = await this.workerClient.startTurn({
          threadId,
          text: fallbackRerunPrompt,
          model: effectiveModel,
          effort: effectiveEffort,
        });
        usedSessionResume = false;
      }

      if (this.isShuttingDown) return;

      const now = new Date().toISOString();
      this.updateTask(task.id, (t) => {
        t.workerThreadId = threadId;
        t.activeTurnId = turnId;
        t.provider = "codex";
        t.status = "running";
        t.autoResumeOnStartup = false;
        t.currentStep = usedSessionResume
          ? "再起動後にセッションを自動再開中..."
          : "再起動後にタスクを自動再開中...";
        t.activities.push({
          id: crypto.randomUUID(),
          kind: "system",
          title: usedSessionResume
            ? "再起動後に自動再開 (Codex セッション継続)"
            : "再起動後に自動再開 (Codex 新規セッション)",
          detail: resumeFallbackNote
            ? `既存スレッドの復元に失敗したため新規セッションで再開: ${resumeFallbackNote}`
            : usedSessionResume
              ? `thread=${threadId}`
              : fallbackRerunPrompt.slice(0, 300),
          timestamp: now,
        });
        t.updatedAt = now;
      });
      const locale = this.getUiLocale();
      this.appendMessagesToActiveChat([
        {
          id: crypto.randomUUID(),
          role: "taskEvent",
          provider: "codex",
          text: `**[${formatTaskCode(task.taskNumber)} · ${task.projectName} · Codex] ${task.title}** — ${
            usedSessionResume
              ? t(locale, "taskEvent.autoResumedSession")
              : t(locale, "taskEvent.autoResumedNew")
          }`,
          attachments: [],
          toolChips: [],
          relatedTaskId: task.id,
          isStreaming: false,
          createdAt: now,
        },
      ]);
      this.persist();
      this.broadcastSnapshot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.markAutoResumeFailed(task.id, msg);
    }
  }

  public async sendToTaskWorker(
    taskIdOrCode: string,
    prompt: string,
  ): Promise<{
    ok: boolean;
    status?: "steered" | "sent";
    provider?: AgentProvider;
    taskId?: string;
    taskCode?: string;
    turnId?: string;
    error?: string;
  }> {
    const trimmedPrompt = prompt.trim();
    const task = this.resolveTaskByIdOrCode(taskIdOrCode);
    if (!task || !trimmedPrompt) {
      return { ok: false, error: "Task not found" };
    }

    this.pendingAutoResumeTaskIds = this.pendingAutoResumeTaskIds.filter(
      (id) => id !== task.id,
    );
    const taskCode = formatTaskCode(task.taskNumber);
    const prov: AgentProvider = task.provider ?? "codex";

    if (prov === "agy" || prov === "claude") {
      const project =
        (task.projectId ? this.projects.find((p) => p.id === task.projectId) : null) ??
        (task.projectPath
          ? {
              id: task.projectId ?? "",
              name: task.projectName,
              path: task.projectPath,
              colorHex: "#6366F1",
              gitBranch: null,
              addedAt: task.createdAt,
            }
          : null);
      if (!project) {
        return { ok: false, error: "Task project path unavailable" };
      }

      const workerCwd = resolveTaskWorkingDir(task) ?? project.path;
      const label = prov === "agy" ? "AGY" : "Claude";
      const existingWorker = this.activeCliWorkers.get(task.id);
      const isSteer = Boolean(existingWorker);

      if (existingWorker) {
        // Supersede the previous run BEFORE cancelling so its late/sync callbacks are ignored
        // and cannot clobber the replacement worker or mark the task failed/needs_review.
        const steerGen = this.bumpCliWorkerGeneration(task.id);
        this.activeCliWorkers.delete(task.id);
        existingWorker.cancel();
        await this.waitForCliWorkerExit(existingWorker, 1500);
        if (this.isShuttingDown || !this.isCurrentCliWorkerGeneration(task.id, steerGen)) {
          return {
            ok: true,
            status: "steered",
            provider: prov,
            taskId: task.id,
            taskCode,
          };
        }
      }

      const latestTask = this.tasks.find((t) => t.id === task.id);
      if (!latestTask) {
        return { ok: false, error: "Task not found" };
      }

      const originalPrompt = latestTask.workerPrompt ?? null;
      const resumeSessionId = latestTask.workerThreadId ?? null;
      const fullWorkerInstructions = buildWorkerDeveloperInstructions({
        projectName: project.name,
        cwd: workerCwd,
        projectPath: project.path,
        worktreeBranch: latestTask.worktreeBranch,
        preferredLanguage: this.preferredLanguage,
      });
      const workerInstructions = resumeSessionId
        ? buildWorkerLanguageInstruction(this.preferredLanguage)
        : fullWorkerInstructions;

      const effectivePrompt = isSteer
        ? buildCliSteerPrompt({
            originalPrompt,
            steerPrompt: trimmedPrompt,
            hasResumeSession: Boolean(resumeSessionId),
          })
        : resumeSessionId
          ? trimmedPrompt
          : buildCliFallbackFollowUpPrompt({
              originalPrompt,
              followUpPrompt: trimmedPrompt,
            });

      const fallbackPromptOnResumeFailure = resumeSessionId
        ? isSteer
          ? buildCliSteerPrompt({
              originalPrompt,
              steerPrompt: trimmedPrompt,
              hasResumeSession: false,
            })
          : buildCliFallbackFollowUpPrompt({
              originalPrompt,
              followUpPrompt: trimmedPrompt,
            })
        : undefined;

      this.updateTask(latestTask.id, (t) => {
        if (!t.workerPrompt) t.workerPrompt = trimmedPrompt;
        t.lastWorkerPrompt = trimmedPrompt;
        t.autoResumeOnStartup = false;
      });

      this.launchCliProjectWorker({
        taskId: latestTask.id,
        provider: prov,
        project,
        cwd: workerCwd,
        worktreeBranch: latestTask.worktreeBranch ?? null,
        prompt: effectivePrompt,
        workerInstructions,
        fallbackWorkerInstructions: resumeSessionId ? fullWorkerInstructions : undefined,
        model: latestTask.workerModel ?? (prov === this.workerProvider ? this.workerModel : null),
        effort: latestTask.workerEffort ?? (prov === this.workerProvider ? this.workerEffort : null),
        resumeSessionId,
        fallbackPromptOnResumeFailure,
        initialStep: isSteer ? "ステア指示を反映中..." : "追加指示を実行中...",
        startActivityTitle: isSteer ? `Steered worker (${label})` : `Follow-up sent (${label})`,
        startActivityDetail: trimmedPrompt.slice(0, 300),
      });

      return {
        ok: true,
        status: isSteer ? "steered" : "sent",
        provider: prov,
        taskId: latestTask.id,
        taskCode,
      };
    }

    // Codex worker: steer active turn in-place when running, otherwise start a new turn.
    if (!task.workerThreadId) {
      return { ok: false, error: "Worker thread not found" };
    }

    const model = task.workerModel ?? this.workerModel;
    const effort = task.workerEffort ?? this.workerEffort;
    const codexFollowUpText = `${trimmedPrompt}\n\n${buildWorkerLanguageInstruction(this.preferredLanguage)}`;

    if (task.status === "running" && task.activeTurnId) {
      try {
        const steeredTurnId = await this.workerClient.steerTurn({
          threadId: task.workerThreadId,
          expectedTurnId: task.activeTurnId,
          text: codexFollowUpText,
        });
        const now = new Date().toISOString();
        this.updateTask(task.id, (t) => {
          t.status = "running";
          t.autoResumeOnStartup = false;
          if (!t.workerPrompt) t.workerPrompt = trimmedPrompt;
          t.lastWorkerPrompt = trimmedPrompt;
          t.activeTurnId = steeredTurnId;
          t.currentStep = "ステア指示を反映中...";
          t.activities.push({
            id: crypto.randomUUID(),
            kind: "system",
            title: "Steered worker (Codex)",
            detail: trimmedPrompt.slice(0, 300),
            timestamp: now,
          });
          t.updatedAt = now;
        });
        this.persist();
        this.broadcastSnapshot();
        return {
          ok: true,
          status: "steered",
          provider: "codex",
          taskId: task.id,
          taskCode,
          turnId: steeredTurnId,
        };
      } catch {
        // Fallback gracefully: if the turn is still active, interrupt it before starting a new turn.
        const latest = this.tasks.find((t) => t.id === task.id);
        if (latest?.status === "running" && latest.workerThreadId && latest.activeTurnId) {
          await this.workerClient
            .interruptTurn(latest.workerThreadId, latest.activeTurnId)
            .catch(() => {});
        }
      }
    }

    const turnId = await this.workerClient.startTurn({
      threadId: task.workerThreadId,
      text: codexFollowUpText,
      model,
      effort,
    });
    const now = new Date().toISOString();
    this.updateTask(task.id, (t) => {
      t.status = "running";
      t.autoResumeOnStartup = false;
      if (!t.workerPrompt) t.workerPrompt = trimmedPrompt;
      t.lastWorkerPrompt = trimmedPrompt;
      t.activeTurnId = turnId;
      t.latestOutput = "";
      t.currentStep = "追加指示を実行中...";
      t.activities.push({
        id: crypto.randomUUID(),
        kind: "system",
        title: "Follow-up sent (Codex)",
        detail: trimmedPrompt.slice(0, 300),
        timestamp: now,
      });
      t.updatedAt = now;
    });
    this.persist();
    this.broadcastSnapshot();
    return {
      ok: true,
      status: "sent",
      provider: "codex",
      taskId: task.id,
      taskCode,
      turnId,
    };
  }

  private launchCliProjectWorker(args: {
    taskId: string;
    provider: "agy" | "claude";
    project: Project;
    cwd: string;
    worktreeBranch: string | null;
    prompt: string;
    workerInstructions: string;
    fallbackWorkerInstructions?: string;
    model: string | null;
    effort: string | null;
    resumeSessionId: string | null;
    fallbackPromptOnResumeFailure?: string;
    retriedWithoutResume?: boolean;
    initialStep?: string;
    startActivityTitle?: string;
    startActivityDetail?: string;
  }): void {
    const label = args.provider === "agy" ? "AGY" : "Claude";
    const generation = this.bumpCliWorkerGeneration(args.taskId);
    let sawOutput = false;
    let finishedSync = false;
    this.updateTask(args.taskId, (t) => {
      t.provider = args.provider;
      t.status = "running";
      t.autoResumeOnStartup = false;
      t.latestOutput = "";
      t.currentStep = args.initialStep ?? `${label} で作業中...`;
      t.activities.push({
        id: crypto.randomUUID(),
        kind: "system",
        title:
          args.startActivityTitle ??
          (args.worktreeBranch
            ? `${label} worker started in ${args.project.name} (${args.worktreeBranch})`
            : `${label} worker started in ${args.project.name}`),
        detail: args.startActivityDetail ?? args.prompt.slice(0, 300),
        timestamp: new Date().toISOString(),
      });
      t.updatedAt = new Date().toISOString();
    });
    this.persist();
    this.broadcastSnapshot();

    const callbacks = {
      onSessionId: (sid: string) => {
        if (this.isShuttingDown || !this.isCurrentCliWorkerGeneration(args.taskId, generation)) {
          return;
        }
        let changed = false;
        this.updateTask(args.taskId, (t) => {
          if (t.workerThreadId !== sid) {
            t.workerThreadId = sid;
            changed = true;
          }
        });
        if (changed) {
          this.persist();
        }
      },
      onTextDelta: (delta: string) => {
        if (this.isShuttingDown || !this.isCurrentCliWorkerGeneration(args.taskId, generation)) {
          return;
        }
        sawOutput = true;
        this.updateTask(args.taskId, (t) => {
          t.latestOutput += delta;
          t.currentStep = `${label} が報告を生成中...`;
          t.updatedAt = new Date().toISOString();
        });
        this.scheduleBroadcast();
      },
      onToolEvent: (ev: {
        id: string;
        name: string;
        detail?: string;
        completed: boolean;
        isError?: boolean;
      }) => {
        if (this.isShuttingDown || !this.isCurrentCliWorkerGeneration(args.taskId, generation)) {
          return;
        }
        sawOutput = true;
        this.updateTask(args.taskId, (t) => {
          t.currentStep = ev.completed ? `完了: ${ev.name}` : `実行中: ${ev.name}`;
          if (ev.completed) {
            t.activities.push({
              id: crypto.randomUUID(),
              kind: ev.isError ? "error" : "command",
              title: ev.name,
              detail: ev.detail ?? null,
              timestamp: new Date().toISOString(),
            });
          }
          t.updatedAt = new Date().toISOString();
        });
        this.broadcastSnapshot();
      },
      onRateLimit: (window: ProviderQuotaWindow) => {
        if (args.provider === "claude") {
          this.recordClaudeRateLimitWindow(window);
        }
      },
      onComplete: (outcome: {
        ok: boolean;
        finalText: string;
        errorMessage?: string;
        interrupted?: boolean;
        usage?: CliTurnUsage;
      }) => {
        if (!this.isCurrentCliWorkerGeneration(args.taskId, generation)) {
          return;
        }
        finishedSync = true;
        this.activeCliWorkers.delete(args.taskId);
        if (this.isShuttingDown) {
          return;
        }
        // If resuming an old CLI session failed before producing any output, retry once in a fresh session
        if (
          !outcome.ok &&
          !outcome.interrupted &&
          !sawOutput &&
          args.resumeSessionId &&
          args.fallbackPromptOnResumeFailure &&
          !args.retriedWithoutResume
        ) {
          this.updateTask(args.taskId, (t) => {
            t.workerThreadId = null;
            t.activities.push({
              id: crypto.randomUUID(),
              kind: "system",
              title: `${label} セッション復元に失敗したため新規セッションで再開`,
              detail: outcome.errorMessage ?? null,
              timestamp: new Date().toISOString(),
            });
            t.updatedAt = new Date().toISOString();
          });
          this.launchCliProjectWorker({
            ...args,
            prompt: args.fallbackPromptOnResumeFailure,
            workerInstructions: args.fallbackWorkerInstructions ?? args.workerInstructions,
            fallbackWorkerInstructions: undefined,
            resumeSessionId: null,
            fallbackPromptOnResumeFailure: undefined,
            retriedWithoutResume: true,
            initialStep: "新規セッションで再開中...",
            startActivityTitle: `新規セッションで再開 (${label})`,
          });
          return;
        }

        if (outcome.usage) {
          this.recordTurnUsage({
            source: "worker",
            provider: args.provider,
            model: outcome.usage.model ?? args.model ?? args.provider,
            projectName: args.project.name,
            taskId: args.taskId,
            tokens: outcome.usage,
            exactCostUsd: outcome.usage.costUsd,
          });
        }

        const wasConflictResolveTurn = this.activeConflictResolveTaskIds.has(args.taskId);
        this.activeConflictResolveTaskIds.delete(args.taskId);

        let preparedTask: AgentTask | undefined;
        this.updateTask(args.taskId, (t) => {
          t.activeTurnId = null;
          t.autoResumeOnStartup = false;
          if (outcome.finalText && !t.latestOutput) {
            t.latestOutput = outcome.finalText;
          }
          if (!t.previewURL) {
            const localUrl = extractFirstLocalUrl(t.latestOutput);
            if (localUrl) t.previewURL = localUrl;
          }
          t.updatedAt = new Date().toISOString();
          preparedTask = t;
        });

        if (outcome.interrupted || !outcome.ok) {
          if (wasConflictResolveTurn) {
            this.finalizeConflictResolutionFailure(
              args.taskId,
              outcome.interrupted
                ? "コンフリクト解消ワーカーが中断されました。"
                : outcome.errorMessage || "コンフリクト解消ワーカーがエラーで終了しました。",
            );
            return;
          }

          const locale = this.getUiLocale();
          let finishedTask: AgentTask | undefined;
          this.updateTask(args.taskId, (tTask) => {
            if (outcome.interrupted) {
              tTask.status = "needs_review";
              tTask.currentStep = t(locale, "taskStep.interrupted");
            } else {
              tTask.status = "failed";
              tTask.currentStep = t(locale, "taskStep.failed");
              if (outcome.errorMessage) {
                tTask.activities.push({
                  id: crypto.randomUUID(),
                  kind: "error",
                  title: `${label} error`,
                  detail: outcome.errorMessage,
                  timestamp: new Date().toISOString(),
                });
              }
            }
            tTask.updatedAt = new Date().toISOString();
            finishedTask = tTask;
          });

          if (finishedTask) {
            const excerpt = buildTaskCompletionExcerpt(
              finishedTask.latestOutput || outcome.errorMessage || "",
            );
            this.appendTaskEventMessage(
              finishedTask,
              finishedTask.status === "failed"
                ? t(locale, "taskEvent.failed")
                : t(locale, "taskEvent.completedReview"),
              excerpt || t(locale, "taskEvent.noOutput"),
            );
          }
          this.persist();
          this.broadcastSnapshot();
          return;
        }

        const shouldAutoLand =
          Boolean(preparedTask) &&
          (this.autoLandOnComplete || wasConflictResolveTurn) &&
          this.isTaskEligibleForAutoLand(preparedTask!);

        if (shouldAutoLand && preparedTask) {
          const locale = this.getUiLocale();
          const excerpt = buildTaskCompletionExcerpt(
            preparedTask.latestOutput || outcome.finalText || "",
          );
          this.updateTask(args.taskId, (tTask) => {
            tTask.status = "running";
            tTask.landStatus = "landing";
            tTask.currentStep = t(locale, "taskStep.autoLanding");
            tTask.updatedAt = new Date().toISOString();
          });
          this.persist();
          this.broadcastSnapshot();
          void this.runAutoLandForCompletedTask(args.taskId, {
            completionExcerpt: excerpt,
            wasConflictResolveTurn,
          });
          return;
        }

        const locale = this.getUiLocale();
        let finishedTask: AgentTask | undefined;
        this.updateTask(args.taskId, (tTask) => {
          tTask.status = "needs_review";
          tTask.currentStep = t(locale, "taskStep.completedReview");
          tTask.updatedAt = new Date().toISOString();
          finishedTask = tTask;
        });

        if (finishedTask) {
          const excerpt = buildTaskCompletionExcerpt(
            finishedTask.latestOutput || outcome.errorMessage || "",
          );
          this.appendTaskEventMessage(
            finishedTask,
            t(locale, "taskEvent.completedReview"),
            excerpt || t(locale, "taskEvent.noOutput"),
          );
        }
        this.persist();
        this.broadcastSnapshot();
      },
    };

    const running =
      args.provider === "agy"
        ? this.cliWorkerRunner.runAgyTurn(
            {
              cwd: args.cwd,
              prompt: args.workerInstructions
                ? `${args.workerInstructions}\n\n${args.prompt}`
                : args.prompt,
              model: args.model,
              effort: args.effort,
              conversationId: args.resumeSessionId,
            },
            callbacks,
          )
        : this.cliWorkerRunner.runClaudeTurn(
            {
              cwd: args.cwd,
              prompt: args.prompt,
              systemPrompt: args.workerInstructions || undefined,
              model: args.model,
              effort: args.effort,
              sessionId: args.resumeSessionId,
            },
            callbacks,
          );

    if (!finishedSync && this.isCurrentCliWorkerGeneration(args.taskId, generation)) {
      this.activeCliWorkers.set(args.taskId, running);
    }
  }

  private loadPersisted(): void {
    const saved = this.store.load();
    this.projects = saved.projects;
    this.scanRoots = saved.scanRoots ?? [];
    const normalized = normalizeTaskNumbers(saved.tasks, saved.nextTaskNumber);
    this.nextTaskNumber = normalized.nextTaskNumber;
    const resumePrep = prepareTasksForStartupAutoResume(normalized.tasks);
    this.tasks = resumePrep.tasks;
    this.pendingAutoResumeTaskIds = resumePrep.resumeTaskIds;
    const normalizedChats = normalizeChatSessions({
      chatSessions: saved.chatSessions,
      activeChatSessionId: saved.activeChatSessionId,
      legacyMessages: saved.messages,
      chatProvider: saved.chatProvider ?? "codex",
    });
    this.chatSessions = normalizedChats.chatSessions;
    this.activeChatSessionId = normalizedChats.activeChatSessionId;
    const activeChat = this.chatSessions.find((s) => s.id === this.activeChatSessionId);
    this.messages = activeChat ? activeChat.messages : [];
    this.showTaskSidebar = saved.showTaskSidebar;
    this.showBrowserPane = saved.showBrowserPane;
    this.chatProvider = saved.chatProvider ?? "codex";
    this.workerProvider = saved.workerProvider ?? "codex";
    this.chatModel = saved.chatModel;
    this.chatEffort = saved.chatEffort;
    this.workerModel = saved.workerModel;
    this.workerEffort = saved.workerEffort;
    this.defaultIntegrationMode = isValidIntegrationMode(saved.defaultIntegrationMode)
      ? saved.defaultIntegrationMode
      : "feature-branch";
    this.autoLandOnComplete =
      typeof saved.autoLandOnComplete === "boolean" ? saved.autoLandOnComplete : true;
    this.preferredLanguage = isValidPreferredLanguage(saved.preferredLanguage)
      ? saved.preferredLanguage
      : DEFAULT_PREFERRED_LANGUAGE;
    this.voiceReadbackEnabled =
      typeof saved.voiceReadbackEnabled === "boolean"
        ? saved.voiceReadbackEnabled
        : DEFAULT_VOICE_READBACK_ENABLED;
    this.remoteAccessEnabled =
      typeof saved.remoteAccessEnabled === "boolean" ? saved.remoteAccessEnabled : false;
    this.remoteAccessPort = normalizeRemoteAccessPort(saved.remoteAccessPort);
    this.remoteAccessToken =
      typeof saved.remoteAccessToken === "string" && saved.remoteAccessToken.trim().length >= 16
        ? saved.remoteAccessToken.trim()
        : generateRemoteAccessToken();
    this.usageRecords = normalizeUsageRecords(saved.usageRecords);
    this.usageBudgets = normalizeUsageBudgetSettings(saved.usageBudgets);
    this.browser.restore(saved.browserTabs, saved.activeBrowserTabId);
    if (normalized.changed || normalizedChats.changed || resumePrep.changed) {
      this.persist();
    }
  }

  private persist(): void {
    this.syncActiveChatSession(false);
    this.lastPersistedBrowserKey = this.computePersistedBrowserKey();
    this.store.save({
      projects: this.projects,
      scanRoots: this.scanRoots,
      tasks: this.tasks,
      nextTaskNumber: this.nextTaskNumber,
      messages: this.messages.slice(-MAX_MESSAGES_PER_SESSION),
      chatSessions: this.chatSessions,
      activeChatSessionId: this.activeChatSessionId,
      browserTabs: this.browser.getTabs().map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        ...(t.projectId ? { projectId: t.projectId } : {}),
      })),
      activeBrowserTabId: this.browser.getActiveTabId(),
      showTaskSidebar: this.showTaskSidebar,
      showBrowserPane: this.showBrowserPane,
      chatProvider: this.chatProvider,
      workerProvider: this.workerProvider,
      chatModel: this.chatModel,
      chatEffort: this.chatEffort,
      workerModel: this.workerModel,
      workerEffort: this.workerEffort,
      defaultIntegrationMode: this.defaultIntegrationMode,
      autoLandOnComplete: this.autoLandOnComplete,
      preferredLanguage: this.preferredLanguage,
      voiceReadbackEnabled: this.voiceReadbackEnabled,
      remoteAccessEnabled: this.remoteAccessEnabled,
      remoteAccessPort: this.remoteAccessPort,
      remoteAccessToken: this.remoteAccessToken,
      usageRecords: this.usageRecords,
      usageBudgets: this.usageBudgets,
    });
  }

  private scheduleBroadcast(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.broadcastSnapshot();
    }, 50);
  }

  private broadcastSnapshot(): void {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.snapshotVersion += 1;
    const snapshot = this.getSnapshot();
    this.emitSnapshot(snapshot);
    this.remoteServer?.publishSnapshot(snapshot);
  }
}
