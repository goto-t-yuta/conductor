import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, FileCode2, FileText, Globe, Image as ImageIcon, Search, Terminal, X } from "lucide-react";
import { t, type UiLocale } from "../../shared/i18n.js";
import type { ProjectScopeKey, ProjectSwitcherItem } from "../lib/right-pane-tabs.js";

export interface RightPaneProjectSwitcherProps {
  activeItem: ProjectSwitcherItem;
  withTabs: ProjectSwitcherItem[];
  others: ProjectSwitcherItem[];
  isOpen: boolean;
  locale?: UiLocale;
  onOpenChange: (open: boolean) => void;
  onSelectScope: (scopeKey: ProjectScopeKey) => void;
}

export const RightPaneProjectSwitcher: React.FC<RightPaneProjectSwitcherProps> = ({
  activeItem,
  withTabs,
  others,
  isOpen,
  locale = "ja",
  onOpenChange,
  onSelectScope,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery("");
      return;
    }

    const focusTimer = setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0);

    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onOpenChange(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onOpenChange(false);
      }
    };

    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isOpen, onOpenChange]);

  const { filteredWithTabs, filteredOthers } = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return { filteredWithTabs: withTabs, filteredOthers: others };
    }
    const matches = (item: ProjectSwitcherItem) =>
      item.name.toLowerCase().includes(q) ||
      (item.path ? item.path.toLowerCase().includes(q) : false);
    return {
      filteredWithTabs: withTabs.filter(matches),
      filteredOthers: others.filter(matches),
    };
  }, [withTabs, others, searchQuery]);

  const handleSelect = (scopeKey: ProjectScopeKey) => {
    onSelectScope(scopeKey);
    onOpenChange(false);
  };

  const renderItemRow = (item: ProjectSwitcherItem) => (
    <button
      key={item.scopeKey}
      type="button"
      data-testid={`project-switcher-option-${item.scopeKey}`}
      onClick={() => handleSelect(item.scopeKey)}
      title={item.path ?? item.name}
      className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-left transition-colors cursor-pointer ${
        item.isActive
          ? "bg-indigo-500/12 text-zinc-900 dark:text-zinc-100"
          : "text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/80"
      }`}
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: item.colorHex }}
      />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium truncate leading-tight">{item.name}</div>
        {item.path && (
          <div className="text-[10px] font-mono text-zinc-400 truncate leading-tight mt-0.5">
            {item.path}
          </div>
        )}
      </div>

      {item.tabCount > 0 && (
        <div className="flex items-center gap-1 shrink-0">
          <span className="inline-flex items-center gap-0.5 text-[9.5px] text-zinc-400">
            {item.browserCount > 0 && <Globe className="w-2.5 h-2.5" />}
            {item.markdownCount > 0 && <FileText className="w-2.5 h-2.5" />}
            {item.imageCount > 0 && <ImageIcon className="w-2.5 h-2.5" />}
            {(item.codeCount ?? 0) > 0 && <FileCode2 className="w-2.5 h-2.5" />}
            {(item.terminalCount ?? 0) > 0 && <Terminal className="w-2.5 h-2.5" />}
          </span>
          <span className="px-1.5 py-0.25 rounded-full text-[10px] font-semibold tabular-nums bg-indigo-500/15 text-indigo-600 dark:text-indigo-400">
            {item.tabCount}
          </span>
        </div>
      )}

      {item.isActive && <Check className="w-3.5 h-3.5 text-indigo-500 shrink-0" />}
    </button>
  );

  return (
    <div ref={containerRef} className="no-drag relative shrink-0">
      <button
        type="button"
        data-testid="right-pane-project-switcher"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => onOpenChange(!isOpen)}
        title={t(locale, "switcher.title", { name: activeItem.name })}
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11.5px] font-medium border transition-colors cursor-pointer max-w-[168px] ${
          isOpen
            ? "bg-white dark:bg-[#1d222d] border-indigo-500/50 text-zinc-900 dark:text-zinc-100 shadow-xs"
            : "bg-zinc-200/70 dark:bg-zinc-800/90 border-zinc-200/80 dark:border-zinc-700/80 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-800"
        }`}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: activeItem.colorHex }}
        />
        <span className="truncate">{activeItem.name}</span>
        {activeItem.tabCount > 0 && (
          <span
            data-testid="right-pane-project-tab-count"
            className="px-1.5 py-0.2 rounded-full text-[9.5px] font-semibold tabular-nums bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 shrink-0"
          >
            {activeItem.tabCount}
          </span>
        )}
        <ChevronDown
          className={`w-3 h-3 text-zinc-400 shrink-0 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </button>

      {isOpen && (
        <div
          data-testid="right-pane-project-dropdown"
          role="listbox"
          aria-label={t(locale, "switcher.listboxAria")}
          className="absolute left-0 top-full mt-1.5 z-50 w-68 max-h-[380px] flex flex-col rounded-xl bg-white dark:bg-[#161a22] border border-zinc-200 dark:border-zinc-700/90 shadow-2xl overflow-hidden"
        >
          {/* Search Bar */}
          <div className="p-2 border-b border-zinc-200/70 dark:border-zinc-800 shrink-0">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t(locale, "sidebar.searchProjectsPlaceholder")}
                className="w-full pl-8 pr-7 py-1.5 rounded-lg text-[12px] bg-zinc-50 dark:bg-[#0f1115] border border-zinc-200 dark:border-zinc-800 focus:border-indigo-500/60 outline-none select-text"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label={t(locale, "switcher.clearSearchAria")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Project List */}
          <div className="flex-1 overflow-y-auto p-1.5 space-y-2">
            {filteredWithTabs.length === 0 && filteredOthers.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11.5px] text-zinc-400">
                {t(locale, "sidebar.noMatchingProjects")}
              </div>
            ) : (
              <>
                {filteredWithTabs.length > 0 && (
                  <div className="space-y-0.5">
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      {t(locale, "switcher.openTabsSection")}
                    </div>
                    {filteredWithTabs.map(renderItemRow)}
                  </div>
                )}

                {filteredOthers.length > 0 && (
                  <div className="space-y-0.5">
                    {filteredWithTabs.length > 0 && (
                      <div className="my-1 border-t border-zinc-200/70 dark:border-zinc-800" />
                    )}
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                      {t(locale, "switcher.allProjectsSection")}
                    </div>
                    {filteredOthers.map(renderItemRow)}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
