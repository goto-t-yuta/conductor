import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatSessionSummary } from "../src/shared/types.js";
import {
  ChatSessionControls,
  formatRelativeSessionTime,
  type ChatSessionControlsProps,
} from "../src/renderer/components/ChatHistoryMenu.js";

const SAMPLE_SESSIONS: ChatSessionSummary[] = [
  {
    id: "sess-1",
    title: "ログインバグの調査",
    preview: "認証トークンの有効期限チェックを修正しました。",
    messageCount: 6,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:55:00.000Z",
    provider: "agy",
  },
  {
    id: "sess-2",
    title: "UIテーマのダークモード改善",
    preview: "コントラスト比を確認しました。",
    messageCount: 4,
    createdAt: "2026-11-25T12:00:00.000Z",
    updatedAt: "2026-11-25T14:00:00.000Z",
    provider: "codex",
  },
];

function makeProps(overrides: Partial<ChatSessionControlsProps> = {}): ChatSessionControlsProps {
  return {
    sessions: SAMPLE_SESSIONS,
    activeSessionId: "sess-1",
    activeMessageCount: 6,
    activeResponderCount: 0,
    onSelectSession: vi.fn(),
    onNewChat: vi.fn(),
    onDeleteSession: vi.fn(),
    ...overrides,
  };
}

describe("ChatSessionControls UI", () => {
  it("formats relative timestamps in Japanese cleanly", () => {
    const now = Date.parse("2026-11-26T01:00:00.000Z");
    expect(formatRelativeSessionTime("2026-11-26T00:59:40.000Z", now)).toBe("たった今");
    expect(formatRelativeSessionTime("2026-11-26T00:55:00.000Z", now)).toBe("5分前");
    expect(formatRelativeSessionTime("2026-11-25T23:00:00.000Z", now)).toBe("2時間前");
    expect(formatRelativeSessionTime("2026-11-25T01:00:00.000Z", now)).toBe("昨日");
  });

  it("renders history button with count badge and new chat button", () => {
    const html = renderToStaticMarkup(<ChatSessionControls {...makeProps()} />);
    expect(html).toContain('data-testid="chat-history-button"');
    expect(html).toContain('data-testid="chat-history-count"');
    expect(html).toContain(">2<");
    expect(html).toContain('data-testid="new-chat-button"');
    expect(html).not.toContain('data-testid="chat-history-popover"');
    expect(html).not.toContain('data-testid="new-chat-confirm-popover"');
  });

  it("renders Chat History dropdown with active badge, titles, previews, message counts, and delete buttons", () => {
    const html = renderToStaticMarkup(
      <ChatSessionControls {...makeProps({ defaultHistoryOpen: true })} />,
    );
    expect(html).toContain('data-testid="chat-history-popover"');
    expect(html).toContain("チャット履歴");
    expect(html).toContain("ログインバグの調査");
    expect(html).toContain("認証トークンの有効期限チェックを修正しました。");
    expect(html).toContain("UIテーマのダークモード改善");
    expect(html).toContain('data-testid="chat-history-active-badge"');
    expect(html).toContain("表示中");
    expect(html).toContain("AGY");
    expect(html).toContain("Codex");
    expect(html).toContain('data-testid="chat-history-delete-sess-2"');
  });

  it("renders lightweight New Chat confirmation popover when non-empty and warns if responders are active", () => {
    const html = renderToStaticMarkup(
      <ChatSessionControls
        {...makeProps({
          defaultConfirmNewChatOpen: true,
          activeMessageCount: 6,
          activeResponderCount: 2,
        })}
      />,
    );
    expect(html).toContain('data-testid="new-chat-confirm-popover"');
    expect(html).toContain("新しいチャットを開始しますか？");
    expect(html).toContain("現在のチャット（6件）は履歴に自動保存され");
    expect(html).toContain("応答中の2件は停止して保存されます。");
    expect(html).toContain('data-testid="new-chat-confirm-button"');
    expect(html).toContain('data-testid="new-chat-cancel-button"');
  });
});
