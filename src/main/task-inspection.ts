import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTask } from "../shared/types.js";

const DEFAULT_PROMPT_MAX_CHARS = 2_000;
const DEFAULT_DIFF_STAT_MAX_CHARS = 4_000;
const DEFAULT_TRANSCRIPT_TAIL_BYTES = 24 * 1024;
const DEFAULT_TRANSCRIPT_MAX_ENTRIES = 12;
const DEFAULT_TRANSCRIPT_MAX_CHARS = 3_600;
const MAX_UNTRACKED_PREVIEW = 20;

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function truncateTaskText(
  text: string | null | undefined,
  maxChars = DEFAULT_PROMPT_MAX_CHARS,
): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n... [truncated ${trimmed.length - maxChars} chars]`;
}

export function resolveTaskWorkingDir(
  task: Pick<AgentTask, "worktreePath" | "projectPath">,
): string | null {
  if (task.worktreePath && fs.existsSync(task.worktreePath)) {
    return task.worktreePath;
  }
  return task.projectPath ?? null;
}

function execGitReadOnly(dir: string, args: string[], timeoutMs = 2500): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("/usr/bin/git", ["-C", dir, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout: stdout.trimEnd() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Lightweight, strictly read-only summary of modified/staged/untracked files for a task directory.
 */
export function getGitDiffStat(dir: string): string | null {
  const inside = execGitReadOnly(dir, ["rev-parse", "--is-inside-work-tree"], 2000);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return null;
  }

  const sections: string[] = [];

  // Prefer `diff HEAD --stat` (covers both staged & unstaged tracked changes in one fast call).
  const headDiff = execGitReadOnly(dir, ["diff", "HEAD", "--stat"]);
  if (headDiff.ok) {
    if (headDiff.stdout.trim()) {
      sections.push(headDiff.stdout.trim());
    }
  } else {
    // Fallback for repositories with an unborn HEAD (no commits yet).
    const staged = execGitReadOnly(dir, ["diff", "--cached", "--stat"]);
    if (staged.ok && staged.stdout.trim()) {
      sections.push(`Staged:\n${staged.stdout.trim()}`);
    }
    const unstaged = execGitReadOnly(dir, ["diff", "--stat"]);
    if (unstaged.ok && unstaged.stdout.trim()) {
      sections.push(`Unstaged:\n${unstaged.stdout.trim()}`);
    }
  }

  const untracked = execGitReadOnly(dir, ["ls-files", "--others", "--exclude-standard"], 2000);
  if (untracked.ok && untracked.stdout.trim()) {
    const files = untracked.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (files.length > 0) {
      const shown = files.slice(0, MAX_UNTRACKED_PREVIEW);
      const overflow = files.length - shown.length;
      const lines = shown.map((f) => `  ?? ${f}`);
      if (overflow > 0) {
        lines.push(`  ... (+${overflow} more untracked)`);
      }
      sections.push(`Untracked (${files.length}):\n${lines.join("\n")}`);
    }
  }

  if (sections.length === 0) {
    return "(no diff)";
  }

  const combined = sections.join("\n\n");
  if (combined.length <= DEFAULT_DIFF_STAT_MAX_CHARS) {
    return combined;
  }
  return `${combined.slice(0, DEFAULT_DIFF_STAT_MAX_CHARS)}\n... [truncated]`;
}

export function resolveAgyTranscriptPath(
  workerThreadId: string | null | undefined,
  brainBaseDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain"),
): string | null {
  const id = workerThreadId?.trim();
  if (!id) return null;
  // Guard against path traversal / invalid IDs
  if (id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) {
    return null;
  }
  const candidate = path.join(brainBaseDir, id, ".system_generated", "logs", "transcript.jsonl");
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function compactSingleLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function unquoteArgValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function summarizeToolCall(rawCall: unknown): string | null {
  const rec = asRecord(rawCall);
  if (!rec) return null;
  const name = asString(rec.name) ?? asString(rec.tool_name);
  if (!name) return null;
  const args = asRecord(rec.args) ?? asRecord(rec.arguments);
  const hint =
    unquoteArgValue(args?.Path) ??
    unquoteArgValue(args?.path) ??
    unquoteArgValue(args?.file_path) ??
    unquoteArgValue(args?.CommandLine) ??
    unquoteArgValue(args?.command) ??
    unquoteArgValue(args?.toolSummary) ??
    unquoteArgValue(args?.query);
  return hint ? `${name}(${compactSingleLine(hint, 70)})` : name;
}

function formatTranscriptEntry(entry: Record<string, unknown>): string | null {
  const stepIndex = typeof entry.step_index === "number" ? `#${entry.step_index}` : "#?";
  const type = asString(entry.type) ?? "STEP";
  const status = asString(entry.status) ?? "";
  const header = status ? `[${stepIndex} ${type} ${status}]` : `[${stepIndex} ${type}]`;

  const errorText =
    asString(entry.error) ??
    asString(asRecord(entry.error)?.message) ??
    asString(entry.error_message);

  if (type === "PLANNER_RESPONSE") {
    const parts: string[] = [];
    const thinking = asString(entry.thinking);
    if (thinking && thinking.trim()) {
      parts.push(`thinking: ${compactSingleLine(thinking, 260)}`);
    }
    const rawCalls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
    const callSummaries = rawCalls
      .map((c) => summarizeToolCall(c))
      .filter((s): s is string => Boolean(s))
      .slice(0, 6);
    if (callSummaries.length > 0) {
      const suffix = rawCalls.length > callSummaries.length ? ` (+${rawCalls.length - callSummaries.length})` : "";
      parts.push(`tools: ${callSummaries.join(", ")}${suffix}`);
    }
    const response = asString(entry.response) ?? asString(entry.content) ?? asString(entry.text);
    if (response && response.trim()) {
      parts.push(`response: ${compactSingleLine(response, 360)}`);
    }
    if (errorText) {
      parts.push(`error: ${compactSingleLine(errorText, 240)}`);
    }
    return parts.length > 0 ? `${header} ${parts.join(" | ")}` : header;
  }

  if (type === "USER_INPUT") {
    const content = asString(entry.content) ?? asString(entry.text);
    return content ? `${header} ${compactSingleLine(content, 180)}` : header;
  }

  const content = asString(entry.content) ?? asString(entry.output) ?? asString(entry.summary);
  const toolName = asString(entry.tool_name) ?? asString(entry.name);
  const parts: string[] = [];
  if (toolName) parts.push(`tool=${toolName}`);
  if (errorText) parts.push(`error: ${compactSingleLine(errorText, 260)}`);
  if (content && content.trim()) {
    const limit = status === "ERROR" || errorText ? 280 : 180;
    parts.push(compactSingleLine(content, limit));
  }
  return parts.length > 0 ? `${header} ${parts.join(" | ")}` : header;
}

/**
 * Safely reads only the tail of an AGY JSONL transcript file (strictly read-only)
 * and formats the most recent entries for quick Orchestrator Q&A.
 */
export function readRecentAgyTranscriptExcerpt(
  transcriptPath: string,
  options: {
    tailBytes?: number;
    maxEntries?: number;
    maxChars?: number;
  } = {},
): string | null {
  const tailBytes = options.tailBytes ?? DEFAULT_TRANSCRIPT_TAIL_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_TRANSCRIPT_MAX_ENTRIES;
  const maxChars = options.maxChars ?? DEFAULT_TRANSCRIPT_MAX_CHARS;

  let fd: number | null = null;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0) return null;

    const bytesToRead = Math.min(stat.size, tailBytes);
    const startOffset = Math.max(0, stat.size - bytesToRead);
    const buf = Buffer.allocUnsafe(bytesToRead);
    const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, startOffset);
    let chunk = buf.subarray(0, bytesRead).toString("utf8");

    // If we seeked into the middle of the file, drop the potentially truncated first line.
    if (startOffset > 0) {
      const firstNewline = chunk.indexOf("\n");
      if (firstNewline === -1) return null;
      chunk = chunk.slice(firstNewline + 1);
    }

    const formatted: string[] = [];
    for (const rawLine of chunk.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = asRecord(JSON.parse(line));
      } catch {
        continue;
      }
      if (!parsed) continue;
      const summary = formatTranscriptEntry(parsed);
      if (summary) formatted.push(summary);
    }

    if (formatted.length === 0) return null;

    const recent = formatted.slice(-maxEntries).join("\n");
    if (recent.length <= maxChars) return recent;
    return `...\n${recent.slice(-maxChars)}`;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore close errors
      }
    }
  }
}

export function buildCliSteerPrompt(options: {
  originalPrompt: string | null | undefined;
  steerPrompt: string;
  hasResumeSession: boolean;
}): string {
  const steer = options.steerPrompt.trim();
  if (options.hasResumeSession) {
    return [
      "[LIVE STEER / COURSE CORRECTION]",
      "Your previous turn was interrupted to apply updated guidance from the user. Preserve valid progress already made in this workspace and immediately apply the new direction below:",
      "",
      steer,
    ].join("\n");
  }

  const original = options.originalPrompt?.trim();
  if (original && original !== steer) {
    return [
      "[ORIGINAL TASK CONTEXT]",
      original,
      "",
      "[LIVE STEER / COURSE CORRECTION]",
      "The previous run was interrupted before a resumable session ID was recorded. Inspect the current workspace state (e.g. git status / git diff), preserve valid progress already made, and immediately apply the updated direction below:",
      "",
      steer,
    ].join("\n");
  }

  return [
    "[LIVE STEER / COURSE CORRECTION]",
    "Inspect the current workspace state, preserve valid progress already made, and apply the following instruction:",
    "",
    steer,
  ].join("\n");
}

export function buildCliFallbackFollowUpPrompt(options: {
  originalPrompt: string | null | undefined;
  followUpPrompt: string;
}): string {
  const followUp = options.followUpPrompt.trim();
  const original = options.originalPrompt?.trim();
  if (original && original !== followUp) {
    return [
      "[ORIGINAL TASK CONTEXT]",
      original,
      "",
      "[FOLLOW-UP / UPDATED INSTRUCTION]",
      "Continue in this workspace (inspect current files / git status so you preserve existing progress) and apply:",
      "",
      followUp,
    ].join("\n");
  }
  return followUp;
}
