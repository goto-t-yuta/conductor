import type { MarkdownDocument, MarkdownWriteResult } from "../../shared/types.js";
import type { MarkdownViewerTab } from "./right-pane-tabs.js";

export function getEffectiveMarkdownContent(tab: MarkdownViewerTab | null | undefined): string {
  if (!tab) return "";
  if (tab.draftContent !== undefined && tab.draftContent !== null) {
    return tab.draftContent;
  }
  return tab.document?.content ?? "";
}

export function applyMarkdownDraftEdit(
  tab: MarkdownViewerTab,
  nextContent: string,
): MarkdownViewerTab {
  const savedContent = tab.document?.content ?? "";
  const isDirty = Boolean(tab.deletedOnDisk) || nextContent !== savedContent;
  return {
    ...tab,
    draftContent: isDirty ? nextContent : null,
    isDirty,
    saveError: null,
  };
}

export function beginMarkdownSave(tab: MarkdownViewerTab): MarkdownViewerTab {
  return {
    ...tab,
    isSaving: true,
    saveError: null,
  };
}

export function completeMarkdownSave(
  tab: MarkdownViewerTab,
  result: MarkdownWriteResult,
  savedAt: number,
): MarkdownViewerTab {
  if (!result.ok || !result.document) {
    return {
      ...tab,
      isSaving: false,
      saveError: result.error ?? "ファイルの保存に失敗しました。",
    };
  }

  const savedDoc = result.document;
  const currentContent = getEffectiveMarkdownContent(tab);
  const stillDirty = currentContent !== savedDoc.content;

  return {
    ...tab,
    filePath: savedDoc.filePath,
    fileName: savedDoc.fileName,
    document: savedDoc,
    draftContent: stillDirty ? currentContent : null,
    isDirty: stillDirty,
    isSaving: false,
    saveError: null,
    error: null,
    deletedOnDisk: false,
    externalChange: null,
    lastSavedAt: savedAt,
    lastReloadedAt: savedAt,
  };
}

export function discardMarkdownDraft(
  tab: MarkdownViewerTab,
  freshDoc?: MarkdownDocument | null,
  now?: number,
): MarkdownViewerTab {
  if (freshDoc) {
    return {
      ...tab,
      filePath: freshDoc.filePath,
      fileName: freshDoc.fileName,
      document: freshDoc,
      draftContent: null,
      isDirty: false,
      isSaving: false,
      saveError: null,
      error: null,
      deletedOnDisk: false,
      externalChange: null,
      lastReloadedAt: now ?? tab.lastReloadedAt,
    };
  }

  return {
    ...tab,
    draftContent: null,
    isDirty: false,
    isSaving: false,
    saveError: null,
    externalChange: null,
  };
}

function isSameDocumentSnapshot(
  a: MarkdownDocument | null | undefined,
  b: MarkdownDocument,
): boolean {
  if (!a) return false;
  return (
    a.filePath === b.filePath &&
    a.mtimeMs === b.mtimeMs &&
    a.sizeBytes === b.sizeBytes &&
    a.content === b.content
  );
}

export interface MarkdownDiskReloadResult {
  tab: MarkdownViewerTab;
  didReload: boolean;
  ignoredSelfSave: boolean;
  hasExternalConflict: boolean;
}

export function applyMarkdownDiskReload(
  tab: MarkdownViewerTab,
  doc: MarkdownDocument,
  now: number,
  options?: {
    force?: boolean;
    lastSelfSavedDoc?: MarkdownDocument | null;
  },
): MarkdownDiskReloadResult {
  const force = Boolean(options?.force);

  if (
    !force &&
    (isSameDocumentSnapshot(options?.lastSelfSavedDoc, doc) ||
      isSameDocumentSnapshot(tab.document, doc))
  ) {
    return {
      tab: tab.isLoading ? { ...tab, isLoading: false } : tab,
      didReload: false,
      ignoredSelfSave: true,
      hasExternalConflict: false,
    };
  }

  if (force || !tab.isDirty) {
    return {
      tab: {
        ...tab,
        filePath: doc.filePath,
        fileName: doc.fileName,
        document: doc,
        draftContent: null,
        isDirty: false,
        isSaving: false,
        saveError: null,
        error: null,
        deletedOnDisk: false,
        externalChange: null,
        isLoading: false,
        lastReloadedAt: now,
      },
      didReload: true,
      ignoredSelfSave: false,
      hasExternalConflict: false,
    };
  }

  // Dirty tab: never overwrite user's unsaved edits!
  if (tab.document && tab.document.content === doc.content) {
    return {
      tab: tab.isLoading ? { ...tab, isLoading: false } : tab,
      didReload: false,
      ignoredSelfSave: true,
      hasExternalConflict: false,
    };
  }

  return {
    tab: {
      ...tab,
      isLoading: false,
      deletedOnDisk: false,
      externalChange: {
        kind: "changed",
        document: doc,
        detectedAt: now,
        message: "ディスク上のファイルが外部で変更されました。",
      },
    },
    didReload: false,
    ignoredSelfSave: false,
    hasExternalConflict: true,
  };
}

export function applyMarkdownDiskDeleted(
  tab: MarkdownViewerTab,
  error: string | undefined,
  now: number,
): MarkdownViewerTab {
  const message = error ?? "ファイルが削除または移動されました。";
  if (tab.isDirty) {
    return {
      ...tab,
      deletedOnDisk: true,
      isLoading: false,
      externalChange: {
        kind: "deleted",
        detectedAt: now,
        message,
      },
    };
  }

  return {
    ...tab,
    deletedOnDisk: true,
    error: message,
    isLoading: false,
  };
}

export function dismissMarkdownExternalChange(tab: MarkdownViewerTab): MarkdownViewerTab {
  if (!tab.externalChange) return tab;
  return {
    ...tab,
    externalChange: null,
  };
}

export function setMarkdownTabViewMode(
  tab: MarkdownViewerTab,
  viewMode: "rendered" | "raw",
): MarkdownViewerTab {
  if (tab.viewMode === viewMode) return tab;
  return {
    ...tab,
    viewMode,
  };
}

export interface TextareaIndentResult {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * Applies 2-space indentation or Shift+Tab outdentation to a textarea selection.
 */
export function applyTextareaIndent(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  unindent: boolean,
  indentUnit = "  ",
): TextareaIndentResult {
  const unitLen = indentUnit.length;

  // Single caret insert when not unindenting
  if (!unindent && selectionStart === selectionEnd) {
    const nextValue = `${value.slice(0, selectionStart)}${indentUnit}${value.slice(selectionEnd)}`;
    const nextPos = selectionStart + unitLen;
    return {
      value: nextValue,
      selectionStart: nextPos,
      selectionEnd: nextPos,
    };
  }

  const blockStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const effectiveSelectionEnd =
    selectionEnd > selectionStart && value[selectionEnd - 1] === "\n"
      ? selectionEnd - 1
      : selectionEnd;
  const nextNewline = value.indexOf("\n", effectiveSelectionEnd);
  const blockEnd = nextNewline === -1 ? value.length : nextNewline;

  const block = value.slice(blockStart, blockEnd);
  const lines = block.split("\n");

  let firstLineDelta = 0;
  let totalDelta = 0;

  const updatedLines = lines.map((line, index) => {
    if (!unindent) {
      if (index === 0) firstLineDelta = unitLen;
      totalDelta += unitLen;
      return `${indentUnit}${line}`;
    }

    let removed = 0;
    if (line.startsWith(indentUnit)) {
      removed = unitLen;
    } else if (line.startsWith("\t")) {
      removed = 1;
    } else {
      const leadingSpaces = line.match(/^ +/)?.[0].length ?? 0;
      removed = Math.min(leadingSpaces, unitLen);
    }

    if (index === 0) firstLineDelta = -removed;
    totalDelta -= removed;
    return line.slice(removed);
  });

  const nextBlock = updatedLines.join("\n");
  const nextValue = `${value.slice(0, blockStart)}${nextBlock}${value.slice(blockEnd)}`;
  const nextStart = Math.max(blockStart, selectionStart + firstLineDelta);
  const nextEnd = Math.max(nextStart, selectionEnd + totalDelta);

  return {
    value: nextValue,
    selectionStart: nextStart,
    selectionEnd: nextEnd,
  };
}
