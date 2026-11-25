import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  History,
  MessageSquare,
  Plus,
  Search,
  SquarePen,
  Trash2,
} from "lucide-react";
import type { AgentProvider, ChatSessionSummary } from "../../shared/types.js";

export interface ChatSessionControlsProps {
  sessions: ChatSessionSummary[];
  activeSessionId: string;
  activeMessageCount: number;
  activeResponderCount: number;
  newChatConfirmTrigger?: number;
  defaultHistoryOpen?: boolean;
  defaultConfirmNewChatOpen?: boolean;
  onSelectSession: (sessionId: string) => void;
  onNewChat: () => void;
  onDeleteSession: (sessionId: string) => void;
}

export function formatRelativeSessionTime(iso: string, nowMs = Date.now()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 45) return "たった今";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}時間前`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays === 1) return "昨日";
  if (diffDays < 7) return `${diffDays}日前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function providerShortLabel(provider?: AgentProvider): string | null {
  switch (provider) {
    case "agy":
      return "AGY";
    case "codex":
      return "Codex";
    case "claude":
      return "Claude";
    default:
      return null;
  }
}

export const ChatSessionControls: React.FC<ChatSessionControlsProps> = ({
  sessions,
  activeSessionId,
  activeMessageCount,
  activeResponderCount,
  newChatConfirmTrigger = 0,
  defaultHistoryOpen = false,
  defaultConfirmNewChatOpen = false,
  onSelectSession,
  onNewChat,
  onDeleteSession,
}) => {
  const [historyOpen, setHistoryOpen] = useState(defaultHistoryOpen);
  const [confirmNewChatOpen, setConfirmNewChatOpen] = useState(defaultConfirmNewChatOpen);
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const lastTriggerRef = useRef(newChatConfirmTrigger);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const savedSessionCount = useMemo(
    () => sessions.filter((s) => s.messageCount > 0 || s.id === activeSessionId).length,
    [sessions, activeSessionId],
  );

  const pastSavedCount = useMemo(
    () => sessions.filter((s) => s.id !== activeSessionId && s.messageCount > 0).length,
    [sessions, activeSessionId],
  );

  // React to Cmd+N shortcut trigger from App
  useEffect(() => {
    if (newChatConfirmTrigger === lastTriggerRef.current) return;
    lastTriggerRef.current = newChatConfirmTrigger;
    if (activeMessageCount > 0) {
      setHistoryOpen(false);
      setConfirmNewChatOpen(true);
    } else {
      onNewChat();
    }
  }, [newChatConfirmTrigger, activeMessageCount, onNewChat]);

  useEffect(() => {
    if (!confirmNewChatOpen) return;
    confirmButtonRef.current?.focus();
  }, [confirmNewChatOpen]);

  useEffect(() => {
    if (!historyOpen && !confirmNewChatOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setHistoryOpen(false);
        setConfirmNewChatOpen(false);
        setPendingDeleteId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [historyOpen, confirmNewChatOpen]);

  const filteredSessions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const visible = sessions.filter((s) => s.messageCount > 0 || s.id === activeSessionId);
    if (!q) return visible;
    return visible.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.preview.toLowerCase().includes(q),
    );
  }, [sessions, activeSessionId, searchQuery]);

  const handleNewChatButtonClick = () => {
    setHistoryOpen(false);
    setPendingDeleteId(null);
    if (activeMessageCount === 0) {
      onNewChat();
      return;
    }
    setConfirmNewChatOpen((prev) => !prev);
  };

  const handleConfirmNewChat = () => {
    setConfirmNewChatOpen(false);
    setHistoryOpen(false);
    setPendingDeleteId(null);
    onNewChat();
  };

  const handleSelectSession = (sessionId: string) => {
    setHistoryOpen(false);
    setConfirmNewChatOpen(false);
    setPendingDeleteId(null);
    setSearchQuery("");
    if (sessionId !== activeSessionId) {
      onSelectSession(sessionId);
    }
  };

  return (
    <div className="relative flex items-center gap-0.5">
      {/* Chat History Dropdown Button */}
      <div className="relative">
        <button
          type="button"
          data-testid="chat-history-button"
          aria-expanded={historyOpen}
          aria-haspopup="menu"
          onClick={() => {
            setConfirmNewChatOpen(false);
            setPendingDeleteId(null);
            setHistoryOpen((v) => !v);
          }}
          title="チャット履歴 — 過去のチャットをワンクリックで復元"
          className={`inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[11.5px] transition-colors cursor-pointer ${
            historyOpen
              ? "text-indigo-500 bg-indigo-500/10"
              : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          }`}
        >
          <History className="w-4 h-4" />
          {pastSavedCount > 0 && (
            <span
              data-testid="chat-history-count"
              className="min-w-[16px] h-4 px-1 rounded-full bg-zinc-200/80 dark:bg-zinc-700/80 text-zinc-700 dark:text-zinc-200 text-[10px] font-semibold inline-flex items-center justify-center leading-none"
            >
              {savedSessionCount}
            </span>
          )}
        </button>

        {historyOpen && (
          <>
            <div
              className="fixed inset-0 z-30"
              onClick={() => {
                setHistoryOpen(false);
                setPendingDeleteId(null);
              }}
            />
            <div
              data-testid="chat-history-popover"
              className="absolute right-0 mt-1.5 z-40 w-[330px] rounded-xl bg-white dark:bg-[#191d26] border border-zinc-200 dark:border-zinc-700 shadow-xl overflow-hidden"
            >
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-zinc-200/80 dark:border-zinc-800">
                <div className="flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5 text-indigo-500" />
                  <span className="text-[12px] font-semibold text-zinc-800 dark:text-zinc-100">
                    チャット履歴
                  </span>
                  <span className="text-[11px] text-zinc-400">
                    ({savedSessionCount})
                  </span>
                </div>
                <button
                  type="button"
                  data-testid="chat-history-new-button"
                  onClick={handleNewChatButtonClick}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/20 transition-colors cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  新規チャット
                </button>
              </div>

              {savedSessionCount >= 4 && (
                <div className="px-2.5 py-2 border-b border-zinc-200/60 dark:border-zinc-800/80">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="履歴を検索..."
                      className="w-full pl-7 pr-2.5 py-1 rounded-lg text-[11.5px] bg-zinc-100 dark:bg-zinc-800/80 text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                    />
                  </div>
                </div>
              )}

              <div className="max-h-[340px] overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/70">
                {filteredSessions.length === 0 ? (
                  <div className="px-4 py-6 text-center text-[12px] text-zinc-400">
                    一致するチャット履歴がありません
                  </div>
                ) : (
                  filteredSessions.map((session) => {
                    const isActive = session.id === activeSessionId;
                    const isPendingDelete = pendingDeleteId === session.id;
                    const provLabel = providerShortLabel(session.provider);
                    return (
                      <div
                        key={session.id}
                        data-testid={`chat-history-item-${session.id}`}
                        onClick={() => handleSelectSession(session.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleSelectSession(session.id);
                          }
                        }}
                        className={`group relative flex items-start gap-2 px-3 py-2.5 text-left transition-colors cursor-pointer ${
                          isActive
                            ? "bg-indigo-500/[0.08] dark:bg-indigo-500/[0.14]"
                            : "hover:bg-zinc-100/80 dark:hover:bg-zinc-800/70"
                        }`}
                      >
                        <div className="mt-0.5 shrink-0">
                          {isActive ? (
                            <span className="w-4 h-4 rounded-full bg-indigo-500 text-white inline-flex items-center justify-center">
                              <Check className="w-2.5 h-2.5" />
                            </span>
                          ) : (
                            <MessageSquare className="w-3.5 h-3.5 text-zinc-400 mt-0.5" />
                          )}
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`text-[12px] truncate ${
                                isActive
                                  ? "font-semibold text-indigo-700 dark:text-indigo-300"
                                  : "font-medium text-zinc-800 dark:text-zinc-100"
                              }`}
                            >
                              {session.title}
                            </span>
                            {isActive && (
                              <span
                                data-testid="chat-history-active-badge"
                                className="shrink-0 px-1.5 py-0.5 rounded text-[9.5px] font-semibold bg-indigo-500/15 text-indigo-600 dark:text-indigo-300"
                              >
                                表示中
                              </span>
                            )}
                          </div>

                          {session.preview ? (
                            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                              {session.preview}
                            </p>
                          ) : (
                            <p className="text-[11px] text-zinc-400 italic mt-0.5">
                              メッセージなし
                            </p>
                          )}

                          <div className="flex items-center gap-2 mt-1 text-[10.5px] text-zinc-400">
                            <span>{formatRelativeSessionTime(session.updatedAt)}</span>
                            <span>·</span>
                            <span>{session.messageCount}件</span>
                            {provLabel && (
                              <>
                                <span>·</span>
                                <span className="text-zinc-500 dark:text-zinc-400 font-medium">
                                  {provLabel}
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Delete action (2-step inline confirm to avoid accidental deletion) */}
                        <div
                          className="shrink-0 flex items-center"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {isPendingDelete ? (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                data-testid={`chat-history-delete-confirm-${session.id}`}
                                onClick={() => {
                                  setPendingDeleteId(null);
                                  onDeleteSession(session.id);
                                }}
                                className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-500 text-white hover:bg-rose-600 cursor-pointer"
                              >
                                削除
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDeleteId(null)}
                                className="px-1.5 py-0.5 rounded text-[10px] text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700 cursor-pointer"
                              >
                                戻す
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              data-testid={`chat-history-delete-${session.id}`}
                              title="このチャットを履歴から削除"
                              onClick={() => setPendingDeleteId(session.id)}
                              className="p-1 rounded text-zinc-400 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-rose-500 hover:bg-rose-500/10 transition-all cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* New Chat Button + Lightweight Confirmation Popover when non-empty */}
      <div className="relative">
        <button
          type="button"
          data-testid="new-chat-button"
          onClick={handleNewChatButtonClick}
          title="新しいチャットを開始 (⌘N) — 現在のチャットは履歴に保存されます"
          className={`p-1.5 rounded-md transition-colors cursor-pointer ${
            confirmNewChatOpen
              ? "text-indigo-500 bg-indigo-500/10"
              : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          }`}
        >
          <SquarePen className="w-4 h-4" />
        </button>

        {confirmNewChatOpen && (
          <>
            <div
              className="fixed inset-0 z-30"
              onClick={() => setConfirmNewChatOpen(false)}
            />
            <div
              data-testid="new-chat-confirm-popover"
              role="dialog"
              aria-label="新しいチャットを開始する確認"
              className="absolute right-0 mt-1.5 z-40 w-[290px] rounded-xl bg-white dark:bg-[#191d26] border border-zinc-200 dark:border-zinc-700 shadow-xl p-3 space-y-2.5"
            >
              <div className="space-y-1">
                <div className="text-[12.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                  新しいチャットを開始しますか？
                </div>
                <p className="text-[11.5px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                  現在のチャット（{activeMessageCount}件）は履歴に自動保存され、隣の履歴ボタンからいつでも復元できます。
                </p>
                {activeResponderCount > 0 && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    応答中の{activeResponderCount}件は停止して保存されます。
                  </p>
                )}
              </div>
              <div className="flex items-center justify-end gap-1.5 pt-0.5">
                <button
                  type="button"
                  data-testid="new-chat-cancel-button"
                  onClick={() => setConfirmNewChatOpen(false)}
                  className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  キャンセル
                </button>
                <button
                  ref={confirmButtonRef}
                  type="button"
                  data-testid="new-chat-confirm-button"
                  onClick={handleConfirmNewChat}
                  className="px-2.5 py-1 rounded-lg text-[11.5px] font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors cursor-pointer"
                >
                  新規チャットを開始
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
