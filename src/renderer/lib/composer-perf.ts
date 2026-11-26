import type { ActiveMentionQuery } from "../../shared/mentions.js";
import type { AgentTask } from "../../shared/types.js";

export const COMPOSER_TEXTAREA_MIN_HEIGHT = 44;
export const COMPOSER_TEXTAREA_MAX_HEIGHT = 160;

export type TextareaResizeAction = "skip" | "set_min" | "measure_grow" | "measure_full";

export interface TextareaResizePlanInput {
  nextText: string;
  prevText: string;
  currentHeight: number | null;
  clientWidth: number;
  prevClientWidth: number;
  minHeight?: number;
  maxHeight?: number;
}

function countLineBreaks(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/**
 * Decides the minimal DOM work needed to keep the chat composer textarea height
 * in sync without causing a forced synchronous reflow (`height = "auto"` -> `scrollHeight`)
 * on every single keystroke.
 */
export function planComposerTextareaResize({
  nextText,
  prevText,
  currentHeight,
  clientWidth,
  prevClientWidth,
  minHeight = COMPOSER_TEXTAREA_MIN_HEIGHT,
  maxHeight = COMPOSER_TEXTAREA_MAX_HEIGHT,
}: TextareaResizePlanInput): TextareaResizeAction {
  if (nextText.length === 0) {
    return currentHeight === minHeight ? "skip" : "set_min";
  }

  const widthChanged =
    prevClientWidth > 0 && clientWidth > 0 && Math.abs(clientWidth - prevClientWidth) >= 1;

  if (currentHeight === null || widthChanged) {
    return "measure_full";
  }

  const prevLines = countLineBreaks(prevText);
  const nextLines = countLineBreaks(nextText);
  const isPureGrowth =
    nextText.length >= prevText.length &&
    nextLines >= prevLines &&
    (prevText.length === 0 || nextText.startsWith(prevText));

  if (isPureGrowth) {
    // Already clamped at maxHeight and text only grew — height cannot change.
    if (currentHeight >= maxHeight) {
      return "skip";
    }
    // Text only grew: we can check `el.scrollHeight > currentHeight` without
    // resetting `style.height = "auto"` (avoids forced reflow on single-line typing).
    return "measure_grow";
  }

  // Text shrank or was edited mid-string: if already at minHeight and lines did not grow,
  // it cannot shrink further; check growth only when lines might have increased.
  if (currentHeight <= minHeight && nextLines <= prevLines && nextText.length <= prevText.length) {
    return "skip";
  }

  return "measure_full";
}

export function clampComposerTextareaHeight(
  scrollHeight: number,
  minHeight = COMPOSER_TEXTAREA_MIN_HEIGHT,
  maxHeight = COMPOSER_TEXTAREA_MAX_HEIGHT,
): number {
  return Math.min(maxHeight, Math.max(minHeight, Math.ceil(scrollHeight)));
}

/**
 * Structural equality for ActiveMentionQuery so cursor/keyup/select events that
 * stay inside the same `@query` (or outside any mention) never trigger redundant
 * React state updates or re-renders.
 */
export function areActiveMentionQueriesEqual(
  a: ActiveMentionQuery | null,
  b: ActiveMentionQuery | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.rawQuery === b.rawQuery &&
    a.mode === b.mode &&
    a.projectQuery === b.projectQuery &&
    a.taskQuery === b.taskQuery
  );
}

/**
 * Compares only the task metadata fields relevant to mention badges, inline
 * `@T#` highlights, and Questions sidebar relations. High-frequency background
 * worker updates (`activities`, `latestOutput`, `currentStep`, `updatedAt`) are
 * intentionally ignored so chat history messages do not re-render or re-parse
 * Markdown on every 50ms worker tick.
 */
export function areMentionTaskMetadataEqual(
  prev: readonly AgentTask[],
  next: readonly AgentTask[],
): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = next[i];
    if (a === b) continue;
    if (
      a.id !== b.id ||
      a.taskNumber !== b.taskNumber ||
      a.title !== b.title ||
      a.status !== b.status ||
      a.projectId !== b.projectId ||
      a.projectName !== b.projectName ||
      a.projectPath !== b.projectPath
    ) {
      return false;
    }
  }
  return true;
}

export function stabilizeMentionTasks(
  prev: AgentTask[],
  next: AgentTask[],
): AgentTask[] {
  return areMentionTaskMetadataEqual(prev, next) ? prev : next;
}

export const MENTION_POPOVER_INITIAL_LIMIT = 40;
export const MENTION_POPOVER_BATCH_SIZE = 40;

/**
 * Computes how many suggestions MentionPopover should mount into the DOM so
 * opening `@` with 100+ projects and tasks never freezes the main thread, while
 * guaranteeing the active keyboard-selected item is always rendered.
 */
export function computeMentionPopoverVisibleCount(
  totalCount: number,
  activeIndex: number,
  currentLimit: number,
  batchSize = MENTION_POPOVER_BATCH_SIZE,
): number {
  if (totalCount <= 0) return 0;
  const clampedActive = Math.max(0, Math.min(activeIndex, totalCount - 1));
  const minRequired = clampedActive + 1;
  let target = Math.max(currentLimit, minRequired);
  if (target > currentLimit && batchSize > 0) {
    target = Math.ceil(target / batchSize) * batchSize;
  }
  return Math.min(totalCount, target);
}
