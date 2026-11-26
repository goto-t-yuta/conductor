import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  Clock,
  Code2,
  Copy,
  Eye,
  FileText,
  FolderOpen,
  List,
  MessageSquarePlus,
  Radio,
  RotateCcw,
  RotateCw,
  Save,
  X,
} from "lucide-react";
import {
  applyTextareaIndent,
  getEffectiveMarkdownContent,
} from "../lib/markdown-editor-state.js";
import { invalidateMarkdownImageCache } from "../lib/markdown-image-cache.js";
import {
  computeDocumentStats,
  extractMarkdownHeadings,
  formatByteSize,
  slugifyHeading,
} from "../lib/markdown-utils.js";
import type { MarkdownViewerTab } from "../lib/right-pane-tabs.js";
import { t, type UiLocale } from "../../shared/i18n.js";
import { MarkdownView, type MarkdownOpenedImage } from "./MarkdownView.js";

export type { MarkdownViewerTab };

export interface MarkdownViewerPaneProps {
  activeTab: MarkdownViewerTab | null;
  recentFiles: string[];
  autoReload: boolean;
  isWatching: boolean;
  justReloadedAt: number | null;
  pendingAnchor: string | null;
  locale?: UiLocale;
  onClearPendingAnchor: () => void;
  onToggleAutoReload: () => void;
  onOpenDialog: () => void;
  onOpenFile: (pathOrUrl: string, baseFilePath?: string) => void;
  onRefreshActive: () => void;
  onRemoveRecent: (filePath: string) => void;
  onOpenUrl: (url: string) => void;
  onOpenImage?: (image: MarkdownOpenedImage) => void;
  onAttachFileToChat: (filePath: string, fileName: string) => void;
  onRevealInFinder: (filePath: string) => void;
  onDraftChange?: (filePath: string, nextContent: string) => void;
  onSaveActive?: () => Promise<void> | void;
  onDiscardActive?: () => Promise<void> | void;
  onReloadExternalChange?: () => Promise<void> | void;
  onDismissExternalChange?: () => void;
  onChangeViewMode?: (filePath: string, mode: "rendered" | "raw") => void;
  initialViewMode?: "rendered" | "raw";
}

const HEADING_ID_PREFIX = "md-viewer-h-";

export const MarkdownViewerPane: React.FC<MarkdownViewerPaneProps> = ({
  activeTab,
  recentFiles,
  autoReload,
  isWatching,
  justReloadedAt,
  pendingAnchor,
  locale = "ja",
  onClearPendingAnchor,
  onToggleAutoReload,
  onOpenDialog,
  onOpenFile,
  onRefreshActive,
  onRemoveRecent,
  onOpenUrl,
  onOpenImage,
  onAttachFileToChat,
  onRevealInFinder,
  onDraftChange,
  onSaveActive,
  onDiscardActive,
  onReloadExternalChange,
  onDismissExternalChange,
  onChangeViewMode,
  initialViewMode = "rendered",
}) => {
  const [pathInput, setPathInput] = useState(activeTab?.filePath ?? "");
  const [localViewMode, setLocalViewMode] = useState<"rendered" | "raw">(initialViewMode);
  const [showToc, setShowToc] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);
  const [showReloadPulse, setShowReloadPulse] = useState(false);
  const [showSavedPulse, setShowSavedPulse] = useState(false);
  const [imageReloadVersion, setImageReloadVersion] = useState(0);

  const viewMode = activeTab?.viewMode ?? localViewMode;
  const setViewMode = (mode: "rendered" | "raw") => {
    setLocalViewMode(mode);
    if (activeTab && onChangeViewMode) {
      onChangeViewMode(activeTab.filePath, mode);
    }
  };

  const isDirty = Boolean(activeTab?.isDirty);
  const isSaving = Boolean(activeTab?.isSaving);
  const canSave = Boolean(
    activeTab?.document && !isSaving && (isDirty || activeTab.deletedOnDisk),
  );

  const handleManualRefresh = () => {
    invalidateMarkdownImageCache();
    setImageReloadVersion((v) => v + 1);
    onRefreshActive();
  };

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onSaveActiveRef = useRef(onSaveActive);
  onSaveActiveRef.current = onSaveActive;

  useEffect(() => {
    setPathInput(activeTab?.filePath ?? "");
  }, [activeTab?.filePath]);

  useEffect(() => {
    if (!justReloadedAt) return;
    setShowReloadPulse(true);
    const timer = setTimeout(() => setShowReloadPulse(false), 1800);
    return () => clearTimeout(timer);
  }, [justReloadedAt]);

  useEffect(() => {
    if (!activeTab?.lastSavedAt) {
      setShowSavedPulse(false);
      return;
    }
    setShowSavedPulse(true);
    const timer = setTimeout(() => setShowSavedPulse(false), 2000);
    return () => clearTimeout(timer);
  }, [activeTab?.filePath, activeTab?.lastSavedAt]);

  // Global Cmd+S / Ctrl+S shortcut while this Markdown tab is active
  useEffect(() => {
    if (!activeTab?.document) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        if (viewMode === "raw" || isDirty || activeTab.deletedOnDisk) {
          e.preventDefault();
          if ((isDirty || activeTab.deletedOnDisk) && !isSaving) {
            void onSaveActiveRef.current?.();
          }
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab?.filePath, activeTab?.document, activeTab?.deletedOnDisk, viewMode, isDirty, isSaving]);

  const content = getEffectiveMarkdownContent(activeTab);

  const headings = useMemo(() => extractMarkdownHeadings(content), [content]);
  const stats = useMemo(() => computeDocumentStats(content), [content]);
  const effectiveByteSize = useMemo(() => {
    if (!activeTab?.document) return 0;
    if (!isDirty) return activeTab.document.sizeBytes;
    return new TextEncoder().encode(content).byteLength;
  }, [activeTab?.document, isDirty, content]);

  const scrollToHeading = (rawId: string) => {
    if (viewMode === "raw") {
      setViewMode("rendered");
    }
    const normalized = slugifyHeading(rawId);
    requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      const directEl =
        document.getElementById(`${HEADING_ID_PREFIX}${rawId}`) ??
        document.getElementById(`${HEADING_ID_PREFIX}${normalized}`);
      if (directEl) {
        directEl.scrollIntoView({ behavior: "smooth", block: "start" });
        setActiveHeadingId(directEl.id.replace(HEADING_ID_PREFIX, ""));
      } else if (container && /^L(\d+)/i.test(rawId)) {
        const lineNum = Number.parseInt(rawId.slice(1), 10);
        if (!Number.isNaN(lineNum) && stats.lines > 0) {
          const ratio = Math.min(1, Math.max(0, (lineNum - 1) / stats.lines));
          container.scrollTo({ top: container.scrollHeight * ratio, behavior: "smooth" });
        }
      }
    });
  };

  useEffect(() => {
    if (!pendingAnchor || !activeTab?.document) return;
    scrollToHeading(pendingAnchor);
    onClearPendingAnchor();
  }, [pendingAnchor, activeTab?.filePath, activeTab?.document?.mtimeMs]);

  const formattedUpdatedTime = activeTab?.document
    ? new Date(activeTab.document.mtimeMs).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      if (canSave) {
        void onSaveActive?.();
      }
      return;
    }

    if (e.key === "Tab" && activeTab && onDraftChange) {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const result = applyTextareaIndent(content, start, end, e.shiftKey);
      onDraftChange(activeTab.filePath, result.value);
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = result.selectionStart;
          textareaRef.current.selectionEnd = result.selectionEnd;
        }
      });
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Path Input & Viewer Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0">
        <button
          type="button"
          onClick={onOpenDialog}
          title={t(locale, "markdown.openFileTitle")}
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
        >
          <FolderOpen className="w-3.5 h-3.5" />
        </button>

        <form
          className="flex-1 min-w-0"
          onSubmit={(e) => {
            e.preventDefault();
            if (pathInput.trim()) onOpenFile(pathInput.trim());
          }}
        >
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            placeholder={t(locale, "markdown.pathPlaceholder")}
            className="w-full px-2.5 py-1 rounded-lg text-[12px] font-mono bg-white dark:bg-[#0f1115] border border-zinc-200 dark:border-zinc-800 focus:border-indigo-500/60 outline-none select-text"
          />
        </form>

        {/* Rendered / Raw Segmented Toggle */}
        <div className="inline-flex items-center p-0.5 rounded-md bg-zinc-200/70 dark:bg-zinc-800 shrink-0">
          <button
            type="button"
            data-testid="markdown-mode-rendered-btn"
            onClick={() => setViewMode("rendered")}
            title={t(locale, "markdown.renderedTitle")}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
              viewMode === "rendered"
                ? "bg-white dark:bg-[#1d222d] text-zinc-900 dark:text-zinc-100 shadow-xs"
                : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            <Eye className="w-3 h-3" />
          </button>
          <button
            type="button"
            data-testid="markdown-mode-raw-btn"
            onClick={() => setViewMode("raw")}
            title={t(locale, "markdown.rawTitle")}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium transition-colors cursor-pointer ${
              viewMode === "raw"
                ? "bg-white dark:bg-[#1d222d] text-zinc-900 dark:text-zinc-100 shadow-xs"
                : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            }`}
          >
            <Code2 className="w-3 h-3" />
          </button>
        </div>

        {/* TOC Toggle */}
        <button
          type="button"
          onClick={() => setShowToc((v) => !v)}
          disabled={!activeTab?.document || headings.length === 0}
          title={
            headings.length > 0
              ? t(locale, "markdown.tocTitle", { count: headings.length })
              : t(locale, "markdown.noHeadingsTitle")
          }
          className={`inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[11px] transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed ${
            showToc && headings.length > 0
              ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
              : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
          }`}
        >
          <List className="w-3.5 h-3.5" />
          {headings.length > 0 && <span className="text-[10px] font-medium">{headings.length}</span>}
        </button>

        {/* Auto-Reload Toggle */}
        <button
          type="button"
          onClick={onToggleAutoReload}
          title={
            autoReload
              ? t(locale, "markdown.autoReloadOnTitle")
              : t(locale, "markdown.autoReloadOffTitle")
          }
          className={`p-1.5 rounded-md transition-colors cursor-pointer ${
            autoReload
              ? isWatching
                ? "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20"
                : "text-indigo-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
              : "text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
          }`}
        >
          <Radio className="w-3.5 h-3.5" />
        </button>

        {/* Manual Refresh */}
        <button
          type="button"
          onClick={handleManualRefresh}
          disabled={!activeTab}
          title={isDirty ? t(locale, "markdown.checkDiskTitle") : t(locale, "markdown.manualReloadTitle")}
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-35 cursor-pointer"
        >
          <RotateCw className={`w-3.5 h-3.5 ${activeTab?.isLoading ? "animate-spin" : ""}`} />
        </button>

        {/* Attach file ref to chat */}
        {activeTab && (
          <button
            type="button"
            onClick={() => onAttachFileToChat(activeTab.filePath, activeTab.fileName)}
            title={t(locale, "markdown.attachFileTitle")}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 cursor-pointer"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Document Meta Header Strip */}
      {activeTab && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] bg-zinc-100/70 dark:bg-[#171b24] border-b border-zinc-200/70 dark:border-zinc-800/80 text-zinc-500 dark:text-zinc-400 shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            {isDirty && (
              <span
                data-testid="markdown-dirty-indicator"
                title={t(locale, "rightPane.unsavedChanges")}
                className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium shrink-0"
              >
                <span aria-hidden="true">●</span>
              </span>
            )}
            <span className="font-semibold text-zinc-700 dark:text-zinc-200 truncate">
              {activeTab.fileName}
            </span>
            {isDirty && (
              <span className="px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-[10px] font-medium shrink-0">
                {t(locale, "markdown.unsavedBadge")}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(activeTab.filePath);
                setCopiedPath(true);
                setTimeout(() => setCopiedPath(false), 1500);
              }}
              title={t(locale, "common.copyPath")}
              className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded hover:bg-zinc-200/80 dark:hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
            >
              {copiedPath ? (
                <Check className="w-3 h-3 text-emerald-500" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onRevealInFinder(activeTab.filePath)}
              title={t(locale, "common.revealInFinder")}
              className="text-[10.5px] hover:text-indigo-500 hover:underline cursor-pointer shrink-0"
            >
              {t(locale, "common.finder")}
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {activeTab.document && (isDirty || viewMode === "raw") && (
              <div className="inline-flex items-center gap-1">
                {isDirty && onDiscardActive && (
                  <button
                    type="button"
                    data-testid="markdown-discard-btn"
                    onClick={() => void onDiscardActive()}
                    disabled={isSaving}
                    title={t(locale, "markdown.discardTitle")}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium text-zinc-600 dark:text-zinc-300 bg-zinc-200/70 dark:bg-zinc-800 hover:bg-zinc-300/80 dark:hover:bg-zinc-700 disabled:opacity-40 transition-colors cursor-pointer"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>{t(locale, "markdown.discardBtn")}</span>
                  </button>
                )}
                {onSaveActive && (
                  <button
                    type="button"
                    data-testid="markdown-save-btn"
                    onClick={() => void onSaveActive()}
                    disabled={!canSave}
                    title={t(locale, "markdown.saveTitle")}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10.5px] font-medium transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                      canSave
                        ? "bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs"
                        : "bg-zinc-200/70 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400"
                    }`}
                  >
                    <Save className="w-3 h-3" />
                    <span>
                      {isSaving ? t(locale, "markdown.savingBtn") : t(locale, "markdown.saveBtn")}
                    </span>
                  </button>
                )}
              </div>
            )}

            {activeTab.document && (
              <>
                <span className="hidden sm:inline">
                  {t(locale, "markdown.linesCount", { count: stats.lines })} ·{" "}
                  {formatByteSize(effectiveByteSize)}
                </span>
                {formattedUpdatedTime && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formattedUpdatedTime}
                  </span>
                )}
              </>
            )}

            {showSavedPulse ? (
              <span
                data-testid="markdown-saved-feedback"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium"
              >
                <Check className="w-2.5 h-2.5" />
                {t(locale, "markdown.savedFeedback")}
              </span>
            ) : showReloadPulse ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                {t(locale, "markdown.reloadedFeedback")}
              </span>
            ) : autoReload && isWatching ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live
              </span>
            ) : null}
          </div>
        </div>
      )}

      {/* Main Viewer Body */}
      <div className="flex-1 flex min-h-0 bg-white dark:bg-[#0f1115] overflow-hidden">
        {!activeTab ? (
          <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center p-6 text-center">
            <div className="max-w-sm w-full space-y-5">
              <div className="mx-auto w-12 h-12 rounded-2xl bg-indigo-500/12 flex items-center justify-center">
                <BookOpen className="w-6 h-6 text-indigo-500" />
              </div>
              <div className="space-y-1.5">
                <h2 className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
                  Local Markdown Viewer
                </h2>
                <p className="text-[12px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                  {t(locale, "markdown.emptyDescBefore")}
                  <code className="font-mono">.md</code> /{" "}
                  <code className="font-mono">.markdown</code>
                  {t(locale, "markdown.emptyDescAfter")}
                </p>
              </div>

              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={onOpenDialog}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-[12.5px] font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs transition-colors cursor-pointer"
                >
                  <FolderOpen className="w-4 h-4" />
                  <span>Open .md File...</span>
                </button>
              </div>

              {recentFiles.length > 0 && (
                <div className="text-left pt-2 space-y-1.5">
                  <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 px-1">
                    {t(locale, "markdown.recentFilesHeader")}
                  </div>
                  <div className="space-y-1">
                    {recentFiles.slice(0, 6).map((filePath) => {
                      const baseName = filePath.split(/[/\\]/).pop() || filePath;
                      return (
                        <div
                          key={filePath}
                          onClick={() => onOpenFile(filePath)}
                          title={filePath}
                          className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-zinc-200/70 dark:border-zinc-800/80 bg-zinc-50/70 dark:bg-[#161a22] hover:border-indigo-500/40 cursor-pointer transition-colors"
                        >
                          <FileText className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="text-[12px] font-medium text-zinc-800 dark:text-zinc-200 truncate">
                              {baseName}
                            </div>
                            <div className="text-[10.5px] font-mono text-zinc-400 truncate">
                              {filePath}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemoveRecent(filePath);
                            }}
                            title={t(locale, "rightPane.removeFromHistory")}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-400 hover:text-rose-500 cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* Collapsible TOC / Outline Drawer */}
            {showToc && headings.length > 0 && (
              <aside className="w-52 shrink-0 border-r border-zinc-200/70 dark:border-zinc-800/80 bg-zinc-50/60 dark:bg-[#12151b] overflow-y-auto p-2.5 space-y-1">
                <div className="flex items-center justify-between px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                  <span>Outline</span>
                  <button
                    type="button"
                    onClick={() => setShowToc(false)}
                    className="p-0.5 rounded hover:bg-zinc-200/70 dark:hover:bg-zinc-800 cursor-pointer"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
                {headings.map((h) => {
                  const indent = Math.max(0, h.level - 1) * 10;
                  const isActive = activeHeadingId === h.id;
                  return (
                    <button
                      key={`${h.id}-${h.line}`}
                      type="button"
                      onClick={() => scrollToHeading(h.id)}
                      style={{ paddingLeft: `${8 + indent}px` }}
                      title={h.text}
                      className={`w-full text-left pr-2 py-1 rounded-md text-[11.5px] leading-snug truncate transition-colors cursor-pointer block ${
                        isActive
                          ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 font-medium"
                          : "text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/70 hover:text-zinc-900 dark:hover:text-zinc-100"
                      }`}
                    >
                      {h.text}
                    </button>
                  );
                })}
              </aside>
            )}

            {/* Document Content Area */}
            <div className="flex-1 flex flex-col min-w-0 min-h-0">
              {/* Non-destructive External Change Banner when dirty */}
              {activeTab.externalChange && (
                <div
                  data-testid="markdown-external-change-banner"
                  className="flex items-center gap-2 px-3.5 py-2 text-[11.5px] bg-amber-500/12 text-amber-800 dark:text-amber-300 border-b border-amber-500/25 shrink-0"
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <span className="flex-1 min-w-0">
                    {activeTab.externalChange.kind === "deleted"
                      ? t(locale, "markdown.externalDeleted")
                      : t(locale, "markdown.externalChanged")}
                  </span>
                  {activeTab.externalChange.kind === "changed" && onReloadExternalChange && (
                    <button
                      type="button"
                      data-testid="markdown-external-reload-btn"
                      onClick={() => void onReloadExternalChange()}
                      className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 font-medium cursor-pointer shrink-0 transition-colors"
                    >
                      {t(locale, "common.reload")}
                    </button>
                  )}
                  {onDismissExternalChange && (
                    <button
                      type="button"
                      onClick={onDismissExternalChange}
                      title={t(locale, "markdown.dismissBanner")}
                      aria-label={t(locale, "markdown.dismissBanner")}
                      className="p-0.5 rounded hover:bg-amber-500/20 cursor-pointer shrink-0"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              )}

              {/* Save Error Banner */}
              {activeTab.saveError && (
                <div
                  data-testid="markdown-save-error-banner"
                  className="flex items-center gap-2 px-4 py-2 text-[12px] bg-rose-500/10 text-rose-600 dark:text-rose-400 border-b border-rose-500/20 shrink-0"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{activeTab.saveError}</span>
                  {onSaveActive && (
                    <button
                      type="button"
                      onClick={() => void onSaveActive()}
                      className="px-2 py-0.5 rounded bg-rose-500/15 hover:bg-rose-500/25 font-medium cursor-pointer shrink-0"
                    >
                      {t(locale, "markdown.retrySave")}
                    </button>
                  )}
                </div>
              )}

              {/* Read Error Banner */}
              {activeTab.error && (
                <div className="flex items-center gap-2 px-4 py-2.5 text-[12px] bg-rose-500/10 text-rose-600 dark:text-rose-400 border-b border-rose-500/20 shrink-0">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{activeTab.error}</span>
                  <button
                    type="button"
                    onClick={onRefreshActive}
                    className="px-2 py-0.5 rounded bg-rose-500/15 hover:bg-rose-500/25 font-medium cursor-pointer shrink-0"
                  >
                    {t(locale, "common.retry")}
                  </button>
                </div>
              )}

              {activeTab.document ? (
                viewMode === "rendered" ? (
                  <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-w-0">
                    <article className="max-w-[760px] mx-auto px-6 py-6">
                      <MarkdownView
                        content={content}
                        locale={locale}
                        variant="document"
                        baseFilePath={activeTab.filePath}
                        headingIdPrefix={HEADING_ID_PREFIX}
                        imageReloadVersion={imageReloadVersion}
                        onOpenUrl={onOpenUrl}
                        onOpenMarkdownFile={onOpenFile}
                        onOpenImage={onOpenImage}
                        onScrollToHeading={scrollToHeading}
                      />
                    </article>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col min-h-0 p-3">
                    <div className="flex-1 flex flex-col min-h-0 rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50 dark:bg-[#14171f] overflow-hidden focus-within:border-indigo-500/50 transition-colors">
                      <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 bg-zinc-100/80 dark:bg-zinc-900/80 border-b border-zinc-200/70 dark:border-zinc-800 shrink-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono truncate">
                            Markdown Source ({stats.lines} lines · {stats.words} words)
                          </span>
                          <span className="hidden md:inline text-[10px] text-zinc-400">
                            {t(locale, "markdown.editorHint")}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(content);
                            setCopiedRaw(true);
                            setTimeout(() => setCopiedRaw(false), 1500);
                          }}
                          className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer shrink-0"
                        >
                          {copiedRaw ? (
                            <Check className="w-3 h-3 text-emerald-500" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                          <span>{copiedRaw ? "Copied" : "Copy Raw"}</span>
                        </button>
                      </div>
                      <textarea
                        ref={textareaRef}
                        data-testid="markdown-source-editor"
                        aria-label={t(locale, "markdown.editorAria", {
                          fileName: activeTab.fileName,
                        })}
                        value={content}
                        onChange={(e) => onDraftChange?.(activeTab.filePath, e.target.value)}
                        onKeyDown={handleTextareaKeyDown}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        className="flex-1 w-full min-h-0 p-3.5 bg-transparent font-mono text-[12.5px] leading-[1.65] text-zinc-800 dark:text-zinc-200 outline-none resize-none overflow-y-auto select-text whitespace-pre-wrap break-words"
                      />
                    </div>
                  </div>
                )
              ) : activeTab.isLoading ? (
                <div className="flex-1 flex items-center justify-center text-[12.5px] text-zinc-400">
                  {t(locale, "common.loading")}
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
