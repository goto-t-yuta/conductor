export type TerminalBackendKind = "node-pty" | "python-pty" | "pipe";

export interface TerminalCreateOptions {
  id?: string;
  cwd?: string | null;
  cols?: number;
  rows?: number;
  projectId?: string | null;
}

export interface TerminalSessionInfo {
  id: string;
  shell: string;
  shellName: string;
  cwd: string;
  pid: number | null;
  backend: TerminalBackendKind;
  cols: number;
  rows: number;
}

export interface TerminalCreateResult {
  ok: boolean;
  session?: TerminalSessionInfo;
  error?: string;
}

export interface TerminalWriteResult {
  ok: boolean;
  error?: string;
}

export interface TerminalResizeResult {
  ok: boolean;
  error?: string;
}

export interface TerminalCloseResult {
  ok: boolean;
}

export interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number | null;
  signal?: number | null;
}

export const TERMINAL_IPC_CHANNELS = {
  create: "terminal:create",
  write: "terminal:write",
  resize: "terminal:resize",
  close: "terminal:close",
  data: "terminal:data",
  exit: "terminal:exit",
} as const;

export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;
export const MIN_TERMINAL_COLS = 2;
export const MAX_TERMINAL_COLS = 500;
export const MIN_TERMINAL_ROWS = 1;
export const MAX_TERMINAL_ROWS = 200;

export function clampTerminalDimensions(
  cols?: number,
  rows?: number,
): { cols: number; rows: number } {
  const safeCols =
    typeof cols === "number" && Number.isFinite(cols)
      ? Math.max(MIN_TERMINAL_COLS, Math.min(MAX_TERMINAL_COLS, Math.floor(cols)))
      : DEFAULT_TERMINAL_COLS;
  const safeRows =
    typeof rows === "number" && Number.isFinite(rows)
      ? Math.max(MIN_TERMINAL_ROWS, Math.min(MAX_TERMINAL_ROWS, Math.floor(rows)))
      : DEFAULT_TERMINAL_ROWS;
  return { cols: safeCols, rows: safeRows };
}

export function formatShellDisplayName(shellPath: string | null | undefined): string {
  const trimmed = (shellPath ?? "").trim();
  if (!trimmed) return "shell";
  const normalized = trimmed.replace(/\\/g, "/");
  const base = normalized.split("/").pop() || trimmed;
  return base.replace(/\.exe$/i, "") || "shell";
}

export function buildTerminalTabTitle(
  shellName: string | null | undefined,
  sequenceNumber: number,
  fallbackLabel = "Terminal",
): string {
  const base = (shellName ?? "").trim() || fallbackLabel;
  return sequenceNumber > 1 ? `${base} #${sequenceNumber}` : base;
}
