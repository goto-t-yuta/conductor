import { formatTaskCode } from "../shared/mentions.js";
import type { AgentTask } from "../shared/types.js";

export const MAX_QUIT_DIALOG_TASKS = 5;

export type QuitTaskSummary = Pick<AgentTask, "id" | "taskNumber" | "projectName" | "title">;

export interface QuitConfirmationDialogContent {
  type: "warning";
  buttons: [string, string];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
  title: string;
  message: string;
  detail: string;
}

export interface BeforeQuitEventLike {
  preventDefault(): void;
}

export interface QuitGuardDeps {
  getRunningTasks: () => QuitTaskSummary[];
  showConfirmationDialog: (dialog: QuitConfirmationDialogContent) => Promise<boolean> | boolean;
  performShutdown: () => Promise<void>;
  quitApp: () => void;
}

function formatTaskBullet(task: Pick<AgentTask, "taskNumber" | "projectName" | "title">): string {
  const title = task.title.trim() || "(無題のタスク)";
  const code =
    typeof task.taskNumber === "number" && Number.isInteger(task.taskNumber) && task.taskNumber > 0
      ? formatTaskCode(task.taskNumber)
      : null;
  const project = task.projectName?.trim();
  if (code && project) {
    return `• [${code} · ${project}] ${title}`;
  }
  if (project) {
    return `• [${project}] ${title}`;
  }
  if (code) {
    return `• [${code}] ${title}`;
  }
  return `• ${title}`;
}

export function buildQuitConfirmationDialog(
  runningTasks: readonly Pick<AgentTask, "taskNumber" | "projectName" | "title">[],
  maxTitles = MAX_QUIT_DIALOG_TASKS,
): QuitConfirmationDialogContent {
  const count = runningTasks.length;
  const limit = Math.max(1, maxTitles);
  const visible = runningTasks.slice(0, limit);
  const remaining = Math.max(0, count - visible.length);

  const lines: string[] = [
    "終了すると実行中のワーカーを今すぐ停止し、次回の Conductor 起動時に自動的に再開します。",
    "",
    ...visible.map((t) => formatTaskBullet(t)),
  ];
  if (remaining > 0) {
    lines.push(`…ほか +${remaining} 件`);
  }

  return {
    type: "warning",
    buttons: ["キャンセル", "終了して次回起動時に再開"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "実行中のタスクがあります",
    message: `実行中のタスクが ${count} 件あります。Conductor を終了しますか？`,
    detail: lines.join("\n"),
  };
}

export function buildUpdateRestartConfirmationDialog(
  runningTasks: readonly Pick<AgentTask, "taskNumber" | "projectName" | "title">[],
  versionTag?: string | null,
  maxTitles = MAX_QUIT_DIALOG_TASKS,
): QuitConfirmationDialogContent {
  const count = runningTasks.length;
  const limit = Math.max(1, maxTitles);
  const visible = runningTasks.slice(0, limit);
  const remaining = Math.max(0, count - visible.length);
  const targetLabel = versionTag?.trim() ? `（${versionTag.trim()}）` : "";

  const lines: string[] = [
    `再起動してアップデート${targetLabel}を適用すると、実行中のワーカーを一旦停止し、再起動後に自動的に再開します。`,
    "",
    ...visible.map((t) => formatTaskBullet(t)),
  ];
  if (remaining > 0) {
    lines.push(`…ほか +${remaining} 件`);
  }

  return {
    type: "warning",
    buttons: ["キャンセル", "再起動してアップデートを適用"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "実行中のタスクがあります",
    message: `実行中のタスクが ${count} 件あります。このまま再起動してアップデートを適用しますか？`,
    detail: lines.join("\n"),
  };
}

/**
 * Coordinates Electron's `before-quit` interception with re-entrancy protection:
 * - If running tasks exist, prompts the user before quitting.
 * - Guards against duplicate dialogs or overlapping shutdown calls.
 * - Runs `performShutdown()` cleanly before triggering the final confirmed `quitApp()`.
 */
export class QuitGuard {
  private readonly deps: QuitGuardDeps;
  private isQuitConfirmed = false;
  private isQuitDialogOpen = false;
  private isShuttingDown = false;
  private pendingPromise: Promise<void> | null = null;

  constructor(deps: QuitGuardDeps) {
    this.deps = deps;
  }

  public getState(): {
    isQuitConfirmed: boolean;
    isQuitDialogOpen: boolean;
    isShuttingDown: boolean;
  } {
    return {
      isQuitConfirmed: this.isQuitConfirmed,
      isQuitDialogOpen: this.isQuitDialogOpen,
      isShuttingDown: this.isShuttingDown,
    };
  }

  public handleBeforeQuit(event: BeforeQuitEventLike): Promise<void> {
    if (this.isQuitConfirmed) {
      return Promise.resolve();
    }

    event.preventDefault();

    if (this.isQuitDialogOpen || this.isShuttingDown) {
      return this.pendingPromise ?? Promise.resolve();
    }

    const runningTasks = this.deps.getRunningTasks();
    if (runningTasks.length > 0) {
      this.isQuitDialogOpen = true;
      const dialogContent = buildQuitConfirmationDialog(runningTasks);
      const run = (async () => {
        let confirmed = false;
        try {
          confirmed = await this.deps.showConfirmationDialog(dialogContent);
        } catch {
          confirmed = false;
        } finally {
          this.isQuitDialogOpen = false;
        }
        if (!confirmed) {
          return;
        }
        await this.runShutdownAndQuit();
      })();
      this.pendingPromise = run.finally(() => {
        if (this.pendingPromise === run) {
          this.pendingPromise = null;
        }
      });
      return this.pendingPromise;
    }

    const run = this.runShutdownAndQuit();
    this.pendingPromise = run.finally(() => {
      if (this.pendingPromise === run) {
        this.pendingPromise = null;
      }
    });
    return this.pendingPromise;
  }

  /**
   * Programmatically requests an application quit (e.g. for applying a staged update).
   * Prompts with a confirmation dialog when worker tasks are running, invokes
   * `onConfirmedBeforeShutdown` only after confirmation passes, and runs clean shutdown.
   * Returns `true` if shutdown proceeded, or `false` if cancelled or busy.
   */
  public async requestQuit(options?: {
    dialogContent?: QuitConfirmationDialogContent;
    onConfirmedBeforeShutdown?: () => void;
  }): Promise<boolean> {
    if (this.isQuitConfirmed || this.isShuttingDown) {
      return true;
    }
    if (this.isQuitDialogOpen) {
      return false;
    }

    const runningTasks = this.deps.getRunningTasks();
    if (runningTasks.length > 0) {
      this.isQuitDialogOpen = true;
      const dialogContent = options?.dialogContent ?? buildQuitConfirmationDialog(runningTasks);
      let confirmed = false;
      try {
        confirmed = await this.deps.showConfirmationDialog(dialogContent);
      } catch {
        confirmed = false;
      } finally {
        this.isQuitDialogOpen = false;
      }
      if (!confirmed) {
        return false;
      }
    }

    options?.onConfirmedBeforeShutdown?.();
    await this.runShutdownAndQuit();
    return true;
  }

  private async runShutdownAndQuit(): Promise<void> {
    if (this.isShuttingDown || this.isQuitConfirmed) return;
    this.isShuttingDown = true;
    try {
      await this.deps.performShutdown();
    } catch {
      // Never block application quit if shutdown cleanup throws
    } finally {
      this.isQuitConfirmed = true;
      this.isShuttingDown = false;
      this.deps.quitApp();
    }
  }
}
