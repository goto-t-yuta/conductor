import type { ChatMessageRole } from "../../shared/types.js";

/** Maximum distance from the bottom (in px) considered "at the bottom" of the chat. */
export const CHAT_BOTTOM_THRESHOLD_PX = 24;

/** Tolerance (in px) when matching a browser scroll event to a programmatic scrollTop write. */
export const PROGRAMMATIC_SCROLL_TOLERANCE_PX = 2;

/** Maximum lifetime (in ms) for a pending programmatic scroll marker. */
export const PROGRAMMATIC_SCROLL_EXPIRY_MS = 250;

/** Maximum lifetime (in ms) for an active smooth scroll-to-bottom animation. */
export const SMOOTH_SCROLL_EXPIRY_MS = 1200;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type ProgrammaticScrollKind = "bottom" | "smooth-bottom" | "jump";

export interface ProgrammaticScrollIntent {
  kind: ProgrammaticScrollKind;
  targetScrollTop: number;
  expiresAt: number;
}

export interface ChatScrollState {
  /** Whether tail updates should keep the chat pinned to the bottom. */
  isStickyBottom: boolean;
  /** Most recently observed container metrics for movement & pre-growth checks. */
  lastMetrics: ScrollMetrics | null;
  /** Pending programmatic scroll awaiting its asynchronous browser `scroll` event. */
  pendingProgrammatic: ProgrammaticScrollIntent | null;
}

export interface ScrollableToolChip {
  id: string;
  label: string;
  isCompleted: boolean;
  isError: boolean;
}

export interface ScrollableChatMessage {
  id: string;
  role: ChatMessageRole;
  text: string;
  reasoningSummary?: string;
  isStreaming: boolean;
  toolChips: readonly ScrollableToolChip[];
}

export type MessageUpdateKind =
  | "cleared"
  | "initial"
  | "user-sent"
  | "tail-appended"
  | "tail-updated"
  | "earlier-updated"
  | "unchanged";

export interface AutoScrollDecision {
  shouldScrollToBottom: boolean;
  nextState: ChatScrollState;
}

export function createInitialChatScrollState(): ChatScrollState {
  return {
    isStickyBottom: true,
    lastMetrics: null,
    pendingProgrammatic: null,
  };
}

export function getDistanceFromBottom(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

export function isAtChatBottom(
  metrics: ScrollMetrics,
  thresholdPx: number = CHAT_BOTTOM_THRESHOLD_PX,
): boolean {
  return getDistanceFromBottom(metrics) <= thresholdPx;
}

export function isContainerScrollable(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.clientHeight > 1;
}

function areToolChipsEqual(
  a: readonly ScrollableToolChip[],
  b: readonly ScrollableToolChip[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ca = a[i];
    const cb = b[i];
    if (
      ca.id !== cb.id ||
      ca.label !== cb.label ||
      ca.isCompleted !== cb.isCompleted ||
      ca.isError !== cb.isError
    ) {
      return false;
    }
  }
  return true;
}

function didMessageRenderChange(
  prev: ScrollableChatMessage,
  next: ScrollableChatMessage,
): boolean {
  return (
    prev.text !== next.text ||
    (prev.reasoningSummary ?? "") !== (next.reasoningSummary ?? "") ||
    prev.isStreaming !== next.isStreaming ||
    !areToolChipsEqual(prev.toolChips, next.toolChips)
  );
}

export function classifyMessagesUpdate(
  prevMessages: readonly ScrollableChatMessage[] | null,
  nextMessages: readonly ScrollableChatMessage[],
): MessageUpdateKind {
  if (nextMessages.length === 0) {
    return "cleared";
  }

  if (prevMessages === null) {
    return "initial";
  }

  const prevById = new Map<string, ScrollableChatMessage>();
  for (const msg of prevMessages) {
    prevById.set(msg.id, msg);
  }

  const addedMessages: ScrollableChatMessage[] = [];
  for (const msg of nextMessages) {
    if (!prevById.has(msg.id)) {
      addedMessages.push(msg);
    }
  }

  if (addedMessages.some((msg) => msg.role === "user")) {
    return "user-sent";
  }

  const nextLast = nextMessages[nextMessages.length - 1];
  if (!prevById.has(nextLast.id)) {
    return "tail-appended";
  }

  const prevMatchingLast = prevById.get(nextLast.id);
  if (prevMatchingLast && didMessageRenderChange(prevMatchingLast, nextLast)) {
    return "tail-updated";
  }

  if (addedMessages.length > 0 || prevMessages.length !== nextMessages.length) {
    return "earlier-updated";
  }

  for (let i = 0; i < nextMessages.length - 1; i += 1) {
    const nextMsg = nextMessages[i];
    const prevMsg = prevById.get(nextMsg.id);
    if (!prevMsg || didMessageRenderChange(prevMsg, nextMsg)) {
      return "earlier-updated";
    }
  }

  return "unchanged";
}

function getActivePending(
  pending: ProgrammaticScrollIntent | null,
  now: number,
): ProgrammaticScrollIntent | null {
  if (!pending) return null;
  return now <= pending.expiresAt ? pending : null;
}

/**
 * Handles an explicit user scroll gesture (wheel, touch drag, keyboard navigation)
 * before the asynchronous browser `scroll` event fires.
 */
export function handleUserScrollIntent(
  state: ChatScrollState,
  direction: "up" | "down",
  metrics: ScrollMetrics,
  thresholdPx: number = CHAT_BOTTOM_THRESHOLD_PX,
): ChatScrollState {
  if (direction === "up") {
    return {
      isStickyBottom: isContainerScrollable(metrics) ? false : state.isStickyBottom,
      lastMetrics: metrics,
      pendingProgrammatic: null,
    };
  }

  return {
    isStickyBottom: isAtChatBottom(metrics, thresholdPx) ? true : state.isStickyBottom,
    lastMetrics: metrics,
    pendingProgrammatic:
      state.pendingProgrammatic?.kind === "smooth-bottom" ? state.pendingProgrammatic : null,
  };
}

/**
 * Clears any pending programmatic scroll marker (e.g. when the user interacts directly
 * with the scrollbar track or thumb).
 */
export function clearPendingProgrammaticScroll(state: ChatScrollState): ChatScrollState {
  if (!state.pendingProgrammatic) return state;
  return {
    ...state,
    pendingProgrammatic: null,
  };
}

/**
 * Updates scroll-lock state on a browser `scroll` event, ignoring programmatic scroll
 * notifications that match our recent `scrollTop` write so jumps or mid-stream layout
 * changes cannot corrupt sticky-bottom state.
 */
export function handleContainerScroll(
  state: ChatScrollState,
  metrics: ScrollMetrics,
  now: number,
  thresholdPx: number = CHAT_BOTTOM_THRESHOLD_PX,
): ChatScrollState {
  const pending = getActivePending(state.pendingProgrammatic, now);
  const distance = getDistanceFromBottom(metrics);
  const prev = state.lastMetrics;
  const movedUp = prev !== null && metrics.scrollTop < prev.scrollTop - 0.5;
  const movedDown = prev !== null && metrics.scrollTop > prev.scrollTop + 0.5;
  const clampedAtBottomDueToShrink =
    prev !== null && metrics.scrollHeight < prev.scrollHeight && distance <= 1;

  if (pending?.kind === "smooth-bottom") {
    if (movedUp && !clampedAtBottomDueToShrink) {
      return {
        isStickyBottom: false,
        lastMetrics: metrics,
        pendingProgrammatic: null,
      };
    }

    if (distance <= thresholdPx) {
      return {
        isStickyBottom: true,
        lastMetrics: metrics,
        pendingProgrammatic: null,
      };
    }

    return {
      isStickyBottom: true,
      lastMetrics: metrics,
      pendingProgrammatic: {
        ...pending,
        targetScrollTop: Math.max(0, metrics.scrollHeight - metrics.clientHeight),
      },
    };
  }

  if (
    pending &&
    Math.abs(metrics.scrollTop - pending.targetScrollTop) <= PROGRAMMATIC_SCROLL_TOLERANCE_PX
  ) {
    return {
      isStickyBottom: state.isStickyBottom,
      lastMetrics: metrics,
      pendingProgrammatic: null,
    };
  }

  let nextSticky: boolean;
  if (movedUp && !clampedAtBottomDueToShrink) {
    nextSticky = false;
  } else if (state.isStickyBottom) {
    nextSticky = distance <= thresholdPx;
  } else {
    // Re-enable sticky-bottom only when scrolling downward into the bottom zone
    // (or when no prior metrics were recorded yet).
    nextSticky = (prev === null || movedDown) && distance <= thresholdPx;
  }

  return {
    isStickyBottom: nextSticky,
    lastMetrics: metrics,
    pendingProgrammatic: null,
  };
}

/**
 * Re-syncs scroll-lock state when DOM height/size changes without firing a `scroll` event
 * (e.g. images loading, reasoning panels expanding, or earlier messages growing).
 * Never silently re-enables sticky-bottom.
 */
export function syncScrollStateAfterResize(
  state: ChatScrollState,
  metrics: ScrollMetrics,
  now: number,
  thresholdPx: number = CHAT_BOTTOM_THRESHOLD_PX,
): ChatScrollState {
  const activePending = getActivePending(state.pendingProgrammatic, now);
  if (activePending?.kind === "smooth-bottom") {
    const arrived = isAtChatBottom(metrics, thresholdPx);
    return {
      isStickyBottom: true,
      lastMetrics: metrics,
      pendingProgrammatic: arrived
        ? null
        : {
            ...activePending,
            targetScrollTop: Math.max(0, metrics.scrollHeight - metrics.clientHeight),
          },
    };
  }

  const nextSticky = state.isStickyBottom ? isAtChatBottom(metrics, thresholdPx) : false;

  return {
    isStickyBottom: nextSticky,
    lastMetrics: metrics,
    pendingProgrammatic: activePending,
  };
}

/**
 * Records a user-triggered smooth scroll-to-bottom action (e.g. clicking the
 * floating Scroll-to-Bottom button). Re-enables `isStickyBottom` immediately
 * and tracks the in-flight animation so intermediate downward `scroll` events
 * do not prematurely disable sticky-bottom.
 */
export function recordSmoothScrollToBottom(
  _state: ChatScrollState,
  currentMetrics: ScrollMetrics,
  now: number,
  thresholdPx: number = CHAT_BOTTOM_THRESHOLD_PX,
): ChatScrollState {
  const targetScrollTop = Math.max(0, currentMetrics.scrollHeight - currentMetrics.clientHeight);
  const alreadyAtBottom = isAtChatBottom(currentMetrics, thresholdPx);
  return {
    isStickyBottom: true,
    lastMetrics: currentMetrics,
    pendingProgrammatic: alreadyAtBottom
      ? null
      : {
          kind: "smooth-bottom",
          targetScrollTop,
          expiresAt: now + SMOOTH_SCROLL_EXPIRY_MS,
        },
  };
}

/**
 * Returns true when the floating Scroll-to-Bottom button should be shown:
 * there are messages, the timeline overflows, the user is scrolled above the bottom
 * threshold, and we are not already scrolling programmatically to the bottom.
 */
export function shouldShowScrollToBottomButton(
  state: ChatScrollState,
  metrics: ScrollMetrics | null = state.lastMetrics,
  options?: {
    hasMessages?: boolean;
    now?: number;
    thresholdPx?: number;
  },
): boolean {
  if (options?.hasMessages === false) {
    return false;
  }
  const effectiveMetrics = metrics ?? state.lastMetrics;
  if (!effectiveMetrics || !isContainerScrollable(effectiveMetrics)) {
    return false;
  }
  const now = options?.now ?? Date.now();
  const thresholdPx = options?.thresholdPx ?? CHAT_BOTTOM_THRESHOLD_PX;
  const activePending = getActivePending(state.pendingProgrammatic, now);
  if (activePending?.kind === "bottom" || activePending?.kind === "smooth-bottom") {
    return false;
  }
  return !isAtChatBottom(effectiveMetrics, thresholdPx);
}

/**
 * Records the result of a synchronous programmatic `scrollTop` write (`"bottom"` or `"jump"`).
 */
export function recordProgrammaticScroll(
  _state: ChatScrollState,
  kind: ProgrammaticScrollKind,
  actualMetrics: ScrollMetrics,
  didScroll: boolean,
  now: number,
): ChatScrollState {
  return {
    isStickyBottom: kind === "bottom",
    lastMetrics: actualMetrics,
    pendingProgrammatic: didScroll
      ? {
          kind,
          targetScrollTop: actualMetrics.scrollTop,
          expiresAt: now + PROGRAMMATIC_SCROLL_EXPIRY_MS,
        }
      : null,
  };
}

/**
 * Decides whether a React message render should auto-scroll to the bottom.
 * Always verifies live scroll metrics against previous geometry so stale `isStickyBottom`
 * can never pull a non-bottom reader down.
 */
export function evaluateAutoScrollOnUpdate(
  state: ChatScrollState,
  params: {
    updateKind: MessageUpdateKind;
    currentMetrics: ScrollMetrics;
    now: number;
    thresholdPx?: number;
  },
): AutoScrollDecision {
  const { updateKind, currentMetrics, now } = params;
  const thresholdPx = params.thresholdPx ?? CHAT_BOTTOM_THRESHOLD_PX;
  const activePending = getActivePending(state.pendingProgrammatic, now);

  if (updateKind === "cleared") {
    return {
      shouldScrollToBottom: false,
      nextState: {
        isStickyBottom: true,
        lastMetrics: currentMetrics,
        pendingProgrammatic: null,
      },
    };
  }

  if (updateKind === "initial" || updateKind === "user-sent") {
    return {
      shouldScrollToBottom: true,
      nextState: {
        isStickyBottom: true,
        lastMetrics: currentMetrics,
        pendingProgrammatic: null,
      },
    };
  }

  if (updateKind === "earlier-updated" || updateKind === "unchanged") {
    if (activePending?.kind === "smooth-bottom") {
      return {
        shouldScrollToBottom: false,
        nextState: {
          isStickyBottom: true,
          lastMetrics: currentMetrics,
          pendingProgrammatic: isAtChatBottom(currentMetrics, thresholdPx)
            ? null
            : {
                ...activePending,
                targetScrollTop: Math.max(
                  0,
                  currentMetrics.scrollHeight - currentMetrics.clientHeight,
                ),
              },
        },
      };
    }

    return {
      shouldScrollToBottom: false,
      nextState: {
        isStickyBottom: state.isStickyBottom
          ? isAtChatBottom(currentMetrics, thresholdPx)
          : false,
        lastMetrics: currentMetrics,
        pendingProgrammatic: activePending,
      },
    };
  }

  // `tail-appended` or `tail-updated`
  if (!state.isStickyBottom) {
    return {
      shouldScrollToBottom: false,
      nextState: {
        isStickyBottom: false,
        lastMetrics: currentMetrics,
        pendingProgrammatic: activePending,
      },
    };
  }

  const prev = state.lastMetrics;
  if (prev !== null) {
    const currentDistance = getDistanceFromBottom(currentMetrics);
    const movedUpSinceLastCheck = currentMetrics.scrollTop < prev.scrollTop - 0.5;
    const clampedAtBottom =
      currentMetrics.scrollHeight < prev.scrollHeight && currentDistance <= 1;

    if (movedUpSinceLastCheck && !clampedAtBottom) {
      return {
        shouldScrollToBottom: false,
        nextState: {
          isStickyBottom: false,
          lastMetrics: currentMetrics,
          pendingProgrammatic: null,
        },
      };
    }

    if (activePending?.kind === "smooth-bottom") {
      return {
        shouldScrollToBottom: true,
        nextState: {
          isStickyBottom: true,
          lastMetrics: currentMetrics,
          pendingProgrammatic: null,
        },
      };
    }

    const preGrowthDistance = Math.max(
      0,
      prev.scrollHeight - currentMetrics.scrollTop - prev.clientHeight,
    );
    if (preGrowthDistance > thresholdPx) {
      return {
        shouldScrollToBottom: false,
        nextState: {
          isStickyBottom: false,
          lastMetrics: currentMetrics,
          pendingProgrammatic: activePending,
        },
      };
    }
  } else if (activePending?.kind === "smooth-bottom") {
    return {
      shouldScrollToBottom: true,
      nextState: {
        isStickyBottom: true,
        lastMetrics: currentMetrics,
        pendingProgrammatic: null,
      },
    };
  } else if (!isAtChatBottom(currentMetrics, thresholdPx)) {
    return {
      shouldScrollToBottom: false,
      nextState: {
        isStickyBottom: false,
        lastMetrics: currentMetrics,
        pendingProgrammatic: activePending,
      },
    };
  }

  return {
    shouldScrollToBottom: true,
    nextState: {
      isStickyBottom: true,
      lastMetrics: currentMetrics,
      pendingProgrammatic: null,
    },
  };
}

/**
 * Computes the direct `scrollTop` target to jump to a message inside the chat container
 * (centered when shorter than the viewport, top-aligned with breathing room when taller).
 */
export function computeJumpScrollTop(params: {
  containerScrollTop: number;
  containerClientHeight: number;
  containerScrollHeight: number;
  containerTop: number;
  targetTop: number;
  targetHeight: number;
  topPaddingPx?: number;
}): number {
  const {
    containerScrollTop,
    containerClientHeight,
    containerScrollHeight,
    containerTop,
    targetTop,
    targetHeight,
    topPaddingPx = 24,
  } = params;

  const elementOffsetTop = containerScrollTop + (targetTop - containerTop);
  const desiredTop =
    targetHeight < containerClientHeight
      ? elementOffsetTop - (containerClientHeight - targetHeight) / 2
      : elementOffsetTop - topPaddingPx;
  const maxScrollTop = Math.max(0, containerScrollHeight - containerClientHeight);
  return Math.min(maxScrollTop, Math.max(0, Math.round(desiredTop)));
}
