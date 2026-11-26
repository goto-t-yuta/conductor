import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardPaste,
  Copy,
  Loader2,
  Plus,
  RotateCw,
  Terminal as TerminalIcon,
  Trash2,
} from "lucide-react";
import { t, type UiLocale } from "../../shared/i18n.js";
import type { TerminalTab } from "../lib/right-pane-tabs.js";
import { terminalOutputStore } from "../lib/terminal-session-store.js";
import { detectDarkColorScheme, getConductorTerminalTheme } from "../lib/terminal-theme.js";

export interface TerminalPaneProps {
  tab: TerminalTab;
  isVisible: boolean;
  locale?: UiLocale;
  onRestart?: (tabId: string) => void;
  onNewTerminalTab?: () => void;
  onRevealInFinder?: (dirPath: string) => void;
}

interface XtermLike {
  cols: number;
  rows: number;
  options: { theme?: unknown };
  open(parent: HTMLElement): void;
  write(data: string): void;
  clear(): void;
  focus(): void;
  dispose(): void;
  hasSelection(): boolean;
  getSelection(): string;
  paste(data: string): void;
  loadAddon(addon: unknown): void;
  onData(listener: (data: string) => void): { dispose(): void };
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
}

interface FitAddonLike {
  fit(): void;
}

export const TerminalPane: React.FC<TerminalPaneProps> = React.memo(({
  tab,
  isVisible,
  locale = "ja",
  onRestart,
  onNewTerminalTab,
  onRevealInFinder,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermLike | null>(null);
  const fitAddonRef = useRef<FitAddonLike | null>(null);
  const lastSyncedSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const tabStatusRef = useRef(tab.status);
  const onRestartRef = useRef(onRestart);
  tabStatusRef.current = tab.status;
  onRestartRef.current = onRestart;

  const [copiedCwd, setCopiedCwd] = useState(false);
  const [copiedSelection, setCopiedSelection] = useState(false);

  const syncFitAndResize = useCallback(() => {
    const host = hostRef.current;
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!host || !term || !fitAddon) return;
    if (host.clientWidth < 24 || host.clientHeight < 24) return;

    try {
      fitAddon.fit();
    } catch {
      return;
    }

    const cols = term.cols;
    const rows = term.rows;
    if (cols < 2 || rows < 1) return;

    const prev = lastSyncedSizeRef.current;
    if (!prev || prev.cols !== cols || prev.rows !== rows) {
      lastSyncedSizeRef.current = { cols, rows };
      if (tabStatusRef.current === "running") {
        void window.conductor?.terminalResize?.(tab.id, cols, rows);
      }
    }
  }, [tab.id]);

  // Mount xterm.js + FitAddon lazily on client
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof window === "undefined") return;

    let disposed = false;
    let unsubData: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let rafId: number | null = null;
    let mediaQuery: MediaQueryList | null = null;
    let handleColorSchemeChange: ((e: MediaQueryListEvent) => void) | null = null;

    const scheduleFit = () => {
      if (disposed) return;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        syncFitAndResize();
      });
    };

    void (async () => {
      const [xtermMod, fitMod] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;

      const TerminalCtor =
        xtermMod.Terminal ?? (xtermMod as { default?: { Terminal?: typeof xtermMod.Terminal } }).default?.Terminal;
      const FitAddonCtor =
        fitMod.FitAddon ?? (fitMod as { default?: { FitAddon?: typeof fitMod.FitAddon } }).default?.FitAddon;
      if (!TerminalCtor || !FitAddonCtor) return;

      const isDark = detectDarkColorScheme();
      const term = new TerminalCtor({
        cursorBlink: true,
        cursorStyle: "bar",
        scrollback: 5000,
        fontSize: 12.5,
        lineHeight: 1.32,
        fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, monospace',
        theme: getConductorTerminalTheme(isDark),
        macOptionClickForcesSelection: true,
      }) as unknown as XtermLike;

      const fitAddon = new FitAddonCtor() as unknown as FitAddonLike;
      term.loadAddon(fitAddon);
      term.open(hostRef.current);

      terminalRef.current = term;
      fitAddonRef.current = fitAddon;
      lastSyncedSizeRef.current = null;

      // Copy / Paste / Clear keyboard shortcuts
      const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.type !== "keydown") return true;

        const key = ev.key.toLowerCase();
        const isCopyShortcut = isMac
          ? ev.metaKey && !ev.ctrlKey && !ev.altKey && key === "c"
          : ev.ctrlKey && ev.shiftKey && !ev.altKey && key === "c";
        if (isCopyShortcut) {
          if (term.hasSelection()) {
            const text = term.getSelection();
            if (text) {
              void navigator.clipboard?.writeText(text);
            }
            return false;
          }
          return !isMac;
        }

        const isPasteShortcut = isMac
          ? ev.metaKey && !ev.ctrlKey && !ev.altKey && key === "v"
          : ev.ctrlKey && ev.shiftKey && !ev.altKey && key === "v";
        if (isPasteShortcut) {
          void navigator.clipboard?.readText?.().then((text) => {
            if (text) term.paste(text);
          });
          return false;
        }

        const isClearShortcut = isMac
          ? ev.metaKey && !ev.ctrlKey && !ev.altKey && key === "k"
          : ev.ctrlKey && ev.shiftKey && !ev.altKey && key === "k";
        if (isClearShortcut) {
          term.clear();
          terminalOutputStore.clearBuffer(tab.id);
          return false;
        }

        return true;
      });

      // Replay buffered output (if remounted after switching projects or toggling pane)
      const buffered = terminalOutputStore.getSnapshot(tab.id);
      if (buffered) {
        term.write(buffered);
      }

      // Stream live PTY output
      unsubData = terminalOutputStore.subscribe(tab.id, (chunk) => {
        term.write(chunk);
      });

      // Send user keystrokes to PTY (or restart on Enter after exit)
      const dataDisp = term.onData((data) => {
        if (tabStatusRef.current === "exited") {
          if (data === "\r") {
            onRestartRef.current?.(tab.id);
          }
          return;
        }
        if (tabStatusRef.current !== "running") return;
        void window.conductor?.terminalWrite?.(tab.id, data);
      });

      // Observe container resizes
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          scheduleFit();
        });
        resizeObserver.observe(hostRef.current);
      }

      // Sync with OS light/dark theme switches
      if (typeof window.matchMedia === "function") {
        mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        handleColorSchemeChange = (e: MediaQueryListEvent) => {
          term.options.theme = getConductorTerminalTheme(e.matches);
        };
        mediaQuery.addEventListener("change", handleColorSchemeChange);
      }

      scheduleFit();
      if (isVisible) {
        term.focus();
      }

      // Store disposer on cleanup closure
      const origUnsub = unsubData;
      unsubData = () => {
        origUnsub?.();
        dataDisp.dispose();
      };
    })();

    return () => {
      disposed = true;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      if (mediaQuery && handleColorSchemeChange) {
        mediaQuery.removeEventListener("change", handleColorSchemeChange);
      }
      resizeObserver?.disconnect();
      unsubData?.();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastSyncedSizeRef.current = null;
    };
    // Intentionally keyed only by tab.id so switching visibility does not destroy xterm
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // Refit & focus when tab becomes visible
  useEffect(() => {
    if (!isVisible) return;
    const raf = window.requestAnimationFrame(() => {
      syncFitAndResize();
      terminalRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [isVisible, syncFitAndResize]);

  // Ensure initial PTY dimensions match actual fitted xterm dimensions once running
  useEffect(() => {
    if (tab.status !== "running") return;
    lastSyncedSizeRef.current = null;
    const raf = window.requestAnimationFrame(() => {
      syncFitAndResize();
      if (isVisible) {
        terminalRef.current?.focus();
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [tab.status, tab.pid, isVisible, syncFitAndResize]);

  const handleClear = () => {
    terminalRef.current?.clear();
    terminalOutputStore.clearBuffer(tab.id);
    terminalRef.current?.focus();
  };

  const handleCopySelection = () => {
    const term = terminalRef.current;
    if (!term) return;
    const selected = term.hasSelection() ? term.getSelection() : "";
    if (!selected) return;
    void navigator.clipboard?.writeText(selected);
    setCopiedSelection(true);
    setTimeout(() => setCopiedSelection(false), 1500);
    term.focus();
  };

  const handlePaste = () => {
    const term = terminalRef.current;
    if (!term || tab.status !== "running") return;
    void navigator.clipboard?.readText?.().then((text) => {
      if (text) {
        term.paste(text);
        term.focus();
      }
    });
  };

  const statusLabel =
    tab.status === "starting"
      ? t(locale, "terminal.statusStarting")
      : tab.status === "running"
        ? t(locale, "terminal.statusRunning")
        : tab.status === "error"
          ? t(locale, "terminal.statusError")
          : tab.exitCode !== null
            ? t(locale, "terminal.statusExited", { code: tab.exitCode })
            : t(locale, "terminal.statusExitedNoCode");

  const statusBadgeClass =
    tab.status === "running"
      ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
      : tab.status === "starting"
        ? "bg-indigo-500/12 text-indigo-700 dark:text-indigo-300"
        : tab.status === "error" || (tab.exitCode !== null && tab.exitCode !== 0)
          ? "bg-rose-500/12 text-rose-700 dark:text-rose-300"
          : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300";

  return (
    <div
      data-testid="terminal-pane"
      data-terminal-id={tab.id}
      data-terminal-status={tab.status}
      aria-label={t(locale, "terminal.ariaLabel", { title: tab.title })}
      className={isVisible ? "flex-1 flex flex-col min-h-0 min-w-0" : "hidden"}
    >
      {/* Toolbar & Session Meta Header */}
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-zinc-100/70 dark:bg-[#171b24] border-b border-zinc-200/70 dark:border-zinc-800/80 text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {tab.status === "starting" ? (
            <Loader2 className="w-3.5 h-3.5 text-violet-500 animate-spin shrink-0" />
          ) : (
            <TerminalIcon className="w-3.5 h-3.5 text-violet-500 shrink-0" />
          )}
          <span
            className="font-semibold text-zinc-800 dark:text-zinc-100 truncate"
            title={tab.shell || tab.title}
          >
            {tab.title}
          </span>
          <span
            data-testid="terminal-status-badge"
            className={`px-1.5 py-0.25 rounded text-[10px] font-medium shrink-0 whitespace-nowrap ${statusBadgeClass}`}
          >
            {statusLabel}
          </span>
          {tab.backend && tab.backend !== "node-pty" && (
            <span
              data-testid="terminal-fallback-badge"
              title={t(locale, "terminal.fallbackBanner", { backend: tab.backend })}
              className="hidden sm:inline px-1.5 py-0.25 rounded bg-amber-500/12 text-amber-700 dark:text-amber-300 text-[10px] font-medium shrink-0 whitespace-nowrap"
            >
              {tab.backend}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            data-testid="terminal-copy-btn"
            onClick={handleCopySelection}
            title={t(locale, "terminal.copyTitle")}
            aria-label={t(locale, "terminal.copyTitle")}
            className="p-1 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            {copiedSelection ? (
              <Check className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            data-testid="terminal-paste-btn"
            onClick={handlePaste}
            disabled={tab.status !== "running"}
            title={t(locale, "terminal.pasteTitle")}
            aria-label={t(locale, "terminal.pasteTitle")}
            className="p-1 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-40 transition-colors cursor-pointer"
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            data-testid="terminal-clear-btn"
            onClick={handleClear}
            title={t(locale, "terminal.clearTitle")}
            aria-label={t(locale, "terminal.clearTitle")}
            className="p-1 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          {onRestart && (
            <button
              type="button"
              data-testid="terminal-restart-btn"
              onClick={() => onRestart(tab.id)}
              title={t(locale, "terminal.restartTitle")}
              aria-label={t(locale, "terminal.restartTitle")}
              className="p-1 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <RotateCw className="w-3.5 h-3.5" />
            </button>
          )}
          {onNewTerminalTab && (
            <button
              type="button"
              data-testid="terminal-toolbar-new-btn"
              onClick={onNewTerminalTab}
              title={t(locale, "terminal.newTabTitle")}
              aria-label={t(locale, "terminal.newTabTitle")}
              className="p-1 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Working Directory Sub-bar */}
      {tab.cwd && (
        <div className="flex items-center justify-between gap-2 px-3 py-1 text-[10.5px] font-mono text-zinc-400 bg-zinc-50/80 dark:bg-[#12151c] border-b border-zinc-200/60 dark:border-zinc-800/70 shrink-0">
          <span title={tab.cwd} className="truncate min-w-0">
            {tab.cwd}
          </span>
          <div className="flex items-center gap-1.5 shrink-0 font-sans">
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(tab.cwd);
                setCopiedCwd(true);
                setTimeout(() => setCopiedCwd(false), 1500);
              }}
              title={t(locale, "common.copyPathWith", { path: tab.cwd })}
              aria-label={t(locale, "common.copyPath")}
              className="inline-flex items-center p-0.5 rounded hover:bg-zinc-200/80 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              {copiedCwd ? (
                <Check className="w-3 h-3 text-emerald-500" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
            {onRevealInFinder && (
              <button
                type="button"
                onClick={() => onRevealInFinder(tab.cwd)}
                title={t(locale, "common.revealInFinder")}
                className="text-[10.5px] hover:text-indigo-500 hover:underline cursor-pointer whitespace-nowrap"
              >
                {t(locale, "common.finder")}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Exited Banner */}
      {tab.status === "exited" && (
        <div
          data-testid="terminal-exited-banner"
          className="flex items-center justify-between gap-2 px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-[11.5px] text-amber-800 dark:text-amber-200 shrink-0 min-w-0"
        >
          <span className="truncate">
            {tab.exitCode !== null
              ? t(locale, "terminal.exitedNotice", { code: tab.exitCode })
              : t(locale, "terminal.exitedNoticeNoCode")}
          </span>
          {onRestart && (
            <button
              type="button"
              onClick={() => onRestart(tab.id)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors shrink-0 whitespace-nowrap cursor-pointer"
            >
              <RotateCw className="w-3 h-3" />
              <span>{t(locale, "terminal.restartBtn")}</span>
            </button>
          )}
        </div>
      )}

      {/* Terminal Viewport or Start Error State */}
      <div className="relative flex-1 min-h-0 min-w-0 bg-white dark:bg-[#0f1115] overflow-hidden">
        {tab.status === "error" ? (
          <div
            data-testid="terminal-error-state"
            className="h-full flex flex-col items-center justify-center p-6 text-center space-y-3"
          >
            <div className="w-11 h-11 rounded-2xl bg-rose-500/12 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-rose-500" />
            </div>
            <div className="space-y-1 max-w-sm">
              <div className="text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                {t(locale, "terminal.startFailed")}
              </div>
              {tab.error && (
                <div className="text-[12px] text-zinc-500 dark:text-zinc-400 break-words">
                  {tab.error}
                </div>
              )}
            </div>
            {onRestart && (
              <button
                type="button"
                onClick={() => onRestart(tab.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>{t(locale, "common.retry")}</span>
              </button>
            )}
          </div>
        ) : (
          <div
            ref={hostRef}
            data-testid="terminal-xterm-host"
            onClick={() => terminalRef.current?.focus()}
            className="conductor-terminal-host w-full h-full p-2 box-border"
          />
        )}
      </div>
    </div>
  );
});
