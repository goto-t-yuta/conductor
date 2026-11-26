/**
 * Captures sanitized, clean English light-theme README screenshots of Conductor's
 * real React UI using Electron + built dist/renderer bundle.
 *
 * Usage:
 *   pnpm build:renderer && npx electron scripts/capture-readme-screenshots.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeTheme } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rendererDir = path.join(rootDir, "dist", "renderer");
const outDir = path.join(rootDir, "docs", "images");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

const ARCHITECTURE_MD = `# Acme Web — Architecture Overview

> Live-reloaded in Conductor's project-scoped Markdown Viewer.

## Parallel Worktree Flow

Conductor runs every coding task in an isolated **Git worktree** so multiple agents can build features simultaneously without colliding on the main checkout.

- [x] **T1** — Migrate Tailwind v4 tokens (\`design-kit\`)
- [x] **T2** — Exponential webhook retry backoff (\`pulse-api\` · PR #48)
- [x] **T3** — Real-time analytics overview (\`acme-web\` · Auto-landed)
- [ ] **T4** — OAuth PKCE silent token refresh (in progress)

## Refresh Concurrency Guard

\`\`\`ts
export class SingleFlightRefreshClient {
  private inflight: Promise<AuthTokens> | null = null;

  async getFreshToken(): Promise<AuthTokens> {
    if (!this.inflight) {
      this.inflight = this.requestNewToken().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }
}
\`\`\`

## Verification Checklist

| Check | Scope | Status |
| --- | --- | --- |
| TypeScript (\`pnpm typecheck\`) | Main & Renderer | Passed |
| Unit & UI Tests (\`pnpm test\`) | 42 suites | Passed |
| In-App Chromium Inspection | \`/analytics\` | 0 console errors |
`;

const ANALYTICS_DASHBOARD_HTML = `
<div id="demo-analytics-preview" style="height:100%;width:100%;overflow:auto;background:#f8fafc;padding:18px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif;color:#0f172a;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="width:30px;height:30px;border-radius:8px;background:#2563eb;color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;justify-content:center;">A</div>
      <div>
        <div style="font-size:15px;font-weight:700;line-height:1.2;">Acme Analytics</div>
        <div style="font-size:11px;color:#64748b;">localhost:5173/analytics · Live HMR</div>
      </div>
    </div>
    <div style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:#dcfce7;color:#15803d;font-size:11px;font-weight:600;">
      <span style="width:6px;height:6px;border-radius:999px;background:#16a34a;"></span>
      99.98% Uptime
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px;">
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.04em;color:#64748b;text-transform:uppercase;">Active Sessions</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px;letter-spacing:-0.02em;">14,820</div>
      <div style="font-size:11px;font-weight:600;color:#16a34a;margin-top:3px;">+18.4% vs last week</div>
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.04em;color:#64748b;text-transform:uppercase;">API P95 Latency</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px;letter-spacing:-0.02em;">42 ms</div>
      <div style="font-size:11px;font-weight:600;color:#16a34a;margin-top:3px;">-11 ms after cache</div>
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.04em;color:#64748b;text-transform:uppercase;">Webhook Delivery</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px;letter-spacing:-0.02em;">99.94%</div>
      <div style="font-size:11px;font-weight:600;color:#16a34a;margin-top:3px;">+0.6% with retries</div>
    </div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin-bottom:14px;">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;">
      <div>
        <div style="font-size:13px;font-weight:700;">Requests per Hour (UTC)</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">Auto-refreshed via WebSocket stream</div>
      </div>
      <div style="font-size:11px;font-weight:600;color:#4f46e5;">Last 12h</div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(10,1fr);gap:8px;align-items:end;height:132px;padding-top:8px;">
      ${[
        { h: 68, t: "02:00", c: "#4f46e5" },
        { h: 82, t: "04:00", c: "#4f46e5" },
        { h: 58, t: "06:00", c: "#4f46e5" },
        { h: 96, t: "08:00", c: "#4f46e5" },
        { h: 108, t: "10:00", c: "#4f46e5" },
        { h: 108, t: "12:00", c: "#4f46e5" },
        { h: 108, t: "14:00", c: "#4f46e5" },
        { h: 112, t: "16:00", c: "#059669" },
        { h: 108, t: "18:00", c: "#4f46e5" },
        { h: 96, t: "20:00", c: "#4f46e5" },
      ]
        .map(
          (bar) =>
            `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
              <div style="width:100%;height:${bar.h}px;border-radius:6px 6px 3px 3px;background:${bar.c};"></div>
              <span style="font-size:10px;color:#64748b;font-variant-numeric:tabular-nums;">${bar.t}</span>
            </div>`,
        )
        .join("")}
    </div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
      <div style="font-size:13px;font-weight:700;">Recent Deployments</div>
      <div style="font-size:11px;color:#64748b;">Synced from Git</div>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:11.5px;">
      <thead>
        <tr style="color:#64748b;border-bottom:1px solid #e2e8f0;text-align:left;">
          <th style="padding:6px 4px;font-weight:500;">Branch</th>
          <th style="padding:6px 4px;font-weight:500;">Service</th>
          <th style="padding:6px 4px;font-weight:500;">Duration</th>
          <th style="padding:6px 4px;font-weight:500;text-align:right;">Status</th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:8px 4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">conductor/t3-analytics-ui</td>
          <td style="padding:8px 4px;">acme-web</td>
          <td style="padding:8px 4px;color:#64748b;">28s</td>
          <td style="padding:8px 4px;text-align:right;"><span style="padding:2px 8px;border-radius:999px;background:#dcfce7;color:#15803d;font-weight:600;font-size:10.5px;">Ready</span></td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9;">
          <td style="padding:8px 4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">conductor/t4-oauth-pkce</td>
          <td style="padding:8px 4px;">acme-web</td>
          <td style="padding:8px 4px;color:#64748b;">19s</td>
          <td style="padding:8px 4px;text-align:right;"><span style="padding:2px 8px;border-radius:999px;background:#e0e7ff;color:#4338ca;font-weight:600;font-size:10.5px;">Testing</span></td>
        </tr>
        <tr>
          <td style="padding:8px 4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">feat/webhook-backoff</td>
          <td style="padding:8px 4px;">pulse-api</td>
          <td style="padding:8px 4px;color:#64748b;">34s</td>
          <td style="padding:8px 4px;text-align:right;"><span style="padding:2px 8px;border-radius:999px;background:#ecfdf5;color:#047857;font-weight:600;font-size:10.5px;">PR #48</span></td>
        </tr>
      </tbody>
    </table>
  </div>
</div>
`;

function buildDemoSnapshot() {
  const projects = [
    {
      id: "proj-acme-web",
      name: "acme-web",
      path: "/workspace/acme-web",
      colorHex: "#3B82F6",
      gitBranch: "main",
      addedAt: "2026-11-26T08:00:00.000Z",
    },
    {
      id: "proj-pulse-api",
      name: "pulse-api",
      path: "/workspace/pulse-api",
      colorHex: "#10B981",
      gitBranch: "main",
      integrationMode: "per-task-pr",
      addedAt: "2026-11-26T08:00:00.000Z",
    },
    {
      id: "proj-design-kit",
      name: "design-kit",
      path: "/workspace/design-kit",
      colorHex: "#8B5CF6",
      gitBranch: "main",
      addedAt: "2026-11-26T08:00:00.000Z",
    },
  ];

  const tasks = [
    {
      id: "task-4",
      taskNumber: 4,
      title: "Add OAuth PKCE silent token refresh",
      summary: "Implement SingleFlightRefreshClient with jittered retry backoff.",
      projectId: "proj-acme-web",
      projectName: "acme-web",
      projectPath: "/workspace/acme-web",
      status: "running",
      provider: "codex",
      currentStep: "Running vitest auth refresh test suite (18/20)...",
      workerThreadId: "thr-4",
      activeTurnId: "turn-4",
      previewURL: "http://localhost:5173/analytics",
      latestOutput: "",
      activities: [],
      worktreePath: "/workspace/.conductor/worktrees/t4-oauth-pkce",
      worktreeBranch: "conductor/t4-oauth-pkce",
      baseBranch: "main",
      landStatus: "unlanded",
      createdAt: "2026-11-26T11:02:00.000Z",
      updatedAt: "2026-11-26T11:09:00.000Z",
    },
    {
      id: "task-3",
      taskNumber: 3,
      title: "Build real-time analytics overview dashboard",
      summary: "Created KPI summary cards, 12-hour traffic chart, deployment table, and WebSocket live refresh.",
      projectId: "proj-acme-web",
      projectName: "acme-web",
      projectPath: "/workspace/acme-web",
      status: "needs_review",
      provider: "agy",
      currentStep: "Auto-landed on conductor/t3-analytics-ui",
      workerThreadId: null,
      activeTurnId: null,
      previewURL: "http://localhost:5173/analytics",
      latestOutput: [
        "### Summary",
        "",
        "- Built `AnalyticsOverview.tsx` with KPI cards, hourly traffic bar chart, and live deployment status table.",
        "- Verified layout & zero console errors in In-App Chromium Browser (`http://localhost:5173/analytics`).",
        "- Updated `/workspace/acme-web/docs/ARCHITECTURE.md` with data-flow notes.",
        "- `pnpm typecheck && pnpm test` passed (42/42).",
      ].join("\n"),
      activities: [],
      worktreePath: "/workspace/.conductor/worktrees/t3-analytics-ui",
      worktreeBranch: "conductor/t3-analytics-ui",
      baseBranch: "main",
      landStatus: "landed",
      landedBranch: "conductor/t3-analytics-ui",
      landedCommit: "4c8e91d8a0f2",
      createdAt: "2026-11-26T10:20:00.000Z",
      updatedAt: "2026-11-26T11:04:00.000Z",
    },
    {
      id: "task-2",
      taskNumber: 2,
      title: "Add exponential backoff for webhook retries",
      summary: "Added jittered retry queue and dead-letter alert hook.",
      projectId: "proj-pulse-api",
      projectName: "pulse-api",
      projectPath: "/workspace/pulse-api",
      status: "needs_review",
      provider: "claude",
      currentStep: "PR #48 created · checks passing",
      workerThreadId: null,
      activeTurnId: null,
      previewURL: null,
      latestOutput: "Opened PR #48 with full retry backoff test coverage.",
      activities: [],
      worktreePath: "/workspace/.conductor/worktrees/t2-webhook-backoff",
      worktreeBranch: "conductor/t2-webhook-backoff",
      baseBranch: "main",
      landStatus: "pr_created",
      prUrl: "https://github.com/acme/pulse-api/pull/48",
      createdAt: "2026-11-26T09:40:00.000Z",
      updatedAt: "2026-11-26T10:35:00.000Z",
    },
    {
      id: "task-1",
      taskNumber: 1,
      title: "Migrate Tailwind v4 design tokens",
      summary: "Updated semantic color scales and verified light/dark contrast.",
      projectId: "proj-design-kit",
      projectName: "design-kit",
      projectPath: "/workspace/design-kit",
      status: "done",
      provider: "codex",
      currentStep: "Completed",
      workerThreadId: null,
      activeTurnId: null,
      previewURL: null,
      latestOutput: "All visual regression snapshots passed.",
      activities: [],
      landStatus: "landed",
      landedBranch: "conductor/t1-design-tokens",
      createdAt: "2026-11-26T08:30:00.000Z",
      updatedAt: "2026-11-26T09:15:00.000Z",
    },
  ];

  const messages = [
    {
      id: "msg-ev-3",
      role: "taskEvent",
      provider: "agy",
      relatedTaskId: "task-3",
      text: [
        "**[T3 · acme-web · AGY] Build real-time analytics overview dashboard** — Completed (Needs Review)  ",
        "Auto-landed cleanly onto `conductor/t3-analytics-ui` (42/42 tests passed).",
        "",
        "- Preview: http://localhost:5173/analytics",
        "- Docs: [ARCHITECTURE.md](/workspace/acme-web/docs/ARCHITECTURE.md)",
      ].join("\n"),
      attachments: [],
      toolChips: [],
      isStreaming: false,
      createdAt: "2026-11-26T11:04:00.000Z",
    },
    {
      id: "msg-u-1",
      role: "user",
      text: "While the OAuth refresh worker is running, how does it avoid race conditions when multiple requests get 401 simultaneously?",
      attachments: [],
      mentions: [
        {
          kind: "task",
          taskId: "task-4",
          taskNumber: 4,
          taskTitle: "Add OAuth PKCE silent token refresh",
          taskStatus: "running",
          projectId: "proj-acme-web",
          projectName: "acme-web",
          projectPath: "/workspace/acme-web",
          projectColorHex: "#3B82F6",
        },
      ],
      toolChips: [],
      isStreaming: false,
      createdAt: "2026-11-26T11:08:50.000Z",
    },
    {
      id: "msg-a-1",
      role: "assistant",
      provider: "codex",
      replyToMessageId: "msg-u-1",
      replyToSnippet: "While the OAuth refresh worker is running, ...",
      text: [
        "Checked `T4` via read-only inspection (without interrupting the running worker):",
        "",
        "1. `SingleFlightRefreshClient` caches a single in-flight `refreshPromise` while a refresh is active.",
        "2. Concurrent `401` callers await the same promise and replay once with the rotated access token.",
        "3. If refresh fails with a transient 5xx, it retries with jittered backoff before failing queued callers.",
      ].join("\n"),
      attachments: [],
      toolChips: [
        {
          id: "chip-1",
          toolName: "get_task_detail",
          label: "get_task_detail · T4 (read-only)",
          detail: null,
          isCompleted: true,
          isError: false,
        },
      ],
      isStreaming: false,
      createdAt: "2026-11-26T11:09:00.000Z",
    },
  ];

  return {
    projects,
    scanRoots: ["/workspace"],
    tasks,
    messages,
    activeChatSessionId: "sess-demo",
    chatSessions: [
      {
        id: "sess-demo",
        title: "Acme Web & Pulse API Sprint",
        preview: "Checked T4 via read-only inspection",
        messageCount: messages.length,
        createdAt: "2026-11-26T10:00:00.000Z",
        updatedAt: "2026-11-26T11:09:00.000Z",
        provider: "codex",
      },
    ],
    browserTabs: [
      {
        id: "bt-acme",
        title: "Acme Analytics",
        url: "http://localhost:5173/analytics",
        projectId: "proj-acme-web",
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
        consoleErrorCount: 0,
        networkErrorCount: 0,
      },
    ],
    activeBrowserTabId: "bt-acme",
    isPickingElement: false,
    showTaskSidebar: true,
    showBrowserPane: true,
    isConnected: true,
    connectionStatus: "Codex / AGY / Claude ready",
    activeResponderCount: 0,
    providers: {
      codex: {
        id: "codex",
        label: "Codex",
        available: true,
        detail: "Connected",
        models: [
          {
            id: "gpt-5.3-codex",
            model: "gpt-5.3-codex",
            displayName: "GPT-5.3 Codex",
            description: "",
            supportedEfforts: ["low", "medium", "high"],
            defaultEffort: "low",
            isDefault: true,
          },
        ],
      },
      agy: { id: "agy", label: "AGY", available: true, detail: "Available", models: [] },
      claude: { id: "claude", label: "Claude", available: true, detail: "Available", models: [] },
    },
    chatProvider: "codex",
    workerProvider: "agy",
    models: [
      {
        id: "gpt-5.3-codex",
        model: "gpt-5.3-codex",
        displayName: "GPT-5.3 Codex",
        description: "",
        supportedEfforts: ["low", "medium", "high"],
        defaultEffort: "low",
        isDefault: true,
      },
    ],
    chatModel: "gpt-5.3-codex",
    chatEffort: "low",
    workerModel: null,
    workerEffort: null,
    defaultIntegrationMode: "feature-branch",
    autoLandOnComplete: true,
    preferredLanguage: "en",
    lastErrorBanner: null,
  };
}

function startPatchedServer(mockScript) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || "/").split("?")[0];
      if (urlPath === "/" || urlPath === "/index.html") {
        const rawHtml = fs.readFileSync(path.join(rendererDir, "index.html"), "utf8");
        const injected = rawHtml.replace("<head>", `<head><script>${mockScript}</script>`);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(injected);
        return;
      }
      const relPath = urlPath.replace(/^\/+/, "");
      const filePath = path.join(rendererDir, relPath);
      if (!filePath.startsWith(rendererDir) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function buildMockInitScript(snapshot) {
  const mdDoc = {
    filePath: "/workspace/acme-web/docs/ARCHITECTURE.md",
    fileName: "ARCHITECTURE.md",
    content: ARCHITECTURE_MD,
    mtimeMs: Date.parse("2026-11-26T02:19:44.000Z"),
    sizeBytes: Buffer.byteLength(ARCHITECTURE_MD, "utf8"),
  };

  const worktreeStatus = {
    hasWorktree: true,
    worktreeExists: true,
    worktreePath: "/workspace/.conductor/worktrees/t3-analytics-ui",
    worktreeBranch: "conductor/t3-analytics-ui",
    parentBranch: "main",
    parentDirty: false,
    worktreeDirty: false,
    changedFilesCount: 0,
    aheadCommits: 2,
    diffSummary: "6 files changed, 248 insertions(+), 31 deletions(-)",
    effectiveMode: "feature-branch",
    suggestedTargetBranch: "conductor/t3-analytics-ui",
    ghAvailable: true,
  };

  const persistedWorkspace = {
    version: 1,
    activeProjectScope: "proj-acme-web",
    workspaces: {
      "proj-acme-web": {
        tabOrder: [
          "browser:bt-acme",
          "markdown:/workspace/acme-web/docs/ARCHITECTURE.md",
        ],
        activeTabId: "browser:bt-acme",
      },
    },
    openMarkdownFiles: [
      {
        filePath: "/workspace/acme-web/docs/ARCHITECTURE.md",
        projectScope: "proj-acme-web",
      },
    ],
  };

  return `
    (function() {
      try {
        window.localStorage.clear();
        window.localStorage.setItem("conductor:rightPaneWorkspace:v1", ${JSON.stringify(JSON.stringify(persistedWorkspace))});
        window.localStorage.setItem("conductor:recentMarkdownFiles", ${JSON.stringify(JSON.stringify(["/workspace/acme-web/docs/ARCHITECTURE.md"]))});
      } catch (e) {}

      const snap = ${JSON.stringify(snapshot)};
      const mdDoc = ${JSON.stringify(mdDoc)};
      const wtStatus = ${JSON.stringify(worktreeStatus)};
      const noop = async () => {};
      const unsub = () => () => {};

      window.conductor = {
        getSnapshot: async () => snap,
        onSnapshot: unsub,
        onAttachmentFromBrowser: unsub,
        onShortcut: unsub,
        reconnect: noop,
        setChatProvider: noop,
        setWorkerProvider: noop,
        setChatModel: noop,
        setWorkerModel: noop,
        dismissError: noop,
        setLayout: noop,
        addProjectDialog: async () => [],
        scanDirectoryDialog: async () => [],
        rescanProjects: noop,
        removeProject: noop,
        openPathInFinder: noop,
        sendMessage: noop,
        stopMessage: noop,
        stopAllResponders: noop,
        startFreshChat: noop,
        selectChatSession: noop,
        deleteChatSession: noop,
        pickLocalImages: async () => [],
        savePastedImage: async () => null,
        setDefaultIntegrationMode: noop,
        setAutoLandOnComplete: noop,
        setProjectIntegrationMode: noop,
        setPreferredLanguage: noop,
        updateTaskStatus: async () => ({ ok: true }),
        stopTaskWorker: noop,
        deleteTask: noop,
        getTaskGitStatus: async () => null,
        getTaskWorktreeStatus: async () => wtStatus,
        landTask: async () => ({ ok: true, mode: "feature-branch", action: "landed", message: "Landed" }),
        resolveTaskConflictWithAI: async () => ({ ok: true }),
        cleanupTaskWorktree: async () => ({ ok: true }),
        browserSetBounds: noop,
        browserNavigate: noop,
        browserNewTab: noop,
        browserSelectTab: noop,
        browserCloseTab: noop,
        browserBack: noop,
        browserForward: noop,
        browserReload: noop,
        browserToggleDevTools: noop,
        browserToggleElementPicker: noop,
        browserCaptureScreenshot: async () => null,
        browserGetConsoleAttachment: async () => null,
        browserOpenExternal: noop,
        markdownOpenDialog: async () => [],
        markdownReadFile: async (fp) => ({ ok: true, filePath: fp, document: mdDoc }),
        markdownWriteFile: async (fp) => ({ ok: true, filePath: fp, document: mdDoc }),
        markdownWatchFile: async (fp) => ({ ok: true, filePath: fp }),
        markdownUnwatch: noop,
        onMarkdownFileChanged: unsub,
        imageReadFile: async (fp) => ({ ok: false, filePath: fp, error: "Not found" }),
        fsListDir: async (dir) => ({ ok: true, dirPath: dir, entries: [] }),
        fsReadTextFile: async (fp) => ({ ok: false, filePath: fp, error: "Not found" }),
        getPathForFile: () => "",
      };
    })();
  `;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function injectAnalyticsPreview(win) {
  await win.webContents.executeJavaScript(`
    (() => {
      const rightPane = document.querySelector('[data-testid="unified-right-pane"]');
      if (!rightPane) return false;
      const toolbar = rightPane.querySelector('[data-testid="browser-inspection-toolbar"]');
      if (!toolbar) return false;
      const canvas = toolbar.nextElementSibling;
      if (!canvas) return false;
      canvas.innerHTML = ${JSON.stringify(ANALYTICS_DASHBOARD_HTML)};
      return true;
    })();
  `);
}

async function assertNoJapaneseInDom(win, label) {
  const result = await win.webContents.executeJavaScript(`
    (() => {
      const text = document.body.innerText || "";
      const re = /[\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff]+/g;
      const matches = text.match(re) || [];
      return { matches: Array.from(new Set(matches)), length: text.length };
    })();
  `);
  if (result.matches.length > 0) {
    throw new Error(`Japanese text found in ${label}: ${JSON.stringify(result.matches)}`);
  }
  console.log(`[capture] verified 0 Japanese strings in ${label} (${result.length} chars)`);
}

async function capturePng(win, filename) {
  const image = await win.webContents.capturePage();
  const target = path.join(outDir, filename);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(target, image.toPNG());
  console.log(`[capture] wrote ${target} (${image.getSize().width}x${image.getSize().height})`);
}

app.whenReady().then(async () => {
  if (!fs.existsSync(path.join(rendererDir, "index.html"))) {
    console.error("dist/renderer/index.html missing — run `pnpm build:renderer` first.");
    app.exit(1);
    return;
  }

  nativeTheme.themeSource = "light";
  const snapshot = buildDemoSnapshot();
  const mockScript = buildMockInitScript(snapshot);
  const { server: patchedServer, port: patchedPort } = await startPatchedServer(mockScript);

  const win = new BrowserWindow({
    width: 1540,
    height: 880,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on("dom-ready", () => {
    void win.webContents.executeJavaScript(`
      document.documentElement.classList.remove("dark");
    `);
  });

  try {
    await win.loadURL(`http://127.0.0.1:${patchedPort}/`);
    await sleep(900);

    // Ensure browser tab is active and render the sanitized Acme Analytics dashboard preview
    await win.webContents.executeJavaScript(`
      (() => {
        const browserTab = document.querySelector('[data-testid="unified-tab-browser"]');
        if (browserTab) browserTab.click();
      })();
    `);
    await sleep(300);
    await injectAnalyticsPreview(win);
    await sleep(300);

    // 1. Capture Overview screenshot
    await assertNoJapaneseInDom(win, "conductor-overview.png");
    await capturePng(win, "conductor-overview.png");

    // 2. Capture Worktree Inspector Modal screenshot (keeps analytics preview blurred behind modal!)
    await win.webContents.executeJavaScript(`
      (() => {
        const btn = document.querySelector('[data-testid="task-event-open-detail"]');
        if (btn) btn.click();
      })();
    `);
    await sleep(450);
    await assertNoJapaneseInDom(win, "conductor-worktree-inspector.png");
    await capturePng(win, "conductor-worktree-inspector.png");

    // Close modal & switch right pane to ARCHITECTURE.md Markdown Viewer tab
    await win.webContents.executeJavaScript(`
      (() => {
        const overlay = document.querySelector('.fixed.inset-0.z-50');
        if (overlay) overlay.click();
      })();
    `);
    await sleep(250);
    await win.webContents.executeJavaScript(`
      (() => {
        const mdTab = document.querySelector('[data-testid="unified-tab-markdown"]');
        if (mdTab) mdTab.click();
      })();
    `);
    await sleep(450);

    // 3. Capture Markdown Viewer screenshot
    await assertNoJapaneseInDom(win, "conductor-markdown-viewer.png");
    await capturePng(win, "conductor-markdown-viewer.png");
  } finally {
    win.destroy();
    patchedServer.close();
    app.exit(0);
  }
});
