import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  Image as ImageIcon,
  Loader2,
  RotateCw,
  Search,
  X,
} from "lucide-react";
import {
  filterFileTreeEntries,
  formatFileTreeIpcError,
  type ProjectFileEntry,
} from "../../shared/file-tree.js";

export interface ProjectFileTreeProps {
  projectName: string;
  projectPath: string | null;
  projectColorHex: string;
  activeFilePath: string | null;
  onOpenFile: (entry: ProjectFileEntry) => void;
  onRevealInFinder?: (filePath: string) => void;
  /** Optional preloaded directory map (primarily for deterministic SSR/unit tests) */
  initialEntriesByDir?: Record<string, ProjectFileEntry[]>;
}

export const ProjectFileTree: React.FC<ProjectFileTreeProps> = ({
  projectName,
  projectPath,
  projectColorHex,
  activeFilePath,
  onOpenFile,
  onRevealInFinder,
  initialEntriesByDir,
}) => {
  const [entriesByDir, setEntriesByDir] = useState<Record<string, ProjectFileEntry[]>>(
    () => initialEntriesByDir ?? {},
  );
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(() => new Set());
  const [rootError, setRootError] = useState<string | null>(null);
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);

  const projectPathRef = useRef<string | null>(projectPath);
  projectPathRef.current = projectPath;

  const loadDirectory = useCallback(
    async (dirPath: string, rootDir: string) => {
      if (typeof window === "undefined" || !window.conductor?.fsListDir) {
        return;
      }

      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.add(dirPath);
        return next;
      });

      try {
        const res = await window.conductor.fsListDir(dirPath, { rootPath: rootDir });
        if (projectPathRef.current !== rootDir) return;

        if (res.ok && res.entries) {
          setEntriesByDir((prev) => ({
            ...prev,
            [dirPath]: res.entries!,
          }));
          if (dirPath === rootDir) {
            setRootError(null);
          } else {
            setDirErrors((prev) => {
              if (!(dirPath in prev)) return prev;
              const copy = { ...prev };
              delete copy[dirPath];
              return copy;
            });
          }
        } else {
          const msg = res.error ?? "ディレクトリを読み込めませんでした。";
          if (dirPath === rootDir) {
            setRootError(msg);
          } else {
            setDirErrors((prev) => ({ ...prev, [dirPath]: msg }));
          }
        }
      } catch (err) {
        if (projectPathRef.current !== rootDir) return;
        const msg = formatFileTreeIpcError(err, "ディレクトリを読み込めませんでした。");
        if (dirPath === rootDir) {
          setRootError(msg);
        } else {
          setDirErrors((prev) => ({ ...prev, [dirPath]: msg }));
        }
      } finally {
        setLoadingDirs((prev) => {
          if (!prev.has(dirPath)) return prev;
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    },
    [],
  );

  // Reset & reload tree root whenever the active right-pane project changes
  useEffect(() => {
    setSearchQuery("");
    setExpandedDirs(new Set());
    setDirErrors({});
    setRootError(null);

    if (!projectPath) {
      setEntriesByDir({});
      return;
    }

    if (initialEntriesByDir && initialEntriesByDir[projectPath]) {
      setEntriesByDir(initialEntriesByDir);
      return;
    }

    setEntriesByDir({});
    void loadDirectory(projectPath, projectPath);
  }, [projectPath, loadDirectory, initialEntriesByDir]);

  const handleRefresh = useCallback(async () => {
    if (!projectPath) return;
    setIsRefreshing(true);
    try {
      const dirsToReload = [projectPath, ...Array.from(expandedDirs)];
      await Promise.all(dirsToReload.map((dir) => loadDirectory(dir, projectPath)));
    } finally {
      setIsRefreshing(false);
    }
  }, [projectPath, expandedDirs, loadDirectory]);

  const handleToggleDirectory = useCallback(
    (entry: ProjectFileEntry) => {
      if (!projectPath) return;
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
          if (!(entry.path in entriesByDir)) {
            void loadDirectory(entry.path, projectPath);
          }
        }
        return next;
      });
    },
    [projectPath, entriesByDir, loadDirectory],
  );

  const filteredTree = useMemo(() => {
    if (!projectPath) {
      return { filteredByDir: {}, autoExpandedDirs: new Set<string>(), matchCount: 0 };
    }
    return filterFileTreeEntries(projectPath, entriesByDir, searchQuery);
  }, [projectPath, entriesByDir, searchQuery]);

  const isFiltering = searchQuery.trim().length > 0;

  const renderFileIcon = (entry: ProjectFileEntry) => {
    if (entry.fileKind === "markdown") {
      return <FileText className="w-3.5 h-3.5 text-emerald-500 shrink-0" />;
    }
    if (entry.fileKind === "image") {
      return <ImageIcon className="w-3.5 h-3.5 text-amber-500 shrink-0" />;
    }
    if (entry.fileKind === "binary") {
      return <File className="w-3.5 h-3.5 text-zinc-400/70 shrink-0" />;
    }
    return <FileCode2 className="w-3.5 h-3.5 text-sky-500 shrink-0" />;
  };

  const renderEntries = (dirPath: string, depth: number): React.ReactNode => {
    const entries = filteredTree.filteredByDir[dirPath];
    const isLoading = loadingDirs.has(dirPath);
    const err = dirErrors[dirPath];

    if (err) {
      return (
        <div
          style={{ paddingLeft: `${12 + depth * 12}px` }}
          className="py-1 pr-2 text-[10.5px] text-rose-500 truncate"
          title={err}
        >
          {err}
        </div>
      );
    }

    if (!entries) {
      if (isLoading) {
        return (
          <div
            style={{ paddingLeft: `${12 + depth * 12}px` }}
            className="flex items-center gap-1.5 py-1 text-[11px] text-zinc-400"
          >
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>読み込み中...</span>
          </div>
        );
      }
      return null;
    }

    if (entries.length === 0) {
      if (depth === 0) {
        return (
          <div className="px-3 py-6 text-center text-[11px] text-zinc-400">
            {isFiltering
              ? "一致するファイルがありません"
              : "表示できるファイルがありません"}
          </div>
        );
      }
      return (
        <div
          style={{ paddingLeft: `${16 + depth * 12}px` }}
          className="py-0.5 text-[10.5px] text-zinc-400 italic"
        >
          (空)
        </div>
      );
    }

    return entries.map((entry) => {
      const paddingLeft = 8 + depth * 12;

      if (entry.isDirectory) {
        const isExpanded =
          expandedDirs.has(entry.path) || filteredTree.autoExpandedDirs.has(entry.path);
        const isDirLoading = loadingDirs.has(entry.path);

        return (
          <div key={entry.path}>
            <button
              type="button"
              data-testid="file-tree-dir-row"
              data-entry-path={entry.path}
              onClick={() => handleToggleDirectory(entry)}
              style={{ paddingLeft: `${paddingLeft}px` }}
              title={entry.path}
              className="w-full flex items-center gap-1 pr-2 py-1 text-left text-[11.5px] text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/70 rounded-md transition-colors cursor-pointer"
            >
              {isDirLoading ? (
                <Loader2 className="w-3 h-3 text-zinc-400 animate-spin shrink-0" />
              ) : isExpanded ? (
                <ChevronDown className="w-3 h-3 text-zinc-400 shrink-0" />
              ) : (
                <ChevronRight className="w-3 h-3 text-zinc-400 shrink-0" />
              )}
              {isExpanded ? (
                <FolderOpen className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              ) : (
                <Folder className="w-3.5 h-3.5 text-indigo-400/80 shrink-0" />
              )}
              <span className="truncate font-medium">{entry.name}</span>
            </button>
            {isExpanded && renderEntries(entry.path, depth + 1)}
          </div>
        );
      }

      const isActive = activeFilePath === entry.path;
      return (
        <button
          key={entry.path}
          type="button"
          data-testid="file-tree-file-row"
          data-entry-path={entry.path}
          data-file-kind={entry.fileKind ?? "code"}
          onClick={() => onOpenFile(entry)}
          style={{ paddingLeft: `${paddingLeft + 14}px` }}
          title={entry.path}
          className={`w-full flex items-center gap-1.5 pr-2 py-1 text-left text-[11.5px] rounded-md transition-colors cursor-pointer ${
            isActive
              ? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 font-medium"
              : entry.fileKind === "binary"
                ? "text-zinc-400 dark:text-zinc-500 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50"
                : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/70"
          }`}
        >
          {renderFileIcon(entry)}
          <span className="truncate flex-1">{entry.name}</span>
        </button>
      );
    });
  };

  return (
    <aside
      data-testid="project-file-tree"
      aria-label="プロジェクトファイルツリー"
      className="h-full flex flex-col bg-zinc-50/90 dark:bg-[#11141a] select-none overflow-hidden"
    >
      {/* Sidebar Header */}
      <div className="flex items-center justify-between gap-1.5 px-2.5 py-1.5 border-b border-zinc-200/70 dark:border-zinc-800/80 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: projectColorHex }}
          />
          <span
            className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-200 truncate"
            title={projectPath ?? projectName}
          >
            {projectName}
          </span>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {projectPath && onRevealInFinder && (
            <button
              type="button"
              onClick={() => onRevealInFinder(projectPath)}
              title="Finder でフォルダを開く"
              aria-label="Finder でフォルダを開く"
              className="p-1 rounded text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <FolderOpen className="w-3 h-3" />
            </button>
          )}
          {projectPath && (
            <button
              type="button"
              data-testid="file-tree-refresh-btn"
              onClick={() => void handleRefresh()}
              title="ファイルツリーを更新"
              aria-label="ファイルツリーを更新"
              className="p-1 rounded text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <RotateCw
                className={`w-3 h-3 ${isRefreshing || loadingDirs.has(projectPath) ? "animate-spin" : ""}`}
              />
            </button>
          )}
        </div>
      </div>

      {/* General Scope Hint (No Project Path) */}
      {!projectPath ? (
        <div
          data-testid="file-tree-no-project"
          className="flex-1 flex flex-col items-center justify-center p-4 text-center space-y-2.5"
        >
          <div className="w-9 h-9 rounded-xl bg-zinc-200/70 dark:bg-zinc-800/80 flex items-center justify-center">
            <FolderTree className="w-4 h-4 text-zinc-400" />
          </div>
          <div className="space-y-1">
            <div className="text-[11.5px] font-medium text-zinc-700 dark:text-zinc-200">
              プロジェクトを選択してください
            </div>
            <p className="text-[10.5px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
              現在は General スコープです。上部のプロジェクト切替からプロジェクトを選ぶと、配下のファイルツリーを閲覧できます。
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Quick Filename Filter */}
          <div className="px-2 py-1.5 border-b border-zinc-200/60 dark:border-zinc-800/70 shrink-0">
            <div className="relative">
              <Search className="w-3 h-3 text-zinc-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                data-testid="file-tree-search-input"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ファイル名で絞り込み..."
                className="w-full pl-6 pr-6 py-1 rounded-md text-[11px] bg-white dark:bg-[#0f1115] border border-zinc-200/80 dark:border-zinc-800 focus:border-indigo-500/60 outline-none select-text"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="絞り込みをクリア"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          </div>

          {/* Tree Scroll Body */}
          <div className="flex-1 min-h-0 overflow-y-auto px-1 py-1.5 space-y-0.5">
            {rootError ? (
              <div className="px-2.5 py-4 text-center space-y-2">
                <AlertTriangle className="w-4 h-4 text-rose-500 mx-auto" />
                <div className="text-[11px] text-rose-600 dark:text-rose-400">{rootError}</div>
                <button
                  type="button"
                  onClick={() => void handleRefresh()}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-200/80 dark:bg-zinc-800 hover:bg-zinc-300/80 dark:hover:bg-zinc-700 cursor-pointer"
                >
                  再試行
                </button>
              </div>
            ) : (
              renderEntries(projectPath, 0)
            )}
          </div>
        </>
      )}
    </aside>
  );
};
