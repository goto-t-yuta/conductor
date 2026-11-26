import React, { useEffect, useRef, useState } from "react";
import {
  FileCode2,
  FileText,
  FolderOpen,
  FolderTree,
  Globe,
  Image as ImageIcon,
  Loader2,
  PanelRightClose,
  Plus,
  Upload,
  X,
} from "lucide-react";
import type { ProjectFileEntry } from "../../shared/types.js";
import { t, type UiLocale } from "../../shared/i18n.js";
import { isMarkdownPathOrUrl } from "../lib/markdown-utils.js";
import type {
  ProjectScopeKey,
  ProjectSwitcherItem,
  UnifiedRightPaneTab,
} from "../lib/right-pane-tabs.js";
import { CodeViewerPane } from "./CodeViewerPane.js";
import { ImageViewerPane } from "./ImageViewerPane.js";
import { InAppBrowserPane } from "./InAppBrowserPane.js";
import type { MarkdownOpenedImage } from "./MarkdownView.js";
import { MarkdownViewerPane } from "./MarkdownViewerPane.js";
import { ProjectFileTree } from "./ProjectFileTree.js";
import { RightPaneProjectSwitcher } from "./RightPaneProjectSwitcher.js";

export interface UnifiedRightPaneProps {
  activeProjectItem: ProjectSwitcherItem;
  switcherWithTabs: ProjectSwitcherItem[];
  switcherOthers: ProjectSwitcherItem[];
  tabs: UnifiedRightPaneTab[];
  activeTab: UnifiedRightPaneTab | null;
  projectRecentMdFiles: string[];
  locale?: UiLocale;
  // Browser props
  isPickingElement: boolean;
  hideNativeView: boolean;
  onNavigateBrowser: (url: string, newTab?: boolean) => void;
  onNewBrowserTab: () => void;
  onBrowserBack: () => void;
  onBrowserForward: () => void;
  onBrowserReload: () => void;
  onBrowserToggleDevTools: () => void;
  onBrowserTogglePicker: () => void;
  onBrowserCaptureScreenshot: () => void;
  onBrowserAttachUrl?: () => void;
  onBrowserAttachErrors: () => void;
  onBrowserOpenExternal: () => void;
  // Markdown props
  mdAutoReload: boolean;
  mdIsWatching: boolean;
  mdJustReloadedAt: number | null;
  mdPendingAnchor: string | null;
  onClearMdPendingAnchor: () => void;
  onToggleMdAutoReload: () => void;
  onOpenMarkdownDialog: () => void;
  onOpenMarkdownFile: (pathOrUrl: string, baseFilePath?: string) => void;
  onRefreshActiveMd: () => void;
  onRemoveRecentMd: (filePath: string) => void;
  onAttachMdFileToChat: (filePath: string, fileName: string) => void;
  onOpenMarkdownImage?: (image: MarkdownOpenedImage) => void;
  onMarkdownDraftChange?: (filePath: string, nextContent: string) => void;
  onSaveActiveMd?: () => Promise<void> | void;
  onDiscardActiveMd?: () => Promise<void> | void;
  onReloadExternalMdChange?: () => Promise<void> | void;
  onDismissExternalMdChange?: () => void;
  onChangeMdViewMode?: (filePath: string, mode: "rendered" | "raw") => void;
  // Image props
  onRetryImageTab: (tabId: string) => void;
  onImageLoadError: (tabId: string) => void;
  // Code viewer & Project File Tree props
  onOpenProjectFile?: (entry: ProjectFileEntry) => void;
  onRefreshActiveCode?: () => void;
  onAttachCodeFileToChat?: (filePath: string, fileName: string) => void;
  onCloseRightPane?: () => void;
  initialShowFileTree?: boolean;
  initialFileTreeEntries?: Record<string, ProjectFileEntry[]>;
  // Shared unified actions
  onSelectProjectScope: (scopeKey: ProjectScopeKey) => void;
  onSelectTab: (tab: UnifiedRightPaneTab) => void;
  onCloseTab: (tab: UnifiedRightPaneTab) => void;
  onOpenUrl: (url: string) => void;
  onRevealInFinder: (filePath: string) => void;
}

export const UnifiedRightPane: React.FC<UnifiedRightPaneProps> = ({
  activeProjectItem,
  switcherWithTabs,
  switcherOthers,
  tabs,
  activeTab,
  projectRecentMdFiles,
  locale = "ja",
  isPickingElement,
  hideNativeView,
  onNavigateBrowser,
  onNewBrowserTab,
  onBrowserBack,
  onBrowserForward,
  onBrowserReload,
  onBrowserToggleDevTools,
  onBrowserTogglePicker,
  onBrowserCaptureScreenshot,
  onBrowserAttachUrl,
  onBrowserAttachErrors,
  onBrowserOpenExternal,
  mdAutoReload,
  mdIsWatching,
  mdJustReloadedAt,
  mdPendingAnchor,
  onClearMdPendingAnchor,
  onToggleMdAutoReload,
  onOpenMarkdownDialog,
  onOpenMarkdownFile,
  onRefreshActiveMd,
  onRemoveRecentMd,
  onAttachMdFileToChat,
  onOpenMarkdownImage,
  onMarkdownDraftChange,
  onSaveActiveMd,
  onDiscardActiveMd,
  onReloadExternalMdChange,
  onDismissExternalMdChange,
  onChangeMdViewMode,
  onRetryImageTab,
  onImageLoadError,
  onOpenProjectFile,
  onRefreshActiveCode,
  onAttachCodeFileToChat,
  onCloseRightPane,
  initialShowFileTree = false,
  initialFileTreeEntries,
  onSelectProjectScope,
  onSelectTab,
  onCloseTab,
  onOpenUrl,
  onRevealInFinder,
}) => {
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [showFileTree, setShowFileTree] = useState(initialShowFileTree);
  const [fileTreeWidth, setFileTreeWidth] = useState(216);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragDepthRef = useRef(0);

  const effectiveHideNativeView = hideNativeView || projectMenuOpen || isDraggingOver;

  const activeFilePath =
    activeTab?.kind === "markdown"
      ? activeTab.markdownTab.filePath
      : activeTab?.kind === "code"
        ? activeTab.codeTab.filePath
        : activeTab?.kind === "image"
          ? (activeTab.imageTab.imagePath ?? null)
          : null;

  const startFileTreeResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = fileTreeWidth;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      setFileTreeWidth(Math.min(360, Math.max(150, startW + dx)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleClosePanel = () => {
    if (typeof window !== "undefined" && window.conductor?.browserSetBounds) {
      void window.conductor.browserSetBounds({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      });
    }
    onCloseRightPane?.();
  };

  // Ensure Chromium WebContentsView is hidden whenever active tab is not a browser tab
  // or when the project switcher dropdown / overlay is open.
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !window.conductor?.browserSetBounds
    ) {
      return;
    }
    if (activeTab?.kind !== "browser" || effectiveHideNativeView) {
      void window.conductor.browserSetBounds({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      });
    }
  }, [activeTab?.kind, activeTab?.id, effectiveHideNativeView]);

  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!isDraggingOver) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingOver(false);

    const droppedFiles = Array.from(e.dataTransfer.files ?? []);
    const paths: string[] = [];
    for (const file of droppedFiles) {
      const resolved =
        window.conductor?.getPathForFile?.(file) ||
        (file as File & { path?: string }).path ||
        "";
      if (resolved && isMarkdownPathOrUrl(resolved)) {
        paths.push(resolved);
      }
    }

    if (paths.length > 0) {
      for (const p of paths) {
        onOpenMarkdownFile(p);
      }
      return;
    }

    const uriList = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (uriList) {
      const first = uriList
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
      if (first && isMarkdownPathOrUrl(first)) {
        onOpenMarkdownFile(first);
      }
    }
  };

  const renderTabIcon = (tab: UnifiedRightPaneTab, isActive: boolean) => {
    if (tab.kind === "browser") {
      if (tab.isLoading) {
        return <Loader2 className="w-3 h-3 text-indigo-500 animate-spin shrink-0" />;
      }
      return (
        <span className="relative inline-flex items-center shrink-0">
          <Globe
            className={`w-3 h-3 shrink-0 ${
              isActive ? "text-indigo-500" : "text-zinc-400"
            }`}
          />
          {tab.hasError && (
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 absolute -top-0.5 -right-0.5" />
          )}
        </span>
      );
    }

    if (tab.kind === "markdown") {
      return (
        <FileText
          className={`w-3 h-3 shrink-0 ${
            tab.hasError ? "text-rose-500" : isActive ? "text-emerald-500" : "text-zinc-400"
          }`}
        />
      );
    }

    if (tab.kind === "code") {
      return (
        <FileCode2
          className={`w-3 h-3 shrink-0 ${
            tab.hasError ? "text-rose-500" : isActive ? "text-sky-500" : "text-zinc-400"
          }`}
        />
      );
    }

    return (
      <ImageIcon
        className={`w-3 h-3 shrink-0 ${
          tab.hasError ? "text-rose-500" : isActive ? "text-amber-500" : "text-zinc-400"
        }`}
      />
    );
  };

  return (
    <section
      data-testid="unified-right-pane"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className="relative flex flex-col h-full bg-zinc-50 dark:bg-[#13161c] border-l border-zinc-200/80 dark:border-zinc-800/90"
    >
      {/* Unified Header: Project Switcher + File Tree Toggle + Mixed Tab Strip + Quick Actions + Close */}
      <div className="drag-region relative z-20 h-11 flex items-center gap-1.5 px-2 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0">
        <RightPaneProjectSwitcher
          activeItem={activeProjectItem}
          withTabs={switcherWithTabs}
          others={switcherOthers}
          isOpen={projectMenuOpen}
          locale={locale}
          onOpenChange={setProjectMenuOpen}
          onSelectScope={onSelectProjectScope}
        />

        <button
          type="button"
          data-testid="toggle-file-tree-btn"
          onClick={() => setShowFileTree((v) => !v)}
          title={t(locale, "rightPane.toggleFileTree")}
          aria-label={t(locale, "rightPane.toggleFileTree")}
          aria-pressed={showFileTree}
          className={`no-drag p-1.5 rounded-lg transition-colors cursor-pointer shrink-0 ${
            showFileTree
              ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400"
              : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
          }`}
        >
          <FolderTree className="w-3.5 h-3.5" />
        </button>

        <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-800 shrink-0" />

        {/* Unified Mixed Tabs Strip */}
        <div
          role="tablist"
          aria-label={t(locale, "rightPane.tabsAria", { name: activeProjectItem.name })}
          className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab?.id;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                data-testid={`unified-tab-${tab.kind}`}
                data-tab-id={tab.id}
                onClick={() => onSelectTab(tab)}
                title={tab.subtitle || tab.title}
                className={`no-drag group flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11.5px] max-w-[175px] cursor-pointer transition-colors shrink-0 ${
                  isActive
                    ? "bg-white dark:bg-[#1d222d] text-zinc-900 dark:text-zinc-100 shadow-xs border border-zinc-200/80 dark:border-zinc-700/80 font-medium"
                    : "text-zinc-500 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/70"
                }`}
              >
                {renderTabIcon(tab, isActive)}
                {tab.kind === "markdown" && tab.markdownTab.isDirty && (
                  <span
                    data-testid="markdown-tab-dirty-dot"
                    title={t(locale, "rightPane.unsavedChanges")}
                    aria-label={t(locale, "rightPane.unsavedChanges")}
                    className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                  />
                )}
                <span className="truncate flex-1">{tab.title}</span>
                <button
                  type="button"
                  aria-label={t(locale, "rightPane.closeTabAria", { title: tab.title })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab);
                  }}
                  className="opacity-60 group-hover:opacity-100 hover:text-rose-500 p-0.5 rounded cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Tab Creation & Close Panel Actions */}
        <div className="no-drag flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            data-testid="new-browser-tab-btn"
            onClick={onNewBrowserTab}
            title={t(locale, "rightPane.newBrowserTabTitle")}
            aria-label={t(locale, "rightPane.newBrowserTabTitle")}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            data-testid="open-markdown-tab-btn"
            onClick={onOpenMarkdownDialog}
            title={t(locale, "rightPane.openMarkdownTitle")}
            aria-label={t(locale, "rightPane.openMarkdownAria")}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-800 mx-0.5 shrink-0" />
          <button
            type="button"
            data-testid="close-right-pane-btn"
            onClick={handleClosePanel}
            title={t(locale, "rightPane.closePanel")}
            aria-label={t(locale, "rightPane.closePanel")}
            className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body: Optional Collapsible Project File Tree + Active Viewer Viewport */}
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
        {showFileTree && (
          <>
            <div style={{ width: fileTreeWidth }} className="shrink-0 h-full min-h-0">
              <ProjectFileTree
                projectName={activeProjectItem.name}
                projectPath={activeProjectItem.path}
                projectColorHex={activeProjectItem.colorHex}
                activeFilePath={activeFilePath}
                locale={locale}
                onOpenFile={(entry) => onOpenProjectFile?.(entry)}
                onRevealInFinder={onRevealInFinder}
                initialEntriesByDir={initialFileTreeEntries}
              />
            </div>
            <div
              onMouseDown={startFileTreeResize}
              title={t(locale, "rightPane.resizeFileTreeTitle")}
              className="w-1 bg-zinc-200/70 dark:bg-zinc-800/80 hover:bg-indigo-500/40 cursor-col-resize transition-colors shrink-0"
            />
          </>
        )}

        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {!activeTab ? (
            <div
              data-testid="right-pane-empty-state"
              className="flex-1 overflow-y-auto flex flex-col items-center justify-center p-6 text-center bg-white dark:bg-[#0f1115]"
            >
              <div className="max-w-sm w-full space-y-5">
                <div className="flex flex-col items-center space-y-2">
                  <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-100 dark:bg-zinc-800/90 border border-zinc-200/80 dark:border-zinc-700/80 text-[12px] font-medium text-zinc-800 dark:text-zinc-200">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: activeProjectItem.colorHex }}
                    />
                    <span className="truncate max-w-[220px]">{activeProjectItem.name}</span>
                  </div>
                  {activeProjectItem.path && (
                    <div className="text-[10.5px] font-mono text-zinc-400 truncate max-w-full px-2">
                      {activeProjectItem.path}
                    </div>
                  )}
                  <p className="text-[12px] text-zinc-500 dark:text-zinc-400 leading-relaxed pt-1">
                    {t(locale, "rightPane.emptyDesc")}
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    data-testid="empty-new-browser-btn"
                    onClick={onNewBrowserTab}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[12px] font-medium bg-indigo-600 hover:bg-indigo-500 text-white shadow-xs transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>{t(locale, "rightPane.newBrowserTabBtn")}</span>
                  </button>
                  <button
                    type="button"
                    data-testid="empty-open-markdown-btn"
                    onClick={onOpenMarkdownDialog}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[12px] font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200/80 dark:hover:bg-zinc-700/80 text-zinc-800 dark:text-zinc-200 border border-zinc-200/80 dark:border-zinc-700/80 transition-colors cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>{t(locale, "rightPane.openMarkdownBtn")}</span>
                  </button>
                  {activeProjectItem.path && !showFileTree && (
                    <button
                      type="button"
                      data-testid="empty-open-file-tree-btn"
                      onClick={() => setShowFileTree(true)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[12px] font-medium bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200/80 dark:hover:bg-zinc-700/80 text-zinc-800 dark:text-zinc-200 border border-zinc-200/80 dark:border-zinc-700/80 transition-colors cursor-pointer"
                    >
                      <FolderTree className="w-3.5 h-3.5" />
                      <span>{t(locale, "rightPane.openFileTreeBtn")}</span>
                    </button>
                  )}
                </div>

                {projectRecentMdFiles.length > 0 && (
                  <div className="text-left pt-2 space-y-1.5">
                    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-zinc-400 px-1">
                      {t(locale, "rightPane.recentMarkdownHeader", { name: activeProjectItem.name })}
                    </div>
                    <div className="space-y-1">
                      {projectRecentMdFiles.slice(0, 5).map((filePath) => {
                        const baseName = filePath.split(/[/\\]/).pop() || filePath;
                        return (
                          <div
                            key={filePath}
                            onClick={() => onOpenMarkdownFile(filePath)}
                            title={filePath}
                            className="group flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-zinc-200/70 dark:border-zinc-800/80 bg-zinc-50/70 dark:bg-[#161a22] hover:border-indigo-500/40 cursor-pointer transition-colors"
                          >
                            <FileText className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
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
                                onRemoveRecentMd(filePath);
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
          ) : activeTab.kind === "browser" ? (
            <InAppBrowserPane
              activeTab={activeTab.browserTab}
              isPickingElement={isPickingElement}
              hideNativeView={effectiveHideNativeView}
              locale={locale}
              layoutSyncKey={`${showFileTree}:${fileTreeWidth}`}
              onNavigate={onNavigateBrowser}
              onBack={onBrowserBack}
              onForward={onBrowserForward}
              onReload={onBrowserReload}
              onToggleDevTools={onBrowserToggleDevTools}
              onTogglePicker={onBrowserTogglePicker}
              onCaptureScreenshot={onBrowserCaptureScreenshot}
              onAttachUrl={onBrowserAttachUrl}
              onAttachErrors={onBrowserAttachErrors}
              onOpenExternal={onBrowserOpenExternal}
            />
          ) : activeTab.kind === "markdown" ? (
            <MarkdownViewerPane
              activeTab={activeTab.markdownTab}
              recentFiles={projectRecentMdFiles}
              autoReload={mdAutoReload}
              isWatching={mdIsWatching}
              justReloadedAt={mdJustReloadedAt}
              pendingAnchor={mdPendingAnchor}
              locale={locale}
              onClearPendingAnchor={onClearMdPendingAnchor}
              onToggleAutoReload={onToggleMdAutoReload}
              onOpenDialog={onOpenMarkdownDialog}
              onOpenFile={onOpenMarkdownFile}
              onRefreshActive={onRefreshActiveMd}
              onRemoveRecent={onRemoveRecentMd}
              onOpenUrl={onOpenUrl}
              onOpenImage={onOpenMarkdownImage}
              onAttachFileToChat={onAttachMdFileToChat}
              onRevealInFinder={onRevealInFinder}
              onDraftChange={onMarkdownDraftChange}
              onSaveActive={onSaveActiveMd}
              onDiscardActive={onDiscardActiveMd}
              onReloadExternalChange={onReloadExternalMdChange}
              onDismissExternalChange={onDismissExternalMdChange}
              onChangeViewMode={onChangeMdViewMode}
            />
          ) : activeTab.kind === "code" ? (
            <CodeViewerPane
              activeTab={activeTab.codeTab}
              locale={locale}
              onRefreshActive={() => onRefreshActiveCode?.()}
              onRevealInFinder={onRevealInFinder}
              onAttachFileToChat={onAttachCodeFileToChat}
            />
          ) : (
            <ImageViewerPane
              activeTab={activeTab.imageTab}
              locale={locale}
              onCloseActiveTab={() => onCloseTab(activeTab)}
              onRetryLoadTab={onRetryImageTab}
              onImageLoadError={onImageLoadError}
              onOpenUrl={onOpenUrl}
              onRevealInFinder={onRevealInFinder}
            />
          )}
        </div>
      </div>

      {/* Drag-and-Drop Overlay for .md files */}
      {isDraggingOver && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-indigo-600/12 backdrop-blur-[2px] border-2 border-dashed border-indigo-500 rounded-lg m-1.5">
          <div className="flex flex-col items-center gap-2 px-5 py-4 rounded-xl bg-white/95 dark:bg-[#161a22]/95 shadow-lg border border-indigo-500/30">
            <Upload className="w-6 h-6 text-indigo-500" />
            <span className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
              {t(locale, "rightPane.dropMarkdown")}
            </span>
            <span className="text-[11px] text-zinc-500">.md / .markdown / .mdx</span>
          </div>
        </div>
      )}
    </section>
  );
};
