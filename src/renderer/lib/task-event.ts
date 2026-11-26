import type { AgentTask, ChatMessage } from "../../shared/types.js";

const LEGACY_TASK_CODE_BRACKET_RE = /\[T(\d+)(?:\s*[·•|/:-]\s*([^\]]+?))?\]/gi;

interface ParsedLegacyTaskRef {
  taskNumber: number;
  projectHint: string | null;
}

/**
 * Extracts unambiguous `[T# ...]` task references from the header line of a legacy
 * `taskEvent` message (e.g. `**[T12 · agent_terminal_2 · AGY] Title** — 完了`).
 * Returns `null` when no code is present or when multiple distinct task numbers appear.
 */
function parseLegacyTaskEventHeader(text: string): ParsedLegacyTaskRef | null {
  const firstLine = text
    .split(/\r?\n/, 1)[0]
    ?.trim();
  if (!firstLine) return null;

  const byNumber = new Map<number, string | null>();
  LEGACY_TASK_CODE_BRACKET_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = LEGACY_TASK_CODE_BRACKET_RE.exec(firstLine)) !== null) {
    const taskNumber = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(taskNumber) || taskNumber <= 0) continue;

    const rawRest = match[2]?.trim() ?? "";
    const firstSegment = rawRest
      ? rawRest.split(/\s*[·•|/]\s*/, 1)[0]?.trim() || null
      : null;

    if (!byNumber.has(taskNumber)) {
      byNumber.set(taskNumber, firstSegment);
    }
  }

  if (byNumber.size !== 1) {
    return null;
  }

  const [[taskNumber, projectHint]] = Array.from(byNumber.entries());
  return { taskNumber, projectHint };
}

/**
 * Resolves the live `AgentTask` associated with a `taskEvent` chat message.
 *
 * 1. When `message.relatedTaskId` is present, matches strictly by `task.id`.
 *    If that task no longer exists (e.g. deleted), returns `undefined` rather than
 *    risking a false match against another task.
 * 2. For legacy `taskEvent` messages lacking `relatedTaskId`, gracefully falls back
 *    to parsing a single unambiguous `[T# ...]` code from the message header line.
 */
export function resolveTaskForTaskEvent(
  message: Pick<ChatMessage, "relatedTaskId" | "text">,
  tasks: readonly AgentTask[],
): AgentTask | undefined {
  const explicitId = message.relatedTaskId?.trim();
  if (explicitId) {
    return tasks.find((task) => task.id === explicitId);
  }

  const legacyRef = parseLegacyTaskEventHeader(message.text);
  if (!legacyRef) return undefined;

  const candidates = tasks.filter((task) => task.taskNumber === legacyRef.taskNumber);
  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length > 1 && legacyRef.projectHint) {
    const targetProject = legacyRef.projectHint.toLowerCase();
    const narrowed = candidates.filter(
      (task) => task.projectName.toLowerCase() === targetProject,
    );
    if (narrowed.length === 1) {
      return narrowed[0];
    }
  }

  return undefined;
}

/**
 * Builds a virtual Markdown file path anchored in the task's worktree or project root
 * so relative image/video references inside task completion reports resolve cleanly.
 */
export function buildTaskMarkdownBasePath(
  task?: Pick<AgentTask, "worktreePath" | "projectPath"> | null,
): string | undefined {
  const dir = task?.worktreePath?.trim() || task?.projectPath?.trim();
  if (!dir) return undefined;
  const normalized = dir.replace(/[/\\]+$/, "");
  if (!normalized) return undefined;
  return `${normalized}/__task_report__.md`;
}
