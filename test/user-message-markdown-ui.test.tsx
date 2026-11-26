import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentTask, AppSnapshot, ChatMessage, Project } from "../src/shared/types.js";
import { MarkdownView } from "../src/renderer/components/MarkdownView.js";
import { UnifiedChat } from "../src/renderer/components/UnifiedChat.js";

const SAMPLE_PROJECTS: Project[] = [
  {
    id: "proj-1",
    name: "agent_terminal_2",
    path: "/Users/dev/Documents/agent_terminal_2",
    colorHex: "#3B82F6",
    gitBranch: "main",
    addedAt: "2026-11-20T00:00:00.000Z",
  },
  {
    id: "proj-2",
    name: "web_dashboard",
    path: "/Users/dev/Documents/web_dashboard",
    colorHex: "#10B981",
    gitBranch: "dev",
    addedAt: "2026-11-20T00:00:00.000Z",
  },
];

const SAMPLE_TASKS: AgentTask[] = [
  {
    id: "task-6",
    taskNumber: 6,
    title: "Fix user message markdown rendering",
    summary: "",
    projectId: "proj-1",
    projectName: "agent_terminal_2",
    projectPath: "/Users/dev/Documents/agent_terminal_2",
    status: "running",
    currentStep: null,
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  },
];

function makeUserMessage(text: string, overrides?: Partial<ChatMessage>): ChatMessage {
  return {
    id: "msg-user-md",
    role: "user",
    text,
    attachments: [],
    toolChips: [],
    isStreaming: false,
    createdAt: "2026-11-26T01:00:00.000Z",
    ...overrides,
  };
}

function renderChatWithMessages(messages: ChatMessage[]): string {
  const snapshot: AppSnapshot = {
    projects: SAMPLE_PROJECTS,
    scanRoots: [],
    tasks: SAMPLE_TASKS,
    messages,
    activeChatSessionId: "sess-1",
    chatSessions: [
      {
        id: "sess-1",
        title: "Test Chat",
        preview: "",
        messageCount: messages.length,
        createdAt: "2026-11-26T00:00:00.000Z",
        updatedAt: "2026-11-26T00:00:00.000Z",
      },
    ],
    browserTabs: [],
    activeBrowserTabId: null,
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: false,
    isConnected: true,
    connectionStatus: "Codex 利用可能",
    activeResponderCount: 0,
    providers: {
      codex: { id: "codex", label: "Codex", available: true, detail: "ok", models: [] },
      agy: { id: "agy", label: "AGY", available: false, detail: "", models: [] },
      claude: { id: "claude", label: "Claude", available: false, detail: "", models: [] },
    },
    chatProvider: "codex",
    workerProvider: "codex",
    models: [],
    chatModel: null,
    chatEffort: null,
    workerModel: null,
    workerEffort: null,
    defaultIntegrationMode: "feature-branch",
    autoLandOnComplete: true,
    preferredLanguage: "ja",
    lastErrorBanner: null,
  };

  return renderToStaticMarkup(
    <UnifiedChat
      snapshot={snapshot}
      composerText=""
      attachments={[]}
      onComposerTextChange={vi.fn()}
      onRemoveAttachment={vi.fn()}
      onAddAttachment={vi.fn()}
      onSend={vi.fn()}
      onStopMessage={vi.fn()}
      onStopAll={vi.fn()}
      onNewChat={vi.fn()}
      onSelectChatSession={vi.fn()}
      onDeleteChatSession={vi.fn()}
      onToggleSidebar={vi.fn()}
      onToggleBrowser={vi.fn()}
      rightPaneMode="browser"
      onToggleMarkdownViewer={vi.fn()}
      onAddProject={vi.fn()}
      onOpenUrl={vi.fn()}
      onOpenMarkdownFile={vi.fn()}
      onOpenImageAttachment={vi.fn()}
      onOpenTask={vi.fn()}
      onToggleElementPicker={vi.fn()}
      onCaptureScreenshot={vi.fn()}
      onAttachCurrentUrl={vi.fn()}
      onAttachConsoleErrors={vi.fn()}
      onPickLocalImages={vi.fn()}
      onPasteImage={vi.fn()}
      onReconnect={vi.fn()}
      onDismissError={vi.fn()}
      onSetChatProvider={vi.fn()}
      onSetWorkerProvider={vi.fn()}
      onSetChatModel={vi.fn()}
      onSetWorkerModel={vi.fn()}
    />,
  );
}

describe("User message bubble Markdown rendering", () => {
  it("renders blockquotes, inline code, fenced code blocks with copy button, emphasis, lists, and links inside user bubbles", () => {
    const markdown = [
      "> 引用メッセージです",
      "> 2行目の引用",
      "",
      "`pnpm check` を実行して **重要** と *斜体* と ~~取消~~ を確認してください。",
      "",
      "- 項目A",
      "- [x] 完了済み項目",
      "",
      "1. 手順1",
      "2. [公式ドキュメント](https://example.com/docs) と [README](/Users/dev/README.md)",
      "",
      "```ts",
      "const answer = 42;",
      "console.log(answer);",
      "```",
    ].join("\n");

    const html = renderChatWithMessages([makeUserMessage(markdown)]);

    // Bubble container uses user markdown variant without whitespace-pre-wrap
    const bubbleMatch = html.match(/<div data-testid="user-message-bubble"[^>]*>/);
    expect(bubbleMatch).not.toBeNull();
    expect(bubbleMatch![0]).not.toContain("whitespace-pre-wrap");
    expect(html).toContain("conductor-markdown conductor-markdown-user");

    // Blockquote rendered with <br/> for multi-line quote
    expect(html).toContain("<blockquote>");
    expect(html).toMatch(/引用メッセージです<br\/>\s*2行目の引用/);

    // Inline code, bold, italic, strikethrough
    expect(html).toContain("<code>pnpm check</code>");
    expect(html).toContain("<strong>重要</strong>");
    expect(html).toContain("<em>斜体</em>");
    expect(html).toContain("<del>取消</del>");

    // Lists & GFM task checkbox
    expect(html).toContain("<ul");
    expect(html).toContain("<li>項目A</li>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<ol>");

    // Links (web + local markdown)
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('title="Markdown Viewer で開く"');
    expect(html).toContain('href="/Users/dev/README.md"');

    // Fenced code block preserves code, language label, line count, and Copy button
    expect(html).toContain(">ts<");
    expect(html).toContain("2 lines");
    expect(html).toContain("Copy");
    expect(html).toContain("const answer = 42;\nconsole.log(answer);");
  });

  it("preserves single line breaks in chat paragraphs without duplicating hard breaks or breaking code blocks", () => {
    const text = [
      "1行目のテキスト",
      "2行目のテキスト",
      "3行目  ",
      "4行目",
      "",
      "```js",
      "lineA()",
      "lineB()",
      "```",
    ].join("\n");

    const html = renderToStaticMarkup(
      <MarkdownView content={text} variant="user" onOpenUrl={vi.fn()} />,
    );

    expect(html).toMatch(
      /1行目のテキスト<br\/>\s*2行目のテキスト<br\/>\s*3行目<br\/>\s*4行目/,
    );
    expect(html).not.toMatch(/<br\/>\s*<br\/>/);
    expect(html).toContain("<code>lineA()\nlineB()</code>");
    expect(html).not.toContain("lineA()<br/>");
  });

  it("safely escapes raw HTML and neutralizes dangerous URLs while preserving technical angle-bracket text", () => {
    const text = [
      "コンポーネント <UnifiedChat> と Array<string> を確認してください。",
      "",
      "<script>window.__xss = true;</script>",
      '<img src="x" onerror="alert(1)" />',
      '<span data-conductor-mention-kind="task" data-conductor-task-id="task-6">@T6</span>',
      "",
      "[危険リンク](javascript:alert(1))",
    ].join("\n");

    const html = renderChatWithMessages([makeUserMessage(text)]);

    // Technical angle-bracket text remains visible (escaped, not stripped!)
    expect(html).toContain("&lt;UnifiedChat&gt;");
    expect(html).toContain("Array&lt;string&gt;");

    // No raw <script>, <img>, or event handlers injected
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img ");
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).not.toContain("javascript:alert");
    expect(html).toContain('<a href="">危険リンク</a>');

    // Spoofed mention span in raw HTML must not turn into a clickable task button
    expect(html).not.toContain(">@T6</button>");
  });

  it("keeps above-bubble mention badges and inline mention highlights in prose/quotes while skipping mentions inside code", () => {
    const text = [
      "> @T6 の件で @web_dashboard を確認してください",
      "",
      "`@T6` はコードなのでボタン化せず、@agent_terminal_2/T6 だけボタン化します。",
      "",
      "```txt",
      "@T6 @web_dashboard",
      "```",
    ].join("\n");

    const html = renderChatWithMessages([
      makeUserMessage(text, {
        attachments: [
          {
            id: "att-1",
            kind: "image",
            label: "Screenshot.png",
            imageDataUrl: "data:image/png;base64,AAAA",
          },
        ],
      }),
    ]);

    // Above-bubble chips still render both mention badges and attachment
    expect(html).toContain('data-testid="user-message-meta-chips"');
    expect(html).toContain('data-task-code="T6"');
    expect(html).toContain('data-project-name="web_dashboard"');
    expect(html).toContain("Screenshot.png");

    // Inline mentions inside blockquote and paragraph remain highlighted
    expect(html).toContain(">@T6</button>");
    expect(html).toContain(">@agent_terminal_2/T6</button>");
    expect(html).toContain(">@web_dashboard</span>");

    // Inline code and fenced code block keep literal @T6 without button conversion
    expect(html).toContain("<code>@T6</code>");
    expect(html).toContain("<code>@T6 @web_dashboard</code>");
  });

  it("defines light and dark contrast styles for user bubble markdown elements in index.css", () => {
    const cssPath = path.resolve(__dirname, "../src/renderer/index.css");
    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).toContain(".conductor-markdown-user > :first-child");
    expect(css).toContain(".conductor-markdown-user > :last-child");
    expect(css).toContain(".conductor-markdown-user blockquote");
    expect(css).toContain(".conductor-markdown-user :not(pre) > code");
    expect(css).toContain(".conductor-markdown-user a");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });
});
