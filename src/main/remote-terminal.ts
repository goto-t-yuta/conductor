import {
  clampTerminalDimensions,
  type TerminalBackendKind,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalSessionInfo,
} from "../shared/terminal.js";
import { TerminalManager, type TerminalManagerOptions } from "./terminal-manager.js";

export const DEFAULT_REMOTE_TERMINAL_BUFFER_CHARS = 128 * 1024; // 128 KiB ring buffer per session
const MAX_RETAINED_SESSIONS = 24;

export interface RemoteTerminalSessionSnapshot {
  id: string;
  cwd: string;
  requestedCwd: string | null;
  projectPath: string | null;
  shell: string;
  shellName: string;
  pid: number | null;
  backend: TerminalBackendKind;
  cols: number;
  rows: number;
  status: "running" | "exited";
  exitCode: number | null;
  signal: number | null;
  createdAt: string;
  lastActivityAt: string;
  bufferChars: number;
}

export interface RemoteTerminalCreateParams {
  id?: string;
  projectPath?: string | null;
  cwd?: string | null;
  cols?: number;
  rows?: number;
}

export interface RemoteTerminalSubscriber {
  onData: (event: { sessionId: string; data: string; seq: number }) => void;
  onExit: (event: { sessionId: string; exitCode: number | null; signal: number | null }) => void;
}

export interface RemoteTerminalReplayResult {
  replay: string;
  seq: number;
  replayMode: "full" | "delta";
}

interface BufferedChunk {
  seq: number;
  data: string;
}

interface ManagedRemoteTerminalSession {
  snapshot: RemoteTerminalSessionSnapshot;
  chunks: BufferedChunk[];
  bufferChars: number;
  latestSeq: number;
  oldestRetainedSeq: number;
  truncatedBeforeOldest: boolean;
  subscribers: Set<RemoteTerminalSubscriber>;
}

export interface RemoteTerminalServiceOptions {
  maxBufferChars?: number;
  terminalManagerOptions?: Omit<TerminalManagerOptions, "onData" | "onExit">;
}

/**
 * Manages remote PTY sessions exposed via RemoteBridgeServer (WebSocket + HTTP).
 * Backed by Conductor's existing TerminalManager (node-pty -> python-pty -> pipe),
 * adding a bounded output ring buffer with sequence numbers so mobile clients can
 * reconnect or resume from background without losing terminal context.
 */
export class RemoteTerminalService {
  private readonly manager: TerminalManager;
  private readonly maxBufferChars: number;
  private readonly sessions = new Map<string, ManagedRemoteTerminalSession>();

  constructor(options: RemoteTerminalServiceOptions = {}) {
    this.maxBufferChars = Math.max(
      1_024,
      options.maxBufferChars ?? DEFAULT_REMOTE_TERMINAL_BUFFER_CHARS,
    );
    this.manager = new TerminalManager({
      ...(options.terminalManagerOptions ?? {}),
      onData: (event) => this.handleTerminalData(event),
      onExit: (event) => this.handleTerminalExit(event),
    });
  }

  public createSession(
    params: RemoteTerminalCreateParams = {},
  ): { ok: true; session: RemoteTerminalSessionSnapshot } | { ok: false; error: string } {
    const requestedProjectPath =
      typeof params.projectPath === "string" && params.projectPath.trim().length > 0
        ? params.projectPath.trim()
        : null;
    const requestedCwd =
      requestedProjectPath ??
      (typeof params.cwd === "string" && params.cwd.trim().length > 0 ? params.cwd.trim() : null);

    const { cols, rows } = clampTerminalDimensions(params.cols, params.rows);

    const created = this.manager.create({
      id: params.id,
      cwd: requestedCwd,
      cols,
      rows,
    });

    if (!created.ok || !created.session) {
      return {
        ok: false,
        error: created.error ?? "Failed to create terminal session",
      };
    }

    const now = new Date().toISOString();
    const info: TerminalSessionInfo = created.session;
    const snapshot: RemoteTerminalSessionSnapshot = {
      id: info.id,
      cwd: info.cwd,
      requestedCwd,
      projectPath: requestedProjectPath,
      shell: info.shell,
      shellName: info.shellName,
      pid: info.pid,
      backend: info.backend,
      cols: info.cols,
      rows: info.rows,
      status: "running",
      exitCode: null,
      signal: null,
      createdAt: now,
      lastActivityAt: now,
      bufferChars: 0,
    };

    const existing = this.sessions.get(info.id);
    const managed: ManagedRemoteTerminalSession = {
      snapshot,
      chunks: [],
      bufferChars: 0,
      latestSeq: 0,
      oldestRetainedSeq: 0,
      truncatedBeforeOldest: false,
      subscribers: existing?.subscribers ?? new Set(),
    };
    this.sessions.set(info.id, managed);
    this.pruneOldSessions();

    return { ok: true, session: { ...snapshot } };
  }

  public getOrCreateSession(
    params: RemoteTerminalCreateParams & { sessionId?: string | null },
  ):
    | { ok: true; session: RemoteTerminalSessionSnapshot; recreated: boolean }
    | { ok: false; error: string } {
    const requestedId =
      typeof params.sessionId === "string" && params.sessionId.trim().length > 0
        ? params.sessionId.trim()
        : null;

    if (requestedId) {
      const existing = this.sessions.get(requestedId);
      if (existing) {
        if (
          existing.snapshot.status === "running" &&
          typeof params.cols === "number" &&
          typeof params.rows === "number"
        ) {
          this.resize(existing.snapshot.id, params.cols, params.rows);
        }
        return {
          ok: true,
          session: { ...existing.snapshot },
          recreated: false,
        };
      }
    }

    const created = this.createSession({
      projectPath: params.projectPath,
      cwd: params.cwd,
      cols: params.cols,
      rows: params.rows,
    });
    if (!created.ok) {
      return created;
    }
    return {
      ok: true,
      session: created.session,
      recreated: requestedId !== null,
    };
  }

  public listSessions(): RemoteTerminalSessionSnapshot[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s.snapshot }));
  }

  public getSession(sessionId: string): RemoteTerminalSessionSnapshot | null {
    const managed = this.sessions.get(sessionId);
    return managed ? { ...managed.snapshot } : null;
  }

  public getReplay(sessionId: string, afterSeq?: number | null): RemoteTerminalReplayResult | null {
    const managed = this.sessions.get(sessionId);
    if (!managed) return null;

    const seq = managed.latestSeq;
    const validAfterSeq =
      typeof afterSeq === "number" && Number.isFinite(afterSeq) && afterSeq >= 0
        ? Math.floor(afterSeq)
        : null;

    if (validAfterSeq !== null) {
      if (validAfterSeq >= seq) {
        return { replay: "", seq, replayMode: "delta" };
      }
      // If we haven't dropped any chunks after `afterSeq`, return only delta chunks
      const canServeDelta =
        !managed.truncatedBeforeOldest ||
        (managed.oldestRetainedSeq > 0 && validAfterSeq >= managed.oldestRetainedSeq - 1);
      if (canServeDelta) {
        const delta = managed.chunks
          .filter((c) => c.seq > validAfterSeq)
          .map((c) => c.data)
          .join("");
        return { replay: delta, seq, replayMode: "delta" };
      }
    }

    const full = managed.chunks.map((c) => c.data).join("");
    return { replay: full, seq, replayMode: "full" };
  }

  public subscribe(sessionId: string, subscriber: RemoteTerminalSubscriber): () => void {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return () => {};
    }
    managed.subscribers.add(subscriber);
    return () => {
      managed.subscribers.delete(subscriber);
    };
  }

  public write(sessionId: string, data: string): { ok: boolean; error?: string } {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return { ok: false, error: `Terminal session not found: ${sessionId}` };
    }
    if (managed.snapshot.status !== "running") {
      return { ok: false, error: "Terminal session has already exited" };
    }
    const result = this.manager.write(sessionId, data);
    if (result.ok) {
      managed.snapshot.lastActivityAt = new Date().toISOString();
    }
    return result;
  }

  public resize(
    sessionId: string,
    cols: number,
    rows: number,
  ): { ok: true; session: RemoteTerminalSessionSnapshot } | { ok: false; error: string } {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return { ok: false, error: `Terminal session not found: ${sessionId}` };
    }
    if (managed.snapshot.status !== "running") {
      return { ok: true, session: { ...managed.snapshot } };
    }
    const clamped = clampTerminalDimensions(cols, rows);
    const result = this.manager.resize(sessionId, clamped.cols, clamped.rows);
    if (!result.ok) {
      return { ok: false, error: result.error ?? "Failed to resize terminal" };
    }
    managed.snapshot.cols = clamped.cols;
    managed.snapshot.rows = clamped.rows;
    managed.snapshot.lastActivityAt = new Date().toISOString();
    return { ok: true, session: { ...managed.snapshot } };
  }

  public closeSession(sessionId: string): { ok: boolean } {
    const managed = this.sessions.get(sessionId);
    if (!managed) {
      return { ok: false };
    }
    this.manager.close(sessionId);
    this.sessions.delete(sessionId);
    managed.subscribers.clear();
    return { ok: true };
  }

  public disposeAll(): void {
    this.manager.disposeAll();
    for (const managed of this.sessions.values()) {
      managed.subscribers.clear();
    }
    this.sessions.clear();
  }

  private handleTerminalData(event: TerminalDataEvent): void {
    const managed = this.sessions.get(event.sessionId);
    if (!managed || !event.data) return;

    managed.latestSeq += 1;
    const seq = managed.latestSeq;
    let chunkData = event.data;

    if (chunkData.length > this.maxBufferChars) {
      chunkData = chunkData.slice(chunkData.length - this.maxBufferChars);
      managed.chunks = [];
      managed.bufferChars = 0;
      managed.truncatedBeforeOldest = true;
    }

    managed.chunks.push({ seq, data: chunkData });
    managed.bufferChars += chunkData.length;

    while (managed.bufferChars > this.maxBufferChars && managed.chunks.length > 1) {
      const removed = managed.chunks.shift()!;
      managed.bufferChars -= removed.data.length;
      managed.truncatedBeforeOldest = true;
    }

    if (managed.bufferChars > this.maxBufferChars && managed.chunks.length === 1) {
      const only = managed.chunks[0];
      const excess = managed.bufferChars - this.maxBufferChars;
      only.data = only.data.slice(excess);
      managed.bufferChars = only.data.length;
      managed.truncatedBeforeOldest = true;
    }

    managed.oldestRetainedSeq = managed.chunks[0]?.seq ?? seq;
    managed.snapshot.bufferChars = managed.bufferChars;
    managed.snapshot.lastActivityAt = new Date().toISOString();

    for (const sub of [...managed.subscribers]) {
      try {
        sub.onData({ sessionId: event.sessionId, data: event.data, seq });
      } catch {
        // ignore subscriber errors
      }
    }
  }

  private handleTerminalExit(event: TerminalExitEvent): void {
    const managed = this.sessions.get(event.sessionId);
    if (!managed) return;

    managed.snapshot.status = "exited";
    managed.snapshot.exitCode = event.exitCode ?? null;
    managed.snapshot.signal = event.signal ?? null;
    managed.snapshot.lastActivityAt = new Date().toISOString();

    for (const sub of [...managed.subscribers]) {
      try {
        sub.onExit({
          sessionId: event.sessionId,
          exitCode: event.exitCode ?? null,
          signal: event.signal ?? null,
        });
      } catch {
        // ignore subscriber errors
      }
    }
  }

  private pruneOldSessions(): void {
    if (this.sessions.size <= MAX_RETAINED_SESSIONS) return;
    // Prefer evicting exited sessions with no active subscribers first
    for (const [id, managed] of this.sessions) {
      if (this.sessions.size <= MAX_RETAINED_SESSIONS) break;
      if (managed.snapshot.status === "exited" && managed.subscribers.size === 0) {
        this.sessions.delete(id);
      }
    }
  }
}
