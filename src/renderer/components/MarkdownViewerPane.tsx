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
  RotateCw,
  X,
} from "lucide-react";
import {
  computeDocumentStats,
  extractMarkdownHeadings,
  formatByteSize,
  slugifyHeading,
} from "../lib/markdown-utils.js";
import type { MarkdownViewerTab } from "../lib/right-pane-tabs.js";
import { MarkdownView } from "./MarkdownView.js";

export type { MarkdownViewerTab };

export interface MarkdownViewerPaneProps {
  activeTab: MarkdownViewerTab | null;
  recentFiles: string[];
  autoReload: boolean;
  isWatching: boolean;
  justReloadedAt: number | null;
  pendingAnchor: string | null;
  onClearPendingAnchor: () => void;
  onToggleAutoReload: () => void;
  onOpenDialog: () => void;
  onOpenFile: (pathOrUrl: string, baseFilePath?: string) => void;
  onRefreshActive: () => void;
  onRemoveRecent: (filePath: string) => void;
  onOpenUrl: (url: string) => void;
  onAttachFileToChat: (filePath: string, fileName: string) => void;
  onRevealInFinder: (filePath: string) => void;
}

const HEADING_ID_PREFIX = "md-viewer-h-";

export const MarkdownViewerPane: React.FC<MarkdownViewerPaneProps> = ({
  activeTab,
  recentFiles,
  autoReload,
  isWatching,
  justReloadedAt,
  pendingAnchor,
  onClearPendingAnchor,
  onToggleAutoReload,
  onOpenDialog,
  onOpenFile,
  onRefreshActive,
  onRemoveRecent,
  onOpenUrl,
  onAttachFileToChat,
  onRevealInFinder,
}) => {
  const [pathInput, setPathInput] = useState(activeTab?.filePath ?? "");
  const [viewMode, setViewMode] = useState<"rendered" | "raw">("rendered");
  const [showToc, setShowToc] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);
  const [showReloadPulse, setShowReloadPulse] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPathInput(activeTab?.filePath ?? "");
  }, [activeTab?.filePath]);

  useEffect(() => {
    if (!justReloadedAt) return;
    setShowReloadPulse(true);
    const timer = setTimeout(() => setShowReloadPulse(false), 1800);
    return () => clearTimeout(timer);
  }, [justReloadedAt]);

  const content = activeTab?.document?.content ?? "";

  const headings = useMemo(() => extractMarkdownHeadings(content), [content]);
  const stats = useMemo(() => computeDocumentStats(content), [content]);

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

  const rawLines = useMemo(
    () => (viewMode === "raw" ? content.split(/\r?\n/) : []),
    [content, viewMode],
  );

  const formattedUpdatedTime = activeTab?.document
    ? new Date(activeTab.document.mtimeMs).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Path Input & Viewer Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0">
        <button
          type="button"
          onClick={onOpenDialog}
          title="ファイルを選択して開く (⌘⌥O)"
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
            placeholder="/path/to/README.md や file:// URL を入力..."
            className="w-full px-2.5 py-1 rounded-lg text-[12px] font-mono bg-white dark:bg-[#0f1115] border border-zinc-200 dark:border-zinc-800 focus:border-indigo-500/60 outline-none select-text"
          />
        </form>

        {/* Rendered / Raw Segmented Toggle */}
        <div className="inline-flex items-center p-0.5 rounded-md bg-zinc-200/70 dark:bg-zinc-800 shrink-0">
          <button
            type="button"
            onClick={() => setViewMode("rendered")}
            title="Rendered プレビュー"
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
            onClick={() => setViewMode("raw")}
            title="Raw Markdown ソース"
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
          title={headings.length > 0 ? `見出しアウトライン (${headings.length})` : "見出しがありません"}
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
          title={autoReload ? "ライブ自動更新: ON（クリックで一時停止）" : "ライブ自動更新: OFF（クリックで再開）"}
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
          onClick={onRefreshActive}
          disabled={!activeTab}
          title="手動で再読み込み"
          className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 disabled:opacity-35 cursor-pointer"
        >
          <RotateCw className={`w-3.5 h-3.5 ${activeTab?.isLoading ? "animate-spin" : ""}`} />
        </button>

        {/* Attach file ref to chat */}
        {activeTab && (
          <button
            type="button"
            onClick={() => onAttachFileToChat(activeTab.filePath, activeTab.fileName)}
            title="このファイルをチャットに添付"
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
            <span className="font-semibold text-zinc-700 dark:text-zinc-200 truncate">
              {activeTab.fileName}
            </span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(activeTab.filePath);
                setCopiedPath(true);
                setTimeout(() => setCopiedPath(false), 1500);
              }}
              title="パスをコピー"
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
              title="Finder で表示"
              className="text-[10.5px] hover:text-indigo-500 hover:underline cursor-pointer shrink-0"
            >
              Finder
            </button>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {activeTab.document && (
              <>
                <span className="hidden sm:inline">
                  {stats.lines}行 · {formatByteSize(activeTab.document.sizeBytes)}
                </span>
                {formattedUpdatedTime && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formattedUpdatedTime}
                  </span>
                )}
              </>
            )}
            {showReloadPulse ? (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
                更新済み
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
                  ローカルの <code className="font-mono">.md</code> /{" "}
                  <code className="font-mono">.markdown</code> ファイルをリアルタイム自動更新・見出しアウトライン付きで閲覧できます。
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
                    最近開いたファイル
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
                            title="履歴から削除"
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

            {/* Document Content Scroll Area */}
            <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-w-0">
              {activeTab.error && (
                <div className="flex items-center gap-2 px-4 py-2.5 text-[12px] bg-rose-500/10 text-rose-600 dark:text-rose-400 border-b border-rose-500/20">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span className="flex-1">{activeTab.error}</span>
                  <button
                    type="button"
                    onClick={onRefreshActive}
                    className="px-2 py-0.5 rounded bg-rose-500/15 hover:bg-rose-500/25 font-medium cursor-pointer shrink-0"
                  >
                    再試行
                  </button>
                </div>
              )}

              {activeTab.document ? (
                viewMode === "rendered" ? (
                  <article className="max-w-[760px] mx-auto px-6 py-6">
                    <MarkdownView
                      content={activeTab.document.content}
                      variant="document"
                      baseFilePath={activeTab.filePath}
                      headingIdPrefix={HEADING_ID_PREFIX}
                      onOpenUrl={onOpenUrl}
                      onOpenMarkdownFile={onOpenFile}
                      onScrollToHeading={scrollToHeading}
                    />
                  </article>
                ) : (
                  <div className="p-4">
                    <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50 dark:bg-[#14171f] overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 bg-zinc-100/80 dark:bg-zinc-900/80 border-b border-zinc-200/70 dark:border-zinc-800">
                        <span className="font-mono">
                          Raw Markdown ({stats.lines} lines · {stats.words} words)
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            void navigator.clipboard.writeText(activeTab.document?.content ?? "");
                            setCopiedRaw(true);
                            setTimeout(() => setCopiedRaw(false), 1500);
                          }}
                          className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 cursor-pointer"
                        >
                          {copiedRaw ? (
                            <Check className="w-3 h-3 text-emerald-500" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                          <span>{copiedRaw ? "Copied" : "Copy Raw"}</span>
                        </button>
                      </div>
                      <div className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed select-text">
                        {rawLines.map((line, idx) => (
                          <div key={idx} className="flex gap-3">
                            <span className="w-9 text-right text-zinc-400/70 dark:text-zinc-600 select-none shrink-0">
                              {idx + 1}
                            </span>
                            <span className="whitespace-pre text-zinc-800 dark:text-zinc-200 flex-1">
                              {line || " "}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              ) : activeTab.isLoading ? (
                <div className="h-full flex items-center justify-center text-[12.5px] text-zinc-400">
                  読み込み中...
                </div>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
