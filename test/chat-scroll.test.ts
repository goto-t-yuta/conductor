import { describe, expect, it } from "vitest";
import {
  CHAT_BOTTOM_THRESHOLD_PX,
  classifyMessagesUpdate,
  clearPendingProgrammaticScroll,
  computeJumpScrollTop,
  createInitialChatScrollState,
  evaluateAutoScrollOnUpdate,
  getDistanceFromBottom,
  handleContainerScroll,
  handleUserScrollIntent,
  isAtChatBottom,
  recordProgrammaticScroll,
  syncScrollStateAfterResize,
  type ScrollMetrics,
  type ScrollableChatMessage,
} from "../src/renderer/lib/chat-scroll.js";

function makeMsg(
  overrides: Partial<ScrollableChatMessage> & { id: string; role: ScrollableChatMessage["role"] },
): ScrollableChatMessage {
  return {
    text: "",
    isStreaming: false,
    toolChips: [],
    ...overrides,
  };
}

function metrics(scrollTop: number, scrollHeight: number, clientHeight = 600): ScrollMetrics {
  return { scrollTop, scrollHeight, clientHeight };
}

describe("bottom detection threshold", () => {
  it("treats distances <= 24px as at-bottom and rejects > 24px (including former < 100px zone)", () => {
    expect(CHAT_BOTTOM_THRESHOLD_PX).toBe(24);
    expect(getDistanceFromBottom(metrics(1400, 2000, 600))).toBe(0);
    expect(isAtChatBottom(metrics(1400, 2000, 600))).toBe(true);
    expect(isAtChatBottom(metrics(1376, 2000, 600))).toBe(true); // 24px
    expect(isAtChatBottom(metrics(1375, 2000, 600))).toBe(false); // 25px
    expect(isAtChatBottom(metrics(1320, 2000, 600))).toBe(false); // 80px (used to be true with < 100)
    expect(isAtChatBottom(metrics(1301, 2000, 600))).toBe(false); // 99px (used to be true with < 100)
  });

  it("treats non-overflowing containers as at-bottom", () => {
    expect(getDistanceFromBottom(metrics(0, 420, 600))).toBe(0);
    expect(isAtChatBottom(metrics(0, 420, 600))).toBe(true);
  });
});

describe("classifyMessagesUpdate", () => {
  it("distinguishes initial, cleared, user-sent, tail-appended, tail-updated, earlier-updated, and unchanged", () => {
    const u1 = makeMsg({ id: "u1", role: "user", text: "Q1" });
    const a1 = makeMsg({ id: "a1", role: "assistant", text: "A1", isStreaming: true });
    const u2 = makeMsg({ id: "u2", role: "user", text: "Q2" });
    const a2 = makeMsg({ id: "a2", role: "assistant", text: "A2", isStreaming: true });

    expect(classifyMessagesUpdate(null, [])).toBe("cleared");
    expect(classifyMessagesUpdate(null, [u1, a1])).toBe("initial");
    expect(classifyMessagesUpdate([u1, a1], [])).toBe("cleared");
    expect(classifyMessagesUpdate([u1, a1], [u1, a1])).toBe("unchanged");
    expect(classifyMessagesUpdate([u1, a1], [u1, a1, u2, a2])).toBe("user-sent");
    expect(
      classifyMessagesUpdate(
        [u1, a1],
        [u1, a1, makeMsg({ id: "te1", role: "taskEvent", text: "Task done" })],
      ),
    ).toBe("tail-appended");

    // Tail message text / toolChip / reasoning / streaming changes -> tail-updated
    expect(
      classifyMessagesUpdate([u1, a1, u2, a2], [u1, a1, u2, { ...a2, text: "A2 more" }]),
    ).toBe("tail-updated");
    expect(
      classifyMessagesUpdate([u1, a1, u2, a2], [u1, a1, u2, { ...a2, isStreaming: false }]),
    ).toBe("tail-updated");
    expect(
      classifyMessagesUpdate(
        [u1, a1, u2, a2],
        [
          u1,
          a1,
          u2,
          {
            ...a2,
            toolChips: [{ id: "c1", label: "Running tests", isCompleted: false, isError: false }],
          },
        ],
      ),
    ).toBe("tail-updated");

    // Parallel earlier reply updates while tail message stays unchanged -> earlier-updated
    expect(
      classifyMessagesUpdate([u1, a1, u2, a2], [u1, { ...a1, text: "A1 streaming..." }, u2, a2]),
    ).toBe("earlier-updated");
    expect(
      classifyMessagesUpdate([u1, a1, u2, a2], [u1, { ...a1, isStreaming: false }, u2, a2]),
    ).toBe("earlier-updated");
  });
});

describe("user scroll-up lock release & non-bottom protection", () => {
  it("immediately unlocks sticky-bottom on wheel/touch scroll-up even within 24px", () => {
    let state = recordProgrammaticScroll(
      createInitialChatScrollState(),
      "bottom",
      metrics(1400, 2000),
      true,
      100,
    );
    expect(state.isStickyBottom).toBe(true);

    // User wheels up slightly (still only 10px from bottom)
    state = handleUserScrollIntent(state, "up", metrics(1390, 2000));
    expect(state.isStickyBottom).toBe(false);
    expect(state.pendingProgrammatic).toBeNull();

    // Browser scroll event follows at 1390 (distance = 10px <= 24px, did not move down)
    state = handleContainerScroll(state, metrics(1390, 2000), 110);
    expect(state.isStickyBottom).toBe(false);

    // Incoming tail update must NOT pull user back down
    const decision = evaluateAutoScrollOnUpdate(state, {
      updateKind: "tail-updated",
      currentMetrics: metrics(1390, 2120),
      now: 120,
    });
    expect(decision.shouldScrollToBottom).toBe(false);
    expect(decision.nextState.isStickyBottom).toBe(false);

    // Scrolling back DOWN to the bottom re-enables sticky-bottom
    state = handleContainerScroll(decision.nextState, metrics(1520, 2120), 140);
    expect(state.isStickyBottom).toBe(true);
  });

  it("does not re-enable sticky-bottom when scrolling down while still > 24px above bottom", () => {
    let state = handleContainerScroll(
      createInitialChatScrollState(),
      metrics(400, 2000),
      100,
    );
    expect(state.isStickyBottom).toBe(false);

    // Scroll down to 40px from bottom (would have re-enabled with old < 100px threshold)
    state = handleContainerScroll(state, metrics(1360, 2000), 150);
    expect(state.isStickyBottom).toBe(false);

    // Tail arrival does NOT auto-scroll
    const decision = evaluateAutoScrollOnUpdate(state, {
      updateKind: "tail-appended",
      currentMetrics: metrics(1360, 2200),
      now: 160,
    });
    expect(decision.shouldScrollToBottom).toBe(false);

    // Scrolling all the way to <= 24px from bottom re-enables sticky-bottom
    state = handleContainerScroll(decision.nextState, metrics(1580, 2200), 200); // distance = 20px
    expect(state.isStickyBottom).toBe(true);

    const nextDecision = evaluateAutoScrollOnUpdate(state, {
      updateKind: "tail-updated",
      currentMetrics: metrics(1580, 2300),
      now: 220,
    });
    expect(nextDecision.shouldScrollToBottom).toBe(true);
  });

  it("keeps sticky-bottom enabled when scrollHeight shrinks at the exact bottom (clamped scrollTop)", () => {
    let state = recordProgrammaticScroll(
      createInitialChatScrollState(),
      "bottom",
      metrics(1400, 2000),
      false,
      100,
    );
    // Collapsing reasoning shrinks scrollHeight from 2000 -> 1800, clamping scrollTop 1400 -> 1200
    state = handleContainerScroll(state, metrics(1200, 1800), 150);
    expect(state.isStickyBottom).toBe(true);
  });
});

describe("jumpRequest programmatic scroll race protection", () => {
  it("keeps sticky-bottom disabled across programmatic jump scroll events and incoming replies", () => {
    // User starts at the bottom
    let state = recordProgrammaticScroll(
      createInitialChatScrollState(),
      "bottom",
      metrics(2400, 3000),
      false,
      100,
    );
    expect(state.isStickyBottom).toBe(true);

    // User clicks a question in sidebar -> jump to scrollTop = 300
    state = recordProgrammaticScroll(state, "jump", metrics(300, 3000), true, 200);
    expect(state.isStickyBottom).toBe(false);
    expect(state.pendingProgrammatic?.kind).toBe("jump");

    // Streaming reply arrives BEFORE the browser's queued scroll event fires
    const midStreamDecision = evaluateAutoScrollOnUpdate(state, {
      updateKind: "tail-updated",
      currentMetrics: metrics(300, 3120),
      now: 205,
    });
    expect(midStreamDecision.shouldScrollToBottom).toBe(false);
    expect(midStreamDecision.nextState.isStickyBottom).toBe(false);
    expect(midStreamDecision.nextState.pendingProgrammatic?.kind).toBe("jump");

    // Queued browser scroll event fires at 300
    state = handleContainerScroll(midStreamDecision.nextState, metrics(300, 3120), 210);
    expect(state.isStickyBottom).toBe(false);
    expect(state.pendingProgrammatic).toBeNull();

    // More replies stream below -> must stay at 300
    const nextDecision = evaluateAutoScrollOnUpdate(state, {
      updateKind: "tail-appended",
      currentMetrics: metrics(300, 3400),
      now: 250,
    });
    expect(nextDecision.shouldScrollToBottom).toBe(false);
  });

  it("does not falsely re-enable sticky-bottom even if a jump target lands near the bottom", () => {
    let state = recordProgrammaticScroll(
      createInitialChatScrollState(),
      "jump",
      metrics(1390, 2000), // 10px from bottom
      true,
      100,
    );
    expect(state.isStickyBottom).toBe(false);

    // Programmatic scroll event matching targetScrollTop = 1390 must NOT flip isStickyBottom to true
    state = handleContainerScroll(state, metrics(1390, 2000), 120);
    expect(state.isStickyBottom).toBe(false);
  });
});

describe("stale sticky-bottom & parallel reply edge cases", () => {
  it("prevents stale sticky-bottom when an earlier parallel reply grows above the bottom", () => {
    // Both a1 and a2 are initially visible at the bottom
    let state = recordProgrammaticScroll(
      createInitialChatScrollState(),
      "bottom",
      metrics(400, 1000),
      false,
      100,
    );

    // Earlier parallel reply a1 expands by 500px (pushing a2 below the fold; no scroll event fires)
    const earlierDecision = evaluateAutoScrollOnUpdate(state, {
      updateKind: "earlier-updated",
      currentMetrics: metrics(400, 1500),
      now: 200,
    });
    expect(earlierDecision.shouldScrollToBottom).toBe(false);
    expect(earlierDecision.nextState.isStickyBottom).toBe(false);

    // Now a2 below streams a chunk -> must NOT yank user down away from a1!
    const tailDecision = evaluateAutoScrollOnUpdate(earlierDecision.nextState, {
      updateKind: "tail-updated",
      currentMetrics: metrics(400, 1620),
      now: 220,
    });
    expect(tailDecision.shouldScrollToBottom).toBe(false);
    expect(tailDecision.nextState.isStickyBottom).toBe(false);
  });

  it("clears stale sticky-bottom via ResizeObserver when DOM grows without firing scroll", () => {
    let state = recordProgrammaticScroll(
      createInitialChatScrollState(),
      "bottom",
      metrics(1400, 2000),
      false,
      100,
    );

    // Image loads or user expands reasoning panel (+300px), no scroll event fired
    state = syncScrollStateAfterResize(state, metrics(1400, 2300), 150);
    expect(state.isStickyBottom).toBe(false);

    // Subsequent incoming reply must NOT auto-scroll
    const decision = evaluateAutoScrollOnUpdate(state, {
      updateKind: "tail-appended",
      currentMetrics: metrics(1400, 2450),
      now: 180,
    });
    expect(decision.shouldScrollToBottom).toBe(false);
  });

  it("detects user scrolling up in the same frame before onScroll fires", () => {
    // State still says sticky=true at scrollTop=1400
    const state = recordProgrammaticScroll(
      createInitialChatScrollState(),
      "bottom",
      metrics(1400, 2000),
      false,
      100,
    );

    // User scrolled up to 1320 before onScroll ran, and a streaming token expanded scrollHeight -> 2080
    const decision = evaluateAutoScrollOnUpdate(state, {
      updateKind: "tail-updated",
      currentMetrics: metrics(1320, 2080),
      now: 110,
    });
    expect(decision.shouldScrollToBottom).toBe(false);
    expect(decision.nextState.isStickyBottom).toBe(false);
  });

  it("preserves sticky-bottom during fast streaming when programmatic scroll event arrives after more height growth", () => {
    let state = recordProgrammaticScroll(
      createInitialChatScrollState(),
      "bottom",
      metrics(1400, 2000),
      true,
      100,
    );

    // Before the scroll event fires, another streaming token grows height to 2090 (distance = 90px)
    // Browser then delivers the queued scroll event from our programmatic write at scrollTop = 1400
    state = handleContainerScroll(state, metrics(1400, 2090), 115);
    expect(state.isStickyBottom).toBe(true);
    expect(state.pendingProgrammatic).toBeNull();
  });

  it("detects user scrollbar drag up even while a programmatic bottom scroll was pending", () => {
    let state = recordProgrammaticScroll(
      createInitialChatScrollState(),
      "bottom",
      metrics(1400, 2000),
      true,
      100,
    );

    state = clearPendingProgrammaticScroll(state);
    state = handleContainerScroll(state, metrics(1200, 2000), 120);
    expect(state.isStickyBottom).toBe(false);
  });
});

describe("sending a new user message and scrolling up while waiting", () => {
  it("scrolls to bottom on user-sent, but stops auto-scrolling if user scrolls up before reply arrives", () => {
    // User is scrolled up reading old messages
    let state = handleContainerScroll(
      createInitialChatScrollState(),
      metrics(200, 3000),
      100,
    );
    expect(state.isStickyBottom).toBe(false);

    // User sends a new message -> scroll to bottom once
    const sendDecision = evaluateAutoScrollOnUpdate(state, {
      updateKind: "user-sent",
      currentMetrics: metrics(200, 3100),
      now: 200,
    });
    expect(sendDecision.shouldScrollToBottom).toBe(true);

    // Container snaps directly to bottom (scrollTop = 2500)
    state = recordProgrammaticScroll(
      sendDecision.nextState,
      "bottom",
      metrics(2500, 3100),
      true,
      200,
    );
    expect(state.isStickyBottom).toBe(true);

    // While waiting for the reply, user scrolls UP to read an earlier reply
    state = handleUserScrollIntent(state, "up", metrics(2480, 3100));
    state = handleContainerScroll(state, metrics(900, 3100), 260);
    expect(state.isStickyBottom).toBe(false);

    // Reply starts streaming and then finishes -> must NOT pull user back down!
    const streamDecision = evaluateAutoScrollOnUpdate(state, {
      updateKind: "tail-updated",
      currentMetrics: metrics(900, 3400),
      now: 500,
    });
    expect(streamDecision.shouldScrollToBottom).toBe(false);
    expect(streamDecision.nextState.isStickyBottom).toBe(false);

    const finishDecision = evaluateAutoScrollOnUpdate(streamDecision.nextState, {
      updateKind: "tail-updated",
      currentMetrics: metrics(900, 3600),
      now: 900,
    });
    expect(finishDecision.shouldScrollToBottom).toBe(false);
  });

  it("resets sticky-bottom to true when chat is cleared", () => {
    let state = handleContainerScroll(
      createInitialChatScrollState(),
      metrics(200, 3000),
      100,
    );
    expect(state.isStickyBottom).toBe(false);

    const cleared = evaluateAutoScrollOnUpdate(state, {
      updateKind: "cleared",
      currentMetrics: metrics(0, 600),
      now: 200,
    });
    expect(cleared.shouldScrollToBottom).toBe(false);
    expect(cleared.nextState.isStickyBottom).toBe(true);
  });
});

describe("computeJumpScrollTop", () => {
  it("centers short messages and top-aligns tall messages within [0, maxScrollTop]", () => {
    // Short message (100px) at offset 800 inside 600px viewport -> centered at 800 - 250 = 550
    expect(
      computeJumpScrollTop({
        containerScrollTop: 1400,
        containerClientHeight: 600,
        containerScrollHeight: 2000,
        containerTop: 100,
        targetTop: -500, // elementOffsetTop = 1400 + (-500 - 100) = 800
        targetHeight: 100,
      }),
    ).toBe(550);

    // Tall message (900px > 600px viewport) at offset 800 -> top-aligned with 24px padding = 776
    expect(
      computeJumpScrollTop({
        containerScrollTop: 1400,
        containerClientHeight: 600,
        containerScrollHeight: 2400,
        containerTop: 100,
        targetTop: -500,
        targetHeight: 900,
      }),
    ).toBe(776);

    // Clamps to [0, maxScrollTop]
    expect(
      computeJumpScrollTop({
        containerScrollTop: 0,
        containerClientHeight: 600,
        containerScrollHeight: 2000,
        containerTop: 0,
        targetTop: 10,
        targetHeight: 100,
      }),
    ).toBe(0);

    expect(
      computeJumpScrollTop({
        containerScrollTop: 0,
        containerClientHeight: 600,
        containerScrollHeight: 2000,
        containerTop: 0,
        targetTop: 1950,
        targetHeight: 100,
      }),
    ).toBe(1400);
  });
});
