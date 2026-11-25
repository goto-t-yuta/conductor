import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  FileCode2,
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  RotateCw,
  WrapText,
} from "lucide-react";
import { formatByteSize } from "../lib/markdown-utils.js";
import type { CodeViewerTab } from "../lib/right-pane-tabs.js";

export type { CodeViewerTab };

export interface CodeViewerPaneProps {
  activeTab: CodeViewerTab | null;
  onRefreshActive: () => void;
  onRevealInFinder: (filePath: string) => void;
  onAttachFileToChat?: (filePath: string, fileName: string) => void;
}

export const CodeViewerPane: React.FC<CodeViewerPaneProps> = ({
  activeTab,
  onRefreshActive,
  onRevealInFinder,
  onAttachFileToChat,
}) => {
  const [wrapLines, setWrapLines] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [copiedContent, setCopiedContent] = useState(false);

  const lines = useMemo(() => {
    if (!activeTab?.document) return [];
    return activeTab.document.content.split(/\r?\n/);
  }, [activeTab?.document]);

  const formattedUpdatedTime = activeTab?.document
    ? new Date(activeTab.document.mtimeMs).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;

  const lineNumberWidth = Math.max(3, String(lines.length).length);

  return (
    <div data-testid="code-viewer-pane" className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Toolbar & File Meta Header */}
      {activeTab && (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 bg-zinc-100/70 dark:bg-[#171b24] border-b border-zinc-200/70 dark:border-zinc-800/80 text-[11px] text-zinc-500 dark:text-zinc-400 shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <FileCode2 className="w-3.5 h-3.5 text-sky-500 shrink-0" />
            <span
              className="font-semibold text-zinc-800 dark:text-zinc-100 truncate"
              title={activeTab.filePath}
            >
              {activeTab.fileName}
            </span>
            {activeTab.document?.language && (
              <span className="px-1.5 py-0.25 rounded bg-sky-500/12 text-sky-700 dark:text-sky-300 text-[10px] font-medium shrink-0">
                {activeTab.document.language}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(activeTab.filePath);
                setCopiedPath(true);
                setTimeout(() => setCopiedPath(false), 1500);
              }}
              title={`パスをコピー: ${activeTab.filePath}`}
              aria-label="パスをコピー"
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

          <div className="flex items-center gap-1.5 shrink-0">
            {activeTab.document && (
              <span className="hidden sm:inline font-mono text-[10.5px] text-zinc-400">
                {lines.length}行 · {formatByteSize(activeTab.document.sizeBytes)}
              </span>
            )}
            {formattedUpdatedTime && (
              <span className="hidden md:inline-flex items-center gap-1 text-[10.5px] text-zinc-400">
                <Clock className="w-3 h-3" />
                {formattedUpdatedTime}
              </span>
            )}
            {activeTab.document && (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(activeTab.document?.content ?? "");
                  setCopiedContent(true);
                  setTimeout(() => setCopiedContent(false), 1500);
                }}
                title="内容をコピー"
                aria-label="内容をコピー"
                className="p-1 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                {copiedContent ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={() => setWrapLines((v) => !v)}
              title={wrapLines ? "行の折り返し: ON" : "行の折り返し: OFF"}
              aria-label="行の折り返しを切替"
              aria-pressed={wrapLines}
              className={`p-1 rounded-md transition-colors cursor-pointer ${
                wrapLines
                  ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
                  : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
              }`}
            >
              <WrapText className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onRefreshActive}
              title="再読み込み"
              aria-label="再読み込み"
              className="p-1 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <RotateCw className={`w-3.5 h-3.5 ${activeTab.isLoading ? "animate-spin" : ""}`} />
            </button>
            {onAttachFileToChat && (
              <button
                type="button"
                onClick={() => onAttachFileToChat(activeTab.filePath, activeTab.fileName)}
                title="このファイルをチャットに添付"
                aria-label="このファイルをチャットに添付"
                className="p-1 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <MessageSquarePlus className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* File Path Sub-bar */}
      {activeTab && (
        <div
          title={activeTab.filePath}
          className="px-3 py-1 text-[10.5px] font-mono text-zinc-400 bg-zinc-50/80 dark:bg-[#12151c] border-b border-zinc-200/60 dark:border-zinc-800/70 truncate shrink-0"
        >
          {activeTab.filePath}
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 overflow-auto bg-white dark:bg-[#0f1115]">
        {!activeTab ? (
          <div className="h-full flex items-center justify-center p-6 text-[12px] text-zinc-400">
            ファイルツリーからファイルを選択すると、ここに内容が表示されます。
          </div>
        ) : activeTab.isLoading && !activeTab.document ? (
          <div className="h-full flex items-center justify-center gap-2 text-[12.5px] text-zinc-400">
            <Loader2 className="w-4 h-4 text-sky-500 animate-spin" />
            <span>ファイルを読み込み中...</span>
          </div>
        ) : activeTab.error && !activeTab.document ? (
          <div className="h-full flex flex-col items-center justify-center p-6 text-center space-y-3">
            <div className="w-11 h-11 rounded-2xl bg-amber-500/12 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
            </div>
            <div className="space-y-1 max-w-sm">
              <div className="text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100">
                {activeTab.isBinary
                  ? "バイナリファイルはプレビューできません"
                  : activeTab.isTooLarge
                    ? "ファイルサイズが上限を超えています"
                    : "ファイルを読み込めませんでした"}
              </div>
              <div className="text-[12px] text-zinc-500 dark:text-zinc-400">
                {activeTab.error}
              </div>
              <div className="text-[10.5px] font-mono text-zinc-400 break-all pt-1">
                {activeTab.filePath}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onRevealInFinder(activeTab.filePath)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 transition-colors cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Finder で表示</span>
              </button>
              <button
                type="button"
                onClick={onRefreshActive}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>再読み込み</span>
              </button>
            </div>
          </div>
        ) : activeTab.document ? (
          <div className="min-w-full py-2 font-mono text-[12px] leading-[1.6] select-text">
            {activeTab.error && (
              <div className="mx-3 mb-2 flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11.5px] bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1">{activeTab.error}</span>
              </div>
            )}
            <div className={wrapLines ? "w-full" : "w-max min-w-full"}>
              {lines.map((line, idx) => (
                <div
                  key={idx}
                  className="flex hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40 px-2"
                >
                  <span
                    style={{ minWidth: `${lineNumberWidth + 1}ch` }}
                    className="pr-3 text-right text-zinc-400/70 dark:text-zinc-600 select-none shrink-0 tabular-nums"
                  >
                    {idx + 1}
                  </span>
                  <span
                    className={`flex-1 text-zinc-800 dark:text-zinc-200 ${
                      wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre"
                    }`}
                  >
                    {line.length > 0 ? line : " "}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
