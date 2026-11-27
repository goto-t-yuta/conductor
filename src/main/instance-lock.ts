import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type UserDataMode = "prod" | "dev" | "custom";

export interface ResolvedUserDataPath {
  userDataDir: string;
  mode: UserDataMode;
}

/**
 * Resolves Conductor's Electron `userData` directory so development launches never
 * collide with a running packaged `/Applications/Conductor.app` instance unless
 * explicitly opted in via `CONDUCTOR_USE_PROD_USER_DATA=1` or `CONDUCTOR_USER_DATA_DIR`.
 */
export function resolveConductorUserDataPath(params: {
  appDataDir: string;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
}): ResolvedUserDataPath {
  const env = params.env ?? process.env;
  const customDir = env.CONDUCTOR_USER_DATA_DIR?.trim();
  if (customDir) {
    return {
      userDataDir: path.resolve(customDir),
      mode: "custom",
    };
  }

  const forceProd =
    env.CONDUCTOR_USE_PROD_USER_DATA === "1" ||
    env.CONDUCTOR_USE_PROD_USER_DATA?.trim().toLowerCase() === "true";
  const isDev = !params.isPackaged || Boolean(env.CONDUCTOR_DEV_SERVER_URL?.trim());
  if (isDev && !forceProd) {
    return {
      userDataDir: path.join(params.appDataDir, "Conductor-Dev"),
      mode: "dev",
    };
  }

  return {
    userDataDir: path.join(params.appDataDir, "Conductor"),
    mode: "prod",
  };
}

export interface InstanceLockMetadata {
  pid: number;
  instanceId: string;
  isPackaged: boolean;
  execPath: string;
  startedAt: string;
  appVersion?: string;
  mode?: UserDataMode;
}

export type DataDirectoryLockAcquireResult =
  | {
      ok: true;
      lockPath: string;
      metadata: InstanceLockMetadata;
      reclaimedStale: boolean;
    }
  | {
      ok: false;
      lockPath: string;
      existingOwner: InstanceLockMetadata | null;
      reason: string;
    };

export function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // EPERM means the process exists but belongs to another user/sandbox
    if (code === "EPERM") return true;
    return false;
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // fallback busy wait
    }
  }
}

export interface DataDirectoryLockOptions {
  pid?: number;
  instanceId?: string;
  isPackaged?: boolean;
  execPath?: string;
  appVersion?: string;
  mode?: UserDataMode;
  isProcessAlive?: (pid: number) => boolean;
  corruptLockGraceMs?: number;
}

/**
 * Cross-process advisory lock file (`<conductor-data>/instance.lock`) created atomically
 * via `O_CREAT | O_EXCL` (`wx`). Protects `state.json` and `worktrees/` even if
 * Electron's `requestSingleInstanceLock()` is bypassed (e.g. `open -n`, dev/prod pointing
 * at the same directory, or updater relaunch overlap).
 */
export class DataDirectoryLock {
  public readonly baseDir: string;
  public readonly lockPath: string;
  public readonly instanceId: string;
  private readonly pid: number;
  private readonly isPackaged: boolean;
  private readonly execPath: string;
  private readonly appVersion?: string;
  private readonly mode?: UserDataMode;
  private readonly isProcessAliveFn: (pid: number) => boolean;
  private readonly corruptLockGraceMs: number;
  private acquired = false;
  private metadata: InstanceLockMetadata | null = null;

  constructor(baseDir: string, options: DataDirectoryLockOptions = {}) {
    this.baseDir = baseDir;
    this.lockPath = path.join(baseDir, "instance.lock");
    this.pid = options.pid ?? process.pid;
    this.instanceId = options.instanceId ?? crypto.randomUUID();
    this.isPackaged = options.isPackaged ?? false;
    this.execPath = options.execPath ?? process.execPath;
    this.appVersion = options.appVersion;
    this.mode = options.mode;
    this.isProcessAliveFn = options.isProcessAlive ?? defaultIsProcessAlive;
    this.corruptLockGraceMs = Math.max(0, options.corruptLockGraceMs ?? 2_000);
  }

  public isAcquired(): boolean {
    return this.acquired;
  }

  public readOwner(): InstanceLockMetadata | null {
    try {
      const raw = fs.readFileSync(this.lockPath, "utf8").trim();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<InstanceLockMetadata>;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.pid !== "number" ||
        !Number.isInteger(parsed.pid) ||
        parsed.pid <= 0 ||
        typeof parsed.instanceId !== "string" ||
        !parsed.instanceId.trim()
      ) {
        return null;
      }
      return {
        pid: parsed.pid,
        instanceId: parsed.instanceId.trim(),
        isPackaged: Boolean(parsed.isPackaged),
        execPath: typeof parsed.execPath === "string" ? parsed.execPath : "",
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
        ...(typeof parsed.appVersion === "string" ? { appVersion: parsed.appVersion } : {}),
        ...(parsed.mode === "prod" || parsed.mode === "dev" || parsed.mode === "custom"
          ? { mode: parsed.mode }
          : {}),
      };
    } catch {
      return null;
    }
  }

  public acquire(options?: {
    retryMs?: number;
    retryIntervalMs?: number;
  }): DataDirectoryLockAcquireResult {
    if (this.acquired && this.metadata) {
      return {
        ok: true,
        lockPath: this.lockPath,
        metadata: this.metadata,
        reclaimedStale: false,
      };
    }

    fs.mkdirSync(this.baseDir, { recursive: true });
    const retryMs = Math.max(0, options?.retryMs ?? 0);
    const retryIntervalMs = Math.max(10, options?.retryIntervalMs ?? 50);
    const deadline = Date.now() + retryMs;
    let reclaimedStale = false;

    const candidate: InstanceLockMetadata = {
      pid: this.pid,
      instanceId: this.instanceId,
      isPackaged: this.isPackaged,
      execPath: this.execPath,
      startedAt: new Date().toISOString(),
      ...(this.appVersion ? { appVersion: this.appVersion } : {}),
      ...(this.mode ? { mode: this.mode } : {}),
    };

    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockPath, "wx", 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
          try {
            fs.fsyncSync(fd);
          } catch {
            // best-effort fsync
          }
        } finally {
          fs.closeSync(fd);
        }
        this.acquired = true;
        this.metadata = candidate;
        return {
          ok: true,
          lockPath: this.lockPath,
          metadata: candidate,
          reclaimedStale,
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code !== "EEXIST") {
          return {
            ok: false,
            lockPath: this.lockPath,
            existingOwner: null,
            reason: err instanceof Error ? err.message : String(err),
          };
        }

        const existing = this.readOwner();
        if (existing) {
          if (existing.instanceId === this.instanceId && existing.pid === this.pid) {
            this.acquired = true;
            this.metadata = existing;
            return {
              ok: true,
              lockPath: this.lockPath,
              metadata: existing,
              reclaimedStale,
            };
          }

          const ownerAlive = existing.pid !== this.pid ? this.isProcessAliveFn(existing.pid) : true;
          if (!ownerAlive) {
            try {
              fs.unlinkSync(this.lockPath);
              reclaimedStale = true;
            } catch {
              // another process may have already unlinked/reclaimed it
            }
            continue;
          }

          if (Date.now() < deadline) {
            sleepSync(Math.min(retryIntervalMs, Math.max(10, deadline - Date.now())));
            continue;
          }

          return {
            ok: false,
            lockPath: this.lockPath,
            existingOwner: existing,
            reason: `Another Conductor process (PID ${existing.pid}) is already using ${this.baseDir}`,
          };
        }

        // Unreadable or empty lock file (e.g. writer crashed mid-write or is currently flushing)
        let shouldReclaimCorrupt = false;
        try {
          const stat = fs.statSync(this.lockPath);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs >= this.corruptLockGraceMs) {
            shouldReclaimCorrupt = true;
          }
        } catch {
          // Lock disappeared between EEXIST and statSync; retry immediately
          continue;
        }

        if (shouldReclaimCorrupt) {
          try {
            fs.unlinkSync(this.lockPath);
            reclaimedStale = true;
          } catch {
            // ignore race
          }
          continue;
        }

        if (Date.now() < deadline) {
          sleepSync(Math.min(retryIntervalMs, Math.max(10, deadline - Date.now())));
          continue;
        }

        return {
          ok: false,
          lockPath: this.lockPath,
          existingOwner: null,
          reason: `Lock file ${this.lockPath} is currently held by another starting process`,
        };
      }
    }

    return {
      ok: false,
      lockPath: this.lockPath,
      existingOwner: this.readOwner(),
      reason: `Timed out acquiring data directory lock at ${this.lockPath}`,
    };
  }

  public release(): void {
    if (!this.acquired) return;
    this.acquired = false;
    try {
      const current = this.readOwner();
      if (current && current.instanceId === this.instanceId && current.pid === this.pid) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

export function formatDataDirectoryLockConflictMessage(
  baseDir: string,
  owner: InstanceLockMetadata | null,
): string {
  const ownerSummary = owner
    ? `PID ${owner.pid}${owner.execPath ? ` (${owner.execPath})` : ""}${owner.startedAt ? ` / 起動時刻: ${owner.startedAt}` : ""}`
    : "別の実行中プロセス";
  return [
    `別の Conductor プロセスが同じデータディレクトリを使用中です。`,
    `競合プロセス: ${ownerSummary}`,
    `データディレクトリ: ${baseDir}`,
    ``,
    `state.json の競合や履歴の上書きを防ぐため、このプロセスの起動を中止します。`,
    `既存の Conductor ウィンドウを使用するか、既存プロセスを終了してから再起動してください。`,
  ].join("\n");
}
