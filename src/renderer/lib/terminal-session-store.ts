const DEFAULT_MAX_BUFFER_CHARS = 512_000;

interface SessionBufferEntry {
  chunks: string[];
  totalChars: number;
  listeners: Set<(data: string) => void>;
}

/**
 * Bounded per-session output buffer and subscriber hub for interactive terminals.
 * Preserves scrollback output when a terminal tab is hidden, moved across project scopes,
 * or remounted after collapsing and reopening the right pane.
 */
export class TerminalOutputStore {
  private readonly entries = new Map<string, SessionBufferEntry>();
  private readonly maxBufferChars: number;

  constructor(maxBufferChars = DEFAULT_MAX_BUFFER_CHARS) {
    this.maxBufferChars = Math.max(1024, maxBufferChars);
  }

  private getOrCreate(sessionId: string): SessionBufferEntry {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { chunks: [], totalChars: 0, listeners: new Set() };
      this.entries.set(sessionId, entry);
    }
    return entry;
  }

  append(sessionId: string, data: string): void {
    if (!data) return;
    const entry = this.getOrCreate(sessionId);
    entry.chunks.push(data);
    entry.totalChars += data.length;

    while (entry.totalChars > this.maxBufferChars && entry.chunks.length > 1) {
      const removed = entry.chunks.shift()!;
      entry.totalChars -= removed.length;
    }

    if (entry.totalChars > this.maxBufferChars && entry.chunks.length === 1) {
      entry.chunks[0] = entry.chunks[0].slice(entry.chunks[0].length - this.maxBufferChars);
      entry.totalChars = entry.chunks[0].length;
    }

    for (const listener of entry.listeners) {
      listener(data);
    }
  }

  getSnapshot(sessionId: string): string {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.chunks.length === 0) return "";
    return entry.chunks.join("");
  }

  subscribe(sessionId: string, listener: (data: string) => void): () => void {
    const entry = this.getOrCreate(sessionId);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  clearBuffer(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.chunks = [];
    entry.totalChars = 0;
  }

  delete(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  clearAll(): void {
    this.entries.clear();
  }
}

export const terminalOutputStore = new TerminalOutputStore();
