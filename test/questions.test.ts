import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolActivityChip } from "../src/shared/types.js";
import {
  deriveQuestionItems,
  formatQuestionTime,
  getLatestToolActivity,
  isAssistantReplyError,
  isWorkerActionToolChip,
  isWorkerDispatchReply,
  reconcileUnreadReplies,
  stripMarkdownForPreview,
  summarizeQuestions,
} from "../src/renderer/lib/questions.js";

function makeMessage(
  overrides: Partial<ChatMessage> & { id: string; role: ChatMessage["role"] },
): ChatMessage {
  return {
    text: "",
    attachments: [],
    toolChips: [],
    isStreaming: false,
    createdAt: "2026-11-26T00:00:00.000Z",
    ...overrides,
  };
}

function makeChip(overrides: Partial<ToolActivityChip> & { id: string; label: string }): ToolActivityChip {
  return {
    detail: null,
    isCompleted: false,
    isError: false,
    ...overrides,
  };
}

describe("deriveQuestionItems — pairing, status, and ordering", () => {
  it("pairs user messages with assistant replies via replyToMessageId and ignores taskEvent/system messages", () => {
    const messages: ChatMessage[] = [
      makeMessage({
        id: "u1",
        role: "user",
        text: "ビルドエラーの原因を教えて",
        createdAt: "2026-11-26T01:00:00.000Z",
      }),
      makeMessage({
        id: "te1",
        role: "taskEvent",
        text: "Task T1 completed",
        createdAt: "2026-11-26T01:00:02.000Z",
      }),
      makeMessage({
        id: "a1",
        role: "assistant",
        provider: "codex",
        replyToMessageId: "u1",
        text: "## 原因\n\n`tsconfig.json` のパス設定に誤りがあります。",
        isStreaming: false,
        createdAt: "2026-11-26T01:00:05.000Z",
      }),
      makeMessage({
        id: "sys1",
        role: "system",
        text: "System notice",
        createdAt: "2026-11-26T01:00:06.000Z",
      }),
    ];

    const items = deriveQuestionItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "u1",
      userMessageId: "u1",
      replyMessageId: "a1",
      targetMessageId: "a1",
      questionSnippet: "ビルドエラーの原因を教えて",
      status: "completed",
      isUnread: false,
      provider: "codex",
      replyPreview: "原因 tsconfig.json のパス設定に誤りがあります。",
      detailLine: "原因 tsconfig.json のパス設定に誤りがあります。",
    });
  });

  it("orders streaming (active) first, then unread completed, then read history (newest first within each tier)", () => {
    const messages: ChatMessage[] = [
      // Q1: oldest, completed, UNREAD (off-screen reply that just finished)
      makeMessage({
        id: "u1",
        role: "user",
        text: "Q1: 最初の重い調査",
        createdAt: "2026-11-26T01:00:00.000Z",
      }),
      makeMessage({
        id: "a1",
        role: "assistant",
        replyToMessageId: "u1",
        text: "Q1 の調査結果です",
        isStreaming: false,
        createdAt: "2026-11-26T01:05:00.000Z",
      }),
      // Q2: streaming (earlier active)
      makeMessage({
        id: "u2",
        role: "user",
        text: "Q2: 並列実行中の質問A",
        createdAt: "2026-11-26T01:01:00.000Z",
      }),
      makeMessage({
        id: "a2",
        role: "assistant",
        replyToMessageId: "u2",
        text: "",
        toolChips: [makeChip({ id: "c1", label: "タスク一覧を確認", isCompleted: false })],
        isStreaming: true,
        createdAt: "2026-11-26T01:01:01.000Z",
      }),
      // Q3: completed & read (newer than Q1)
      makeMessage({
        id: "u3",
        role: "user",
        text: "Q3: すぐ終わった質問",
        createdAt: "2026-11-26T01:02:00.000Z",
      }),
      makeMessage({
        id: "a3",
        role: "assistant",
        replyToMessageId: "u3",
        text: "すぐ回答しました",
        isStreaming: false,
        createdAt: "2026-11-26T01:02:02.000Z",
      }),
      // Q4: streaming (newest active)
      makeMessage({
        id: "u4",
        role: "user",
        text: "Q4: 並列実行中の質問B",
        createdAt: "2026-11-26T01:03:00.000Z",
      }),
      makeMessage({
        id: "a4",
        role: "assistant",
        replyToMessageId: "u4",
        text: "",
        isStreaming: true,
        createdAt: "2026-11-26T01:03:01.000Z",
      }),
      // Q5: newest completed & read
      makeMessage({
        id: "u5",
        role: "user",
        text: "Q5: 最新の既読質問",
        createdAt: "2026-11-26T01:04:00.000Z",
      }),
      makeMessage({
        id: "a5",
        role: "assistant",
        replyToMessageId: "u5",
        text: "最新回答",
        isStreaming: false,
        createdAt: "2026-11-26T01:04:01.000Z",
      }),
    ];

    const items = deriveQuestionItems(messages, new Set(["a1", "a4"]));
    // Streaming items (a4 shouldn't be unread while streaming), then unread completed (a1), then read newest-first (u5, u3)
    expect(items.map((item) => item.id)).toEqual(["u4", "u2", "u1", "u5", "u3"]);
    expect(items[0]?.isUnread).toBe(false);
    expect(items[2]?.isUnread).toBe(true);

    const summary = summarizeQuestions(items);
    expect(summary).toEqual({
      totalCount: 5,
      activeCount: 2,
      unreadCount: 1,
    });
  });

  it("falls back to userMessageId when no assistant reply exists yet", () => {
    const messages: ChatMessage[] = [
      makeMessage({
        id: "u-only",
        role: "user",
        text: "返信がまだない質問",
        createdAt: "2026-11-26T02:00:00.000Z",
      }),
    ];

    const items = deriveQuestionItems(messages);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "u-only",
      userMessageId: "u-only",
      replyMessageId: null,
      targetMessageId: "u-only",
      status: "pending",
      isUnread: false,
      detailLine: "応答待機中…",
    });
  });

  it("pairs legacy unlinked assistant replies and retains orphan replies with replyToSnippet", () => {
    const messages: ChatMessage[] = [
      makeMessage({
        id: "u-legacy",
        role: "user",
        text: "旧形式の質問",
        createdAt: "2026-11-26T02:00:00.000Z",
      }),
      makeMessage({
        id: "a-legacy",
        role: "assistant",
        text: "旧形式の回答",
        createdAt: "2026-11-26T02:00:05.000Z",
      }),
      makeMessage({
        id: "a-orphan",
        role: "assistant",
        replyToMessageId: "missing-u",
        replyToSnippet: "履歴から消えた質問のスニペット",
        text: "回答のみ残っている",
        createdAt: "2026-11-26T02:01:00.000Z",
      }),
    ];

    const items = deriveQuestionItems(messages);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: "a-orphan",
      userMessageId: "missing-u",
      replyMessageId: "a-orphan",
      targetMessageId: "a-orphan",
      questionSnippet: "履歴から消えた質問のスニペット",
    });
    expect(items[1]).toMatchObject({
      id: "u-legacy",
      replyMessageId: "a-legacy",
      targetMessageId: "a-legacy",
    });
  });

  it("shows latest running tool chip while streaming, falling back to streaming text or reasoning", () => {
    const messages: ChatMessage[] = [
      makeMessage({
        id: "u-tool",
        role: "user",
        text: "ブラウザ確認して",
        createdAt: "2026-11-26T03:00:00.000Z",
      }),
      makeMessage({
        id: "a-tool",
        role: "assistant",
        replyToMessageId: "u-tool",
        isStreaming: true,
        toolChips: [
          makeChip({ id: "t1", label: "ブラウザを開く", isCompleted: true }),
          makeChip({ id: "t2", label: "画面スナップショット取得", isCompleted: false }),
        ],
        createdAt: "2026-11-26T03:00:01.000Z",
      }),
      makeMessage({
        id: "u-reason",
        role: "user",
        text: "設計を考えて",
        createdAt: "2026-11-26T03:01:00.000Z",
      }),
      makeMessage({
        id: "a-reason",
        role: "assistant",
        replyToMessageId: "u-reason",
        isStreaming: true,
        reasoningSummary: "Comparing architecture tradeoffs...",
        createdAt: "2026-11-26T03:01:01.000Z",
      }),
    ];

    const items = deriveQuestionItems(messages);
    const toolItem = items.find((i) => i.id === "u-tool");
    const reasonItem = items.find((i) => i.id === "u-reason");

    expect(toolItem?.latestToolLabel).toBe("画面スナップショット取得");
    expect(toolItem?.hasRunningTool).toBe(true);
    expect(toolItem?.detailLine).toBe("画面スナップショット取得…");
    expect(reasonItem?.detailLine).toBe("思考中…");
  });

  it("accurately classifies error replies vs recovered replies", () => {
    const cliError = makeMessage({
      id: "e1",
      role: "assistant",
      text: "エラーが発生しました: timeout",
      isStreaming: false,
    });
    const appendedError = makeMessage({
      id: "e2",
      role: "assistant",
      text: "途中まで応答\n\nエラー: process exited",
      isStreaming: false,
    });
    const allToolsFailed = makeMessage({
      id: "e3",
      role: "assistant",
      text: "操作を完了しました。",
      toolChips: [makeChip({ id: "c1", label: "$ pnpm test", isCompleted: true, isError: true })],
      isStreaming: false,
    });
    const recoveredReply = makeMessage({
      id: "ok1",
      role: "assistant",
      text: "リトライして修正が完了しました。",
      toolChips: [
        makeChip({ id: "c1", label: "$ pnpm test", isCompleted: true, isError: true }),
        makeChip({ id: "c2", label: "$ pnpm test", isCompleted: true, isError: false }),
      ],
      isStreaming: false,
    });
    const streamingWithErrorChip = makeMessage({
      id: "s1",
      role: "assistant",
      text: "",
      toolChips: [makeChip({ id: "c1", label: "$ pnpm test", isCompleted: true, isError: true })],
      isStreaming: true,
    });

    expect(isAssistantReplyError(cliError)).toBe(true);
    expect(isAssistantReplyError(appendedError)).toBe(true);
    expect(isAssistantReplyError(allToolsFailed)).toBe(true);
    expect(isAssistantReplyError(recoveredReply)).toBe(false);
    expect(isAssistantReplyError(streamingWithErrorChip)).toBe(false);
  });
});

describe("reconcileUnreadReplies — off-screen completion tracking", () => {
  it("does not mark historical completed messages on initial load as unread", () => {
    const messages: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", text: "Old question" }),
      makeMessage({ id: "a1", role: "assistant", replyToMessageId: "u1", text: "Old answer", isStreaming: false }),
    ];

    const res = reconcileUnreadReplies({
      messages,
      prevStreamingIds: new Set(),
      prevUnreadIds: new Set(),
      isMessageVisible: () => false,
    });

    expect(res.newlyCompletedIds).toEqual([]);
    expect([...res.nextUnreadIds]).toEqual([]);
    expect([...res.nextStreamingIds]).toEqual([]);
  });

  it("marks only off-screen streaming->completed transitions as unread", () => {
    const streamingMsgs: ChatMessage[] = [
      makeMessage({ id: "u1", role: "user", text: "Q1" }),
      makeMessage({ id: "a1", role: "assistant", replyToMessageId: "u1", isStreaming: true }),
      makeMessage({ id: "u2", role: "user", text: "Q2" }),
      makeMessage({ id: "a2", role: "assistant", replyToMessageId: "u2", isStreaming: true }),
    ];

    const step1 = reconcileUnreadReplies({
      messages: streamingMsgs,
      prevStreamingIds: new Set(),
      prevUnreadIds: new Set(),
      isMessageVisible: () => true,
    });
    expect([...step1.nextStreamingIds]).toEqual(["a1", "a2"]);
    expect([...step1.nextUnreadIds]).toEqual([]);

    // Both finish; a1 is off-screen, a2 is visible in viewport
    const completedMsgs = streamingMsgs.map((m) =>
      m.role === "assistant" ? { ...m, isStreaming: false, text: `Reply ${m.id}` } : m,
    );

    const step2 = reconcileUnreadReplies({
      messages: completedMsgs,
      prevStreamingIds: step1.nextStreamingIds,
      prevUnreadIds: step1.nextUnreadIds,
      isMessageVisible: (id) => id === "a2",
    });

    expect(step2.newlyCompletedIds).toEqual(["a1", "a2"]);
    expect([...step2.nextUnreadIds]).toEqual(["a1"]);
    expect([...step2.nextStreamingIds]).toEqual([]);

    // Fresh chat clears all unread and streaming state
    const step3 = reconcileUnreadReplies({
      messages: [],
      prevStreamingIds: step2.nextStreamingIds,
      prevUnreadIds: step2.nextUnreadIds,
      isMessageVisible: () => false,
    });
    expect([...step3.nextUnreadIds]).toEqual([]);
    expect([...step3.nextStreamingIds]).toEqual([]);
  });
});

describe("helper utilities", () => {
  it("strips markdown syntax for compact previews and formats timestamps safely", () => {
    expect(stripMarkdownForPreview("### **完了**\n- [PR #12](https://example.com) を確認")).toBe(
      "完了 PR #12 を確認",
    );
    expect(formatQuestionTime("invalid-date")).toBe("");
    expect(formatQuestionTime("2026-11-26T00:05:00.000Z")).toMatch(/^\d{2}:\d{2}$/);
    expect(getLatestToolActivity([])).toBeNull();
  });
});

describe("worker-dispatch filtering in Questions", () => {
  it("identifies worker/task action chips by canonical toolName, prefixed names, and localized labels", () => {
    // Canonical bare toolName (even if localized label changes in future)
    expect(
      isWorkerActionToolChip(makeChip({ id: "1", toolName: "start_worker", label: "Launching..." })),
    ).toBe(true);
    expect(
      isWorkerActionToolChip(makeChip({ id: "2", toolName: "send_to_worker", label: "Steering..." })),
    ).toBe(true);
    expect(
      isWorkerActionToolChip(makeChip({ id: "3", toolName: "create_task", label: "Queuing..." })),
    ).toBe(true);
    expect(
      isWorkerActionToolChip(makeChip({ id: "4", toolName: "stop_worker", label: "Halting..." })),
    ).toBe(true);

    // MCP / namespaced / suffix tool names
    expect(
      isWorkerActionToolChip(
        makeChip({ id: "5", toolName: "mcp_conductor_start_worker", label: "Custom" }),
      ),
    ).toBe(true);
    expect(
      isWorkerActionToolChip(
        makeChip({ id: "6", toolName: "mcp__conductor__send_to_worker", label: "Custom" }),
      ),
    ).toBe(true);
    expect(
      isWorkerActionToolChip(
        makeChip({ id: "7", toolName: "conductor:create_task", label: "Custom" }),
      ),
    ).toBe(true);
    expect(
      isWorkerActionToolChip(
        makeChip({ id: "8", toolName: "conductor.stop_worker", label: "Custom" }),
      ),
    ).toBe(true);

    // Legacy persisted Japanese labels without toolName
    expect(isWorkerActionToolChip(makeChip({ id: "9", label: "ワーカーを起動" }))).toBe(true);
    expect(isWorkerActionToolChip(makeChip({ id: "10", label: "ワーカーへ追加指示" }))).toBe(true);
    expect(isWorkerActionToolChip(makeChip({ id: "11", label: "タスクを作成" }))).toBe(true);
    expect(isWorkerActionToolChip(makeChip({ id: "12", label: "ワーカーを停止" }))).toBe(true);

    // English labels (case-insensitive) without toolName
    expect(isWorkerActionToolChip(makeChip({ id: "13", label: "Start worker" }))).toBe(true);
    expect(isWorkerActionToolChip(makeChip({ id: "14", label: "send to worker" }))).toBe(true);
    expect(isWorkerActionToolChip(makeChip({ id: "15", label: "CREATE TASK" }))).toBe(true);
    expect(isWorkerActionToolChip(makeChip({ id: "16", label: "Stop Worker" }))).toBe(true);

    // Raw tool name in label without toolName
    expect(isWorkerActionToolChip(makeChip({ id: "17", label: "mcp_conductor_start_worker" }))).toBe(
      true,
    );

    // Non-worker / read-only tools and shell commands must NOT match
    const nonWorkerChips: ToolActivityChip[] = [
      makeChip({ id: "r1", toolName: "get_task_detail", label: "タスク詳細を取得" }),
      makeChip({ id: "r2", toolName: "list_tasks", label: "タスク一覧を確認" }),
      makeChip({ id: "r3", toolName: "list_projects", label: "プロジェクト一覧を確認" }),
      makeChip({ id: "r4", toolName: "search_projects", label: "プロジェクトを検索" }),
      makeChip({ id: "r5", toolName: "browser_snapshot", label: "画面スナップショット取得" }),
      makeChip({ id: "r6", toolName: "browser_console_errors", label: "コンソール/通信エラー確認" }),
      makeChip({ id: "r7", toolName: "read_file", label: "read_file" }),
      makeChip({ id: "r8", toolName: "commandExecution", label: "$ node scripts/start_worker" }),
    ];
    for (const chip of nonWorkerChips) {
      expect(isWorkerActionToolChip(chip)).toBe(false);
    }
  });

  it("keeps pure Q&A turns (no tools and read-only tools) in Questions while excluding worker-dispatch turns", () => {
    const messages: ChatMessage[] = [
      // Pure Q&A with no tools -> KEEP
      makeMessage({
        id: "u-qa-plain",
        role: "user",
        text: "TypeScript の satisfies 演算子って何？",
        createdAt: "2026-11-26T04:00:00.000Z",
      }),
      makeMessage({
        id: "a-qa-plain",
        role: "assistant",
        replyToMessageId: "u-qa-plain",
        text: "型チェックしつつ推論型を保つ演算子です。",
        createdAt: "2026-11-26T04:00:02.000Z",
      }),
      // Read-only tools (get_task_detail, list_tasks, browser_snapshot) -> KEEP
      makeMessage({
        id: "u-qa-readonly",
        role: "user",
        text: "T12 の進捗とブラウザ画面を確認して",
        createdAt: "2026-11-26T04:01:00.000Z",
      }),
      makeMessage({
        id: "a-qa-readonly",
        role: "assistant",
        replyToMessageId: "u-qa-readonly",
        text: "T12 はテスト実行中で、画面にエラーはありません。",
        toolChips: [
          makeChip({ id: "ro1", toolName: "list_tasks", label: "タスク一覧を確認", isCompleted: true }),
          makeChip({ id: "ro2", toolName: "get_task_detail", label: "タスク詳細を取得", isCompleted: true }),
          makeChip({ id: "ro3", toolName: "browser_snapshot", label: "画面スナップショット取得", isCompleted: true }),
        ],
        createdAt: "2026-11-26T04:01:05.000Z",
      }),
      // start_worker via canonical toolName (with preceding read-only tool) -> EXCLUDE
      makeMessage({
        id: "u-start",
        role: "user",
        text: "ダークモード修正して",
        createdAt: "2026-11-26T04:02:00.000Z",
      }),
      makeMessage({
        id: "a-start",
        role: "assistant",
        replyToMessageId: "u-start",
        text: "ワーカーを起動しました。",
        toolChips: [
          makeChip({ id: "sw0", toolName: "list_projects", label: "プロジェクト一覧を確認", isCompleted: true }),
          makeChip({ id: "sw1", toolName: "start_worker", label: "Start worker", isCompleted: true }),
        ],
        createdAt: "2026-11-26T04:02:04.000Z",
      }),
      // send_to_worker via MCP-prefixed toolName -> EXCLUDE
      makeMessage({
        id: "u-send",
        role: "user",
        text: "@T1 テストも追加して",
        createdAt: "2026-11-26T04:03:00.000Z",
      }),
      makeMessage({
        id: "a-send",
        role: "assistant",
        replyToMessageId: "u-send",
        text: "追加指示を送りました。",
        toolChips: [
          makeChip({
            id: "stw1",
            toolName: "mcp_conductor_send_to_worker",
            label: "ワーカーへ追加指示",
            isCompleted: true,
          }),
        ],
        createdAt: "2026-11-26T04:03:03.000Z",
      }),
      // create_task via conductor: prefix -> EXCLUDE
      makeMessage({
        id: "u-create",
        role: "user",
        text: "リファクタリングをキューに入れといて",
        createdAt: "2026-11-26T04:04:00.000Z",
      }),
      makeMessage({
        id: "a-create",
        role: "assistant",
        replyToMessageId: "u-create",
        text: "タスクを作成しました。",
        toolChips: [
          makeChip({
            id: "ct1",
            toolName: "conductor:create_task",
            label: "Create task",
            isCompleted: true,
          }),
        ],
        createdAt: "2026-11-26T04:04:03.000Z",
      }),
      // stop_worker via legacy persisted Japanese label (no toolName) -> EXCLUDE
      makeMessage({
        id: "u-stop",
        role: "user",
        text: "T1 を止めて",
        createdAt: "2026-11-26T04:05:00.000Z",
      }),
      makeMessage({
        id: "a-stop",
        role: "assistant",
        replyToMessageId: "u-stop",
        text: "ワーカーを停止しました。",
        toolChips: [makeChip({ id: "st1", label: "ワーカーを停止", isCompleted: true })],
        createdAt: "2026-11-26T04:05:03.000Z",
      }),
      // Legacy persisted Japanese start_worker label (no toolName) -> EXCLUDE
      makeMessage({
        id: "u-legacy-start",
        role: "user",
        text: "バグ修正をお願い",
        createdAt: "2026-11-26T04:06:00.000Z",
      }),
      makeMessage({
        id: "a-legacy-start",
        role: "assistant",
        replyToMessageId: "u-legacy-start",
        text: "バックグラウンドで起動しました。",
        toolChips: [makeChip({ id: "ls1", label: "ワーカーを起動", isCompleted: true })],
        createdAt: "2026-11-26T04:06:03.000Z",
      }),
      // Orphan worker-dispatch reply -> EXCLUDE
      makeMessage({
        id: "a-orphan-worker",
        role: "assistant",
        replyToMessageId: "missing-user",
        replyToSnippet: "消えたメッセージの依頼",
        text: "起動しました",
        toolChips: [makeChip({ id: "ow1", label: "ワーカーを起動", isCompleted: true })],
        createdAt: "2026-11-26T04:07:00.000Z",
      }),
    ];

    const items = deriveQuestionItems(messages);
    expect(items.map((item) => item.id)).toEqual(["u-qa-readonly", "u-qa-plain"]);
    expect(summarizeQuestions(items)).toEqual({
      totalCount: 2,
      activeCount: 0,
      unreadCount: 0,
    });
  });

  it("shows a streaming turn in Questions until start_worker is invoked, then immediately drops it and never lingers", () => {
    const userMsg = makeMessage({
      id: "u-stream",
      role: "user",
      text: "ログイン画面のバグを直して",
      createdAt: "2026-11-26T05:00:00.000Z",
    });

    // Step 1: Streaming with no tool calls yet -> visible in Questions
    const streamingInitial: ChatMessage[] = [
      userMsg,
      makeMessage({
        id: "a-stream",
        role: "assistant",
        replyToMessageId: "u-stream",
        isStreaming: true,
        toolChips: [],
        createdAt: "2026-11-26T05:00:01.000Z",
      }),
    ];
    expect(deriveQuestionItems(streamingInitial).map((i) => i.id)).toEqual(["u-stream"]);
    expect(deriveQuestionItems(streamingInitial)[0]?.status).toBe("streaming");

    // Step 2: Streaming invokes start_worker -> immediately drops out of Questions
    const streamingWithWorker: ChatMessage[] = [
      userMsg,
      makeMessage({
        id: "a-stream",
        role: "assistant",
        replyToMessageId: "u-stream",
        isStreaming: true,
        toolChips: [
          makeChip({
            id: "c-sw",
            toolName: "start_worker",
            label: "ワーカーを起動",
            isCompleted: false,
            isError: false,
          }),
        ],
        createdAt: "2026-11-26T05:00:01.000Z",
      }),
    ];
    expect(deriveQuestionItems(streamingWithWorker)).toEqual([]);

    // Step 3: Turn finishes -> still excluded and never lingers
    const completedWithWorker: ChatMessage[] = [
      userMsg,
      makeMessage({
        id: "a-stream",
        role: "assistant",
        replyToMessageId: "u-stream",
        isStreaming: false,
        text: "ワーカーを起動しました。",
        toolChips: [
          makeChip({
            id: "c-sw",
            toolName: "start_worker",
            label: "ワーカーを起動",
            isCompleted: true,
            isError: false,
          }),
        ],
        createdAt: "2026-11-26T05:00:01.000Z",
      }),
    ];
    expect(deriveQuestionItems(completedWithWorker)).toEqual([]);
  });

  it("keeps failed worker-dispatch turns visible in Questions when all worker chips errored and reply ended in error", () => {
    const messages: ChatMessage[] = [
      // Failed start_worker (only tool chip errored) -> KEEP as error
      makeMessage({
        id: "u-fail-1",
        role: "user",
        text: "存在しないプロジェクトで修正して",
        createdAt: "2026-11-26T06:00:00.000Z",
      }),
      makeMessage({
        id: "a-fail-1",
        role: "assistant",
        replyToMessageId: "u-fail-1",
        text: "ワーカーの起動に失敗しました。",
        isStreaming: false,
        toolChips: [
          makeChip({
            id: "f1",
            toolName: "start_worker",
            label: "ワーカーを起動",
            isCompleted: true,
            isError: true,
          }),
        ],
        createdAt: "2026-11-26T06:00:02.000Z",
      }),
      // Read-only succeeded, start_worker errored, and reply text reports error -> KEEP as error
      makeMessage({
        id: "u-fail-2",
        role: "user",
        text: "別のプロジェクトで修正して",
        createdAt: "2026-11-26T06:01:00.000Z",
      }),
      makeMessage({
        id: "a-fail-2",
        role: "assistant",
        replyToMessageId: "u-fail-2",
        text: "エラー: プロジェクトが見つかりませんでした。",
        isStreaming: false,
        toolChips: [
          makeChip({
            id: "f2-list",
            toolName: "list_projects",
            label: "プロジェクト一覧を確認",
            isCompleted: true,
            isError: false,
          }),
          makeChip({
            id: "f2-sw",
            toolName: "start_worker",
            label: "ワーカーを起動",
            isCompleted: true,
            isError: true,
          }),
        ],
        createdAt: "2026-11-26T06:01:02.000Z",
      }),
      // First start_worker errored, retry succeeded -> EXCLUDE
      makeMessage({
        id: "u-recovered",
        role: "user",
        text: "リトライして起動して",
        createdAt: "2026-11-26T06:02:00.000Z",
      }),
      makeMessage({
        id: "a-recovered",
        role: "assistant",
        replyToMessageId: "u-recovered",
        text: "リトライしてワーカーを起動しました。",
        isStreaming: false,
        toolChips: [
          makeChip({
            id: "rec-1",
            toolName: "start_worker",
            label: "ワーカーを起動",
            isCompleted: true,
            isError: true,
          }),
          makeChip({
            id: "rec-2",
            toolName: "start_worker",
            label: "ワーカーを起動",
            isCompleted: true,
            isError: false,
          }),
        ],
        createdAt: "2026-11-26T06:02:04.000Z",
      }),
    ];

    expect(isWorkerDispatchReply(messages[1]!)).toBe(false);
    expect(isWorkerDispatchReply(messages[3]!)).toBe(false);
    expect(isWorkerDispatchReply(messages[5]!)).toBe(true);

    const items = deriveQuestionItems(messages);
    expect(items.map((item) => ({ id: item.id, status: item.status }))).toEqual([
      { id: "u-fail-2", status: "error" },
      { id: "u-fail-1", status: "error" },
    ]);
  });

  it("excludes worker-dispatch turns from unreadReplyIds in reconcileUnreadReplies while preserving failed dispatches and Q&A", () => {
    const streamingMessages: ChatMessage[] = [
      makeMessage({ id: "u-qa", role: "user", text: "質問" }),
      makeMessage({ id: "a-qa", role: "assistant", replyToMessageId: "u-qa", isStreaming: true }),
      makeMessage({ id: "u-dispatch", role: "user", text: "実装して" }),
      makeMessage({
        id: "a-dispatch",
        role: "assistant",
        replyToMessageId: "u-dispatch",
        isStreaming: true,
        toolChips: [
          makeChip({
            id: "c1",
            toolName: "mcp_conductor_start_worker",
            label: "ワーカーを起動",
            isCompleted: false,
          }),
        ],
      }),
      makeMessage({ id: "u-legacy", role: "user", text: "止めて" }),
      makeMessage({
        id: "a-legacy",
        role: "assistant",
        replyToMessageId: "u-legacy",
        isStreaming: true,
        toolChips: [makeChip({ id: "c2", label: "ワーカーを停止", isCompleted: false })],
      }),
      makeMessage({ id: "u-fail", role: "user", text: "失敗する起動" }),
      makeMessage({
        id: "a-fail",
        role: "assistant",
        replyToMessageId: "u-fail",
        isStreaming: true,
        toolChips: [
          makeChip({
            id: "c3",
            toolName: "start_worker",
            label: "ワーカーを起動",
            isCompleted: false,
          }),
        ],
      }),
    ];

    const step1 = reconcileUnreadReplies({
      messages: streamingMessages,
      prevStreamingIds: new Set(),
      prevUnreadIds: new Set(),
      isMessageVisible: () => false,
    });

    const completedMessages: ChatMessage[] = [
      makeMessage({ id: "u-qa", role: "user", text: "質問" }),
      makeMessage({
        id: "a-qa",
        role: "assistant",
        replyToMessageId: "u-qa",
        text: "回答です",
        toolChips: [
          makeChip({ id: "q1", toolName: "get_task_detail", label: "タスク詳細を取得", isCompleted: true }),
        ],
        isStreaming: false,
      }),
      makeMessage({ id: "u-dispatch", role: "user", text: "実装して" }),
      makeMessage({
        id: "a-dispatch",
        role: "assistant",
        replyToMessageId: "u-dispatch",
        text: "起動しました",
        toolChips: [
          makeChip({
            id: "c1",
            toolName: "mcp_conductor_start_worker",
            label: "ワーカーを起動",
            isCompleted: true,
          }),
        ],
        isStreaming: false,
      }),
      makeMessage({ id: "u-legacy", role: "user", text: "止めて" }),
      makeMessage({
        id: "a-legacy",
        role: "assistant",
        replyToMessageId: "u-legacy",
        text: "停止しました",
        toolChips: [makeChip({ id: "c2", label: "ワーカーを停止", isCompleted: true })],
        isStreaming: false,
      }),
      makeMessage({ id: "u-fail", role: "user", text: "失敗する起動" }),
      makeMessage({
        id: "a-fail",
        role: "assistant",
        replyToMessageId: "u-fail",
        text: "エラーが発生しました: failed to spawn worker",
        toolChips: [
          makeChip({
            id: "c3",
            toolName: "start_worker",
            label: "ワーカーを起動",
            isCompleted: true,
            isError: true,
          }),
        ],
        isStreaming: false,
      }),
    ];

    const step2 = reconcileUnreadReplies({
      messages: completedMessages,
      prevStreamingIds: step1.nextStreamingIds,
      prevUnreadIds: new Set(["a-dispatch"]), // stale unread ID should also be pruned
      isMessageVisible: () => false,
    });

    expect(step2.newlyCompletedIds).toEqual(["a-qa", "a-fail"]);
    expect([...step2.nextUnreadIds]).toEqual(["a-qa", "a-fail"]);
    expect([...step2.nextStreamingIds]).toEqual([]);
  });
});
