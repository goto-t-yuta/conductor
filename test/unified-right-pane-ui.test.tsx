import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BrowserTab, Project, ProjectFileEntry } from "../src/shared/types.js";
import type { MarkdownViewerTab } from "../src/renderer/components/MarkdownViewerPane.js";
import { RightPaneProjectSwitcher } from "../src/renderer/components/RightPaneProjectSwitcher.js";
import { UnifiedRightPane, type UnifiedRightPaneProps } from "../src/renderer/components/UnifiedRightPane.js";
import type { ImageViewerTab } from "../src/renderer/lib/image-viewer.js";
import {
  GENERAL_PROJECT_SCOPE,
  makeBrowserUnifiedTabId,
  makeCodeUnifiedTabId,
  makeImageUnifiedTabId,
  makeMarkdownUnifiedTabId,
  type CodeViewerTab,
  type ProjectSwitcherItem,
  type UnifiedRightPaneTab,
} from "../src/renderer/lib/right-pane-tabs.js";

const PROJ_A: Project = {
  id: "proj-a",
  name: "agent_terminal_2",
  path: "/Users/dev/work/agent_terminal_2",
  colorHex: "#3B82F6",
  gitBranch: "main",
  addedAt: "2026-11-20T00:00:00.000Z",
};

const PROJ_B: Project = {
  id: "proj-b",
  name: "web_app",
  path: "/Users/dev/work/web_app",
  colorHex: "#10B981",
  gitBranch: "dev",
  addedAt: "2026-11-20T00:00:00.000Z",
};

const BROWSER_TAB: BrowserTab = {
  id: "bt-1",
  title: "Conductor Preview",
  url: "http://localhost:5173",
  projectId: "proj-a",
  isLoading: false,
  canGoBack: true,
  canGoForward: false,
  consoleErrorCount: 0,
  networkErrorCount: 0,
};

const MD_TAB: MarkdownViewerTab = {
  filePath: "/Users/dev/work/agent_terminal_2/README.md",
  fileName: "README.md",
  document: {
    filePath: "/Users/dev/work/agent_terminal_2/README.md",
    fileName: "README.md",
    content: "# Unified Right Pane\n\nHello markdown world.",
    mtimeMs: 1700000000000,
    sizeBytes: 128,
  },
  error: null,
  isLoading: false,
  lastReloadedAt: 1700000000000,
};

const IMAGE_TAB: ImageViewerTab = {
  id: "img-1",
  label: "screenshot.png",
  fileName: "screenshot.png",
  src: "data:image/png;base64,AAAA",
  imagePath: "/Users/dev/work/agent_terminal_2/screenshot.png",
  isLoading: false,
  error: null,
};

const MIXED_TABS: UnifiedRightPaneTab[] = [
  {
    id: makeBrowserUnifiedTabId(BROWSER_TAB.id),
    kind: "browser",
    projectScope: "proj-a",
    title: BROWSER_TAB.title,
    subtitle: BROWSER_TAB.url,
    isLoading: false,
    hasError: false,
    browserTab: BROWSER_TAB,
  },
  {
    id: makeMarkdownUnifiedTabId(MD_TAB.filePath),
    kind: "markdown",
    projectScope: "proj-a",
    title: MD_TAB.fileName,
    subtitle: MD_TAB.filePath,
    isLoading: false,
    hasError: false,
    markdownTab: MD_TAB,
  },
  {
    id: makeImageUnifiedTabId(IMAGE_TAB.id),
    kind: "image",
    projectScope: "proj-a",
    title: IMAGE_TAB.label,
    subtitle: IMAGE_TAB.imagePath!,
    isLoading: false,
    hasError: false,
    imageTab: IMAGE_TAB,
  },
];

const ACTIVE_PROJ_ITEM: ProjectSwitcherItem = {
  scopeKey: "proj-a",
  project: PROJ_A,
  name: PROJ_A.name,
  path: PROJ_A.path,
  colorHex: PROJ_A.colorHex,
  tabCount: 3,
  browserCount: 1,
  markdownCount: 1,
  imageCount: 1,
  isActive: true,
  isGeneral: false,
};

const OTHER_PROJ_ITEM: ProjectSwitcherItem = {
  scopeKey: "proj-b",
  project: PROJ_B,
  name: PROJ_B.name,
  path: PROJ_B.path,
  colorHex: PROJ_B.colorHex,
  tabCount: 0,
  browserCount: 0,
  markdownCount: 0,
  imageCount: 0,
  isActive: false,
  isGeneral: false,
};

const GENERAL_ITEM: ProjectSwitcherItem = {
  scopeKey: GENERAL_PROJECT_SCOPE,
  project: null,
  name: "General",
  path: null,
  colorHex: "#71717A",
  tabCount: 0,
  browserCount: 0,
  markdownCount: 0,
  imageCount: 0,
  isActive: false,
  isGeneral: true,
};

function makeProps(overrides: Partial<UnifiedRightPaneProps> = {}): UnifiedRightPaneProps {
  return {
    activeProjectItem: ACTIVE_PROJ_ITEM,
    switcherWithTabs: [ACTIVE_PROJ_ITEM],
    switcherOthers: [OTHER_PROJ_ITEM, GENERAL_ITEM],
    tabs: MIXED_TABS,
    activeTab: MIXED_TABS[0],
    projectRecentMdFiles: ["/Users/dev/work/agent_terminal_2/DESIGN.md"],
    isPickingElement: false,
    hideNativeView: false,
    onNavigateBrowser: vi.fn(),
    onNewBrowserTab: vi.fn(),
    onBrowserBack: vi.fn(),
    onBrowserForward: vi.fn(),
    onBrowserReload: vi.fn(),
    onBrowserToggleDevTools: vi.fn(),
    onBrowserTogglePicker: vi.fn(),
    onBrowserCaptureScreenshot: vi.fn(),
    onBrowserAttachErrors: vi.fn(),
    onBrowserOpenExternal: vi.fn(),
    mdAutoReload: true,
    mdIsWatching: true,
    mdJustReloadedAt: null,
    mdPendingAnchor: null,
    onClearMdPendingAnchor: vi.fn(),
    onToggleMdAutoReload: vi.fn(),
    onOpenMarkdownDialog: vi.fn(),
    onOpenMarkdownFile: vi.fn(),
    onRefreshActiveMd: vi.fn(),
    onRemoveRecentMd: vi.fn(),
    onAttachMdFileToChat: vi.fn(),
    onRetryImageTab: vi.fn(),
    onImageLoadError: vi.fn(),
    onSelectProjectScope: vi.fn(),
    onSelectTab: vi.fn(),
    onCloseTab: vi.fn(),
    onOpenUrl: vi.fn(),
    onRevealInFinder: vi.fn(),
    ...overrides,
  };
}

describe("UnifiedRightPane & RightPaneProjectSwitcher UI", () => {
  it("renders a single unified mixed tab bar with Project Switcher and no legacy mode switcher", () => {
    const html = renderToStaticMarkup(<UnifiedRightPane {...makeProps()} />);

    // Project switcher button with project name and tab count badge
    expect(html).toContain('data-testid="right-pane-project-switcher"');
    expect(html).toContain("agent_terminal_2");
    expect(html).toContain('data-testid="right-pane-project-tab-count"');

    // Mixed Browser + Markdown + Image tabs all live in one unified tablist
    expect(html).toContain('data-testid="unified-tab-browser"');
    expect(html).toContain("Conductor Preview");
    expect(html).toContain('data-testid="unified-tab-markdown"');
    expect(html).toContain("README.md");
    expect(html).toContain('data-testid="unified-tab-image"');
    expect(html).toContain("screenshot.png");

    // Quick add buttons for browser tab and markdown file
    expect(html).toContain('data-testid="new-browser-tab-btn"');
    expect(html).toContain('data-testid="open-markdown-tab-btn"');

    // Old Browser | Markdown | Image mode switcher is gone
    expect(html).not.toContain('title="Local Markdown Viewer (⌘⇧M)"');
    expect(html).not.toContain('title="In-App Chromium Browser"');
    expect(html).not.toContain('title="Image Viewer"');
  });

  it("renders the matching viewer directly when Markdown or Image tab is active", () => {
    const mdHtml = renderToStaticMarkup(
      <UnifiedRightPane {...makeProps({ activeTab: MIXED_TABS[1] })} />,
    );
    expect(mdHtml).toContain("Unified Right Pane");
    expect(mdHtml).toContain("Hello markdown world.");

    const imgHtml = renderToStaticMarkup(
      <UnifiedRightPane {...makeProps({ activeTab: MIXED_TABS[2] })} />,
    );
    expect(imgHtml).toContain("Fit");
    expect(imgHtml).toContain("100%");
    expect(imgHtml).toContain('alt="screenshot.png"');
  });

  it("renders project empty state with quick actions and project-scoped recent Markdown files when 0 tabs", () => {
    const emptyProjItem: ProjectSwitcherItem = {
      ...OTHER_PROJ_ITEM,
      isActive: true,
    };
    const html = renderToStaticMarkup(
      <UnifiedRightPane
        {...makeProps({
          activeProjectItem: emptyProjItem,
          tabs: [],
          activeTab: null,
          projectRecentMdFiles: ["/Users/dev/work/web_app/GUIDE.md"],
        })}
      />,
    );

    expect(html).toContain('data-testid="right-pane-empty-state"');
    expect(html).toContain("web_app");
    expect(html).toContain("新しいブラウザタブ");
    expect(html).toContain("Markdown ファイルを開く");
    expect(html).toContain("GUIDE.md");
  });

  it("renders the searchable Project Switcher dropdown with pinned open-tab projects and all others", () => {
    const html = renderToStaticMarkup(
      <RightPaneProjectSwitcher
        activeItem={ACTIVE_PROJ_ITEM}
        withTabs={[ACTIVE_PROJ_ITEM]}
        others={[OTHER_PROJ_ITEM, GENERAL_ITEM]}
        isOpen={true}
        onOpenChange={vi.fn()}
        onSelectScope={vi.fn()}
      />,
    );

    expect(html).toContain('data-testid="right-pane-project-dropdown"');
    expect(html).toContain("開いているタブ");
    expect(html).toContain("すべてのプロジェクト");
    expect(html).toContain("agent_terminal_2");
    expect(html).toContain("web_app");
    expect(html).toContain("General");
  });

  it("renders the right-pane close button and project file tree toggle button in the header", () => {
    const html = renderToStaticMarkup(<UnifiedRightPane {...makeProps()} />);

    expect(html).toContain('data-testid="close-right-pane-btn"');
    expect(html).toContain('title="右パネルを閉じる"');
    expect(html).toContain('data-testid="toggle-file-tree-btn"');
    expect(html).toContain('title="ファイルツリーを表示 / 非表示"');
  });

  it("renders the collapsible Project File Tree rooted at the active project and shows a hint for General", () => {
    const entries: Record<string, ProjectFileEntry[]> = {
      [PROJ_A.path]: [
        {
          name: "src",
          path: `${PROJ_A.path}/src`,
          isDirectory: true,
          extension: "",
          fileKind: null,
        },
        {
          name: "README.md",
          path: `${PROJ_A.path}/README.md`,
          isDirectory: false,
          extension: ".md",
          fileKind: "markdown",
        },
        {
          name: "index.ts",
          path: `${PROJ_A.path}/index.ts`,
          isDirectory: false,
          extension: ".ts",
          fileKind: "code",
        },
      ],
    };

    const projectTreeHtml = renderToStaticMarkup(
      <UnifiedRightPane
        {...makeProps({
          initialShowFileTree: true,
          initialFileTreeEntries: entries,
        })}
      />,
    );
    expect(projectTreeHtml).toContain('data-testid="project-file-tree"');
    expect(projectTreeHtml).toContain('data-testid="file-tree-search-input"');
    expect(projectTreeHtml).toContain('data-testid="file-tree-refresh-btn"');
    expect(projectTreeHtml).toContain("src");
    expect(projectTreeHtml).toContain("README.md");
    expect(projectTreeHtml).toContain("index.ts");

    const generalTreeHtml = renderToStaticMarkup(
      <UnifiedRightPane
        {...makeProps({
          activeProjectItem: { ...GENERAL_ITEM, isActive: true },
          tabs: [],
          activeTab: null,
          initialShowFileTree: true,
        })}
      />,
    );
    expect(generalTreeHtml).toContain('data-testid="file-tree-no-project"');
    expect(generalTreeHtml).toContain("プロジェクトを選択してください");
  });

  it("renders CodeViewerPane for code tabs with line numbers and toolbar actions", () => {
    const codeTab: CodeViewerTab = {
      filePath: `${PROJ_A.path}/src/app.ts`,
      fileName: "app.ts",
      document: {
        filePath: `${PROJ_A.path}/src/app.ts`,
        fileName: "app.ts",
        content: "const greeting = 'hello';\nconsole.log(greeting);",
        mtimeMs: 1700000000000,
        sizeBytes: 48,
        language: "TypeScript",
      },
      error: null,
      isLoading: false,
      lastReloadedAt: 1700000000000,
    };

    const codeUnifiedTab: UnifiedRightPaneTab = {
      id: makeCodeUnifiedTabId(codeTab.filePath),
      kind: "code",
      projectScope: "proj-a",
      title: codeTab.fileName,
      subtitle: codeTab.filePath,
      isLoading: false,
      hasError: false,
      codeTab,
    };

    const html = renderToStaticMarkup(
      <UnifiedRightPane
        {...makeProps({
          tabs: [...MIXED_TABS, codeUnifiedTab],
          activeTab: codeUnifiedTab,
        })}
      />,
    );

    expect(html).toContain('data-testid="unified-tab-code"');
    expect(html).toContain('data-testid="code-viewer-pane"');
    expect(html).toContain("app.ts");
    expect(html).toContain("TypeScript");
    expect(html).toContain("const greeting = &#x27;hello&#x27;;");
    expect(html).toContain("Finder");
  });

  it("renders editable Markdown source textarea, dirty tab indicator, Save/Discard controls, live Preview draft, and external change banner", () => {
    const dirtyMdTab: MarkdownViewerTab = {
      ...MD_TAB,
      draftContent: "# Live Draft Heading\n\nUnsaved edits appear in preview too.",
      isDirty: true,
      viewMode: "raw",
      externalChange: {
        kind: "changed",
        document: {
          ...MD_TAB.document!,
          content: "# External disk update\n",
          mtimeMs: 1700000010000,
        },
        detectedAt: 1700000010000,
      },
    };

    const dirtyUnifiedTab: UnifiedRightPaneTab = {
      id: makeMarkdownUnifiedTabId(dirtyMdTab.filePath),
      kind: "markdown",
      projectScope: "proj-a",
      title: dirtyMdTab.fileName,
      subtitle: dirtyMdTab.filePath,
      isLoading: false,
      hasError: false,
      markdownTab: dirtyMdTab,
    };

    const rawHtml = renderToStaticMarkup(
      <UnifiedRightPane
        {...makeProps({
          tabs: [MIXED_TABS[0], dirtyUnifiedTab],
          activeTab: dirtyUnifiedTab,
          onMarkdownDraftChange: vi.fn(),
          onSaveActiveMd: vi.fn(),
          onDiscardActiveMd: vi.fn(),
          onReloadExternalMdChange: vi.fn(),
          onDismissExternalMdChange: vi.fn(),
          onChangeMdViewMode: vi.fn(),
        })}
      />,
    );

    // Dirty dot on unified tab bar & meta header
    expect(rawHtml).toContain('data-testid="markdown-tab-dirty-dot"');
    expect(rawHtml).toContain('data-testid="markdown-dirty-indicator"');
    expect(rawHtml).toContain("未保存");

    // Editable textarea instead of read-only pre
    expect(rawHtml).toContain("<textarea");
    expect(rawHtml).toContain('data-testid="markdown-source-editor"');
    expect(rawHtml).toMatch(/spellcheck="false"/i);
    expect(rawHtml).toContain("# Live Draft Heading");

    // Save & Discard buttons
    expect(rawHtml).toContain('data-testid="markdown-save-btn"');
    expect(rawHtml).toContain("保存");
    expect(rawHtml).toContain('data-testid="markdown-discard-btn"');
    expect(rawHtml).toContain("変更を破棄");

    // Non-destructive external change banner with Reload button
    expect(rawHtml).toContain('data-testid="markdown-external-change-banner"');
    expect(rawHtml).toContain('data-testid="markdown-external-reload-btn"');
    expect(rawHtml).toContain("再読み込み");

    // Preview mode renders the live draft content before saving
    const previewUnifiedTab: UnifiedRightPaneTab = {
      ...dirtyUnifiedTab,
      markdownTab: { ...dirtyMdTab, viewMode: "rendered" },
    };
    const previewHtml = renderToStaticMarkup(
      <UnifiedRightPane
        {...makeProps({
          tabs: [previewUnifiedTab],
          activeTab: previewUnifiedTab,
          onSaveActiveMd: vi.fn(),
          onDiscardActiveMd: vi.fn(),
        })}
      />,
    );
    expect(previewHtml).toContain("Live Draft Heading");
    expect(previewHtml).toContain("Unsaved edits appear in preview too.");
    expect(previewHtml).toContain('data-testid="markdown-save-btn"');
    expect(previewHtml).toContain('data-testid="markdown-discard-btn"');
  });
});
