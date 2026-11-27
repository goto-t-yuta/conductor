import crypto from "node:crypto";
import type {
  AgentProvider,
  ChatMessage,
  ChatSession,
  ChatSessionBackendIds,
  ChatSessionSummary,
} from "./types.js";

export const DEFAULT_CHAT_TITLE = "新しいチャット";
export const MAX_CHAT_SESSIONS = 50;
export const MAX_MESSAGES_PER_SESSION = 2000;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…`;
}

export function deriveChatSessionTitle(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (firstUser) {
    const cleaned = collapseWhitespace(firstUser.text);
    if (cleaned && cleaned !== "(添付を参照してください)") {
      return truncateText(cleaned, 44);
    }
    const firstAtt = firstUser.attachments.find((a) => collapseWhitespace(a.label).length > 0);
    if (firstAtt) {
      return truncateText(collapseWhitespace(firstAtt.label), 44);
    }
    if (cleaned) {
      return truncateText(cleaned, 44);
    }
  }

  const firstMeaningful = messages.find((m) => collapseWhitespace(m.text).length > 0);
  if (firstMeaningful) {
    return truncateText(collapseWhitespace(firstMeaningful.text), 44);
  }

  return DEFAULT_CHAT_TITLE;
}

export function deriveChatSessionPreview(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;
    const cleaned = collapseWhitespace(msg.text);
    if (cleaned) {
      return truncateText(cleaned, 90);
    }
    const firstAtt = msg.attachments.find((a) => collapseWhitespace(a.label).length > 0);
    if (firstAtt) {
      return truncateText(collapseWhitespace(firstAtt.label), 90);
    }
  }
  return "";
}

export function extractBackendSessionIdsFromMessages(
  messages: readonly ChatMessage[],
  existing?: ChatSessionBackendIds,
): ChatSessionBackendIds {
  const ids: ChatSessionBackendIds = {
    ...(existing?.codex ? { codex: existing.codex } : {}),
    ...(existing?.agy ? { agy: existing.agy } : {}),
    ...(existing?.claude ? { claude: existing.claude } : {}),
  };

  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.responderThreadId) continue;
    const prov = msg.provider;
    if (prov === "codex" && !ids.codex) {
      ids.codex = msg.responderThreadId;
    } else if (prov === "agy" && !ids.agy) {
      ids.agy = msg.responderThreadId;
    } else if (prov === "claude" && !ids.claude) {
      ids.claude = msg.responderThreadId;
    }
  }

  return ids;
}

export function createEmptyChatSession(
  provider?: AgentProvider,
  now = new Date().toISOString(),
): ChatSession {
  return {
    id: crypto.randomUUID(),
    title: DEFAULT_CHAT_TITLE,
    preview: "",
    messages: [],
    createdAt: now,
    updatedAt: now,
    provider,
    backendSessionIds: {},
  };
}

export function sanitizeChatMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.slice(-MAX_MESSAGES_PER_SESSION).map((m) => ({
    ...m,
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    toolChips: Array.isArray(m.toolChips) ? m.toolChips : [],
    isStreaming: false,
    responderTurnId: undefined,
  }));
}

export function sortChatSessionsByRecency(sessions: readonly ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => {
    const aMs = Date.parse(a.updatedAt) || Date.parse(a.createdAt) || 0;
    const bMs = Date.parse(b.updatedAt) || Date.parse(b.createdAt) || 0;
    return bMs - aMs;
  });
}

export function capChatSessionsPreservingActive(
  sessions: readonly ChatSession[],
  activeSessionId?: string | null,
  maxSessions = MAX_CHAT_SESSIONS,
): ChatSession[] {
  const sorted = sortChatSessionsByRecency(sessions);
  if (sorted.length <= maxSessions) {
    return sorted;
  }
  const kept = sorted.slice(0, maxSessions);
  if (!activeSessionId || kept.some((s) => s.id === activeSessionId)) {
    return kept;
  }
  const active = sorted.find((s) => s.id === activeSessionId);
  if (!active) {
    return kept;
  }
  return [...kept.slice(0, Math.max(0, maxSessions - 1)), active];
}

export function toChatSessionSummary(session: ChatSession): ChatSessionSummary {
  return {
    id: session.id,
    title: session.title || deriveChatSessionTitle(session.messages),
    preview: session.preview ?? deriveChatSessionPreview(session.messages),
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    provider: session.provider,
  };
}

export function normalizeChatSessions(input: {
  chatSessions?: unknown;
  activeChatSessionId?: unknown;
  legacyMessages?: unknown;
  chatProvider?: AgentProvider;
  now?: string;
}): {
  chatSessions: ChatSession[];
  activeChatSessionId: string;
  changed: boolean;
} {
  const now = input.now ?? new Date().toISOString();
  const rawSessions = Array.isArray(input.chatSessions) ? input.chatSessions : [];
  const rawLegacyMessages = Array.isArray(input.legacyMessages)
    ? (input.legacyMessages as ChatMessage[])
    : [];

  let changed = !Array.isArray(input.chatSessions);
  const seenIds = new Set<string>();
  const normalized: ChatSession[] = [];

  for (const raw of rawSessions) {
    if (!raw || typeof raw !== "object") {
      changed = true;
      continue;
    }
    const rec = raw as Partial<ChatSession>;
    const id = typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : crypto.randomUUID();
    if (seenIds.has(id)) {
      changed = true;
      continue;
    }
    seenIds.add(id);

    const messages = Array.isArray(rec.messages) ? sanitizeChatMessages(rec.messages) : [];
    const createdAt =
      typeof rec.createdAt === "string" && rec.createdAt
        ? rec.createdAt
        : messages[0]?.createdAt ?? now;
    const updatedAt =
      typeof rec.updatedAt === "string" && rec.updatedAt
        ? rec.updatedAt
        : messages[messages.length - 1]?.createdAt ?? createdAt;
    const title =
      typeof rec.title === "string" && rec.title.trim() && rec.title !== DEFAULT_CHAT_TITLE
        ? rec.title.trim()
        : deriveChatSessionTitle(messages);
    const preview = deriveChatSessionPreview(messages);
    const backendSessionIds = extractBackendSessionIdsFromMessages(messages, rec.backendSessionIds);
    const inferredProvider =
      rec.provider ??
      [...messages].reverse().find((m) => m.provider)?.provider ??
      input.chatProvider;

    normalized.push({
      id,
      title,
      preview,
      messages,
      createdAt,
      updatedAt,
      provider: inferredProvider,
      backendSessionIds,
    });
  }

  // Migrate legacy flat `messages` into a persistent session if no sessions existed yet
  if (normalized.length === 0 && rawLegacyMessages.length > 0) {
    const messages = sanitizeChatMessages(rawLegacyMessages);
    const createdAt = messages[0]?.createdAt ?? now;
    const updatedAt = messages[messages.length - 1]?.createdAt ?? now;
    const inferredProvider =
      [...messages].reverse().find((m) => m.provider)?.provider ?? input.chatProvider;
    const migrated: ChatSession = {
      id: crypto.randomUUID(),
      title: deriveChatSessionTitle(messages),
      preview: deriveChatSessionPreview(messages),
      messages,
      createdAt,
      updatedAt,
      provider: inferredProvider,
      backendSessionIds: extractBackendSessionIdsFromMessages(messages),
    };
    normalized.push(migrated);
    changed = true;
  }

  if (normalized.length === 0) {
    normalized.push(createEmptyChatSession(input.chatProvider, now));
    changed = true;
  }

  const requestedActiveId =
    typeof input.activeChatSessionId === "string" ? input.activeChatSessionId : null;
  const sorted = capChatSessionsPreservingActive(
    normalized,
    requestedActiveId,
    MAX_CHAT_SESSIONS,
  );
  if (sorted.length !== normalized.length) {
    changed = true;
  }

  const activeSession =
    (requestedActiveId ? sorted.find((s) => s.id === requestedActiveId) : undefined) ?? sorted[0]!;

  if (activeSession.id !== requestedActiveId) {
    changed = true;
  }

  return {
    chatSessions: sorted,
    activeChatSessionId: activeSession.id,
    changed,
  };
}
