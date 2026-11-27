import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolResult {
  text: string;
  isError?: boolean;
}

export interface MCPToolCallContext {
  laneId?: string;
  assistantMessageId?: string;
  userMessageId?: string;
}

export type MCPToolHandler = (
  name: string,
  args: Record<string, unknown>,
  context?: MCPToolCallContext,
) => Promise<MCPToolResult>;

/**
 * Embedded loopback-only Streamable HTTP MCP server.
 * Exposes Conductor's project, task, worker, and real Chromium CDP browser automation tools
 * to the non-blocking Orchestrator responder threads.
 */
export class LocalMCPServer {
  public readonly bearerToken: string;
  private readonly tools: MCPToolDefinition[];
  private readonly handler: MCPToolHandler;
  private server: http.Server | null = null;
  private url: string | null = null;

  constructor(tools: MCPToolDefinition[], handler: MCPToolHandler) {
    this.tools = tools;
    this.handler = handler;
    this.bearerToken = crypto.randomBytes(24).toString("hex");
  }

  public getUrl(): string | null {
    return this.url;
  }

  public async start(): Promise<string> {
    if (this.url) return this.url;

    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}/mcp`;
    return this.url;
  }

  public async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.url = null;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
      srv.closeAllConnections?.();
    });
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const auth = req.headers.authorization;
    const queryToken = parsedUrl.searchParams.get("token");
    if (auth !== `Bearer ${this.bearerToken}` && queryToken !== this.bearerToken) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (parsedUrl.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    if (method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    if (method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    const bodyText = await new Promise<string>((resolve) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        data += chunk;
      });
      req.on("end", () => resolve(data));
    });

    let rpc: Record<string, unknown>;
    try {
      rpc = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      this.sendJsonRpc(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    const id = rpc.id;
    const rpcMethod = typeof rpc.method === "string" ? rpc.method : "";

    // Notification (no id)
    if (id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }

    switch (rpcMethod) {
      case "initialize":
        this.sendJsonRpc(res, {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "conductor", version: "0.1.0" },
          },
        });
        return;

      case "ping":
        this.sendJsonRpc(res, { jsonrpc: "2.0", id, result: {} });
        return;

      case "tools/list":
        this.sendJsonRpc(res, {
          jsonrpc: "2.0",
          id,
          result: { tools: this.tools },
        });
        return;

      case "tools/call": {
        const params = (rpc.params ?? {}) as Record<string, unknown>;
        const toolName = typeof params.name === "string" ? params.name : "";
        const args =
          typeof params.arguments === "object" && params.arguments !== null
            ? (params.arguments as Record<string, unknown>)
            : {};
        if (!toolName) {
          this.sendJsonRpc(res, {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "Missing tool name" },
          });
          return;
        }
        const readHeader = (headerName: string): string | undefined => {
          const val = req.headers[headerName];
          if (typeof val === "string" && val.trim()) return val.trim();
          if (Array.isArray(val) && val[0]?.trim()) return val[0].trim();
          return undefined;
        };
        const laneId = parsedUrl.searchParams.get("lane") ?? readHeader("x-conductor-lane");
        const assistantMessageId =
          parsedUrl.searchParams.get("assistantMessageId") ??
          readHeader("x-conductor-assistant-message-id");
        const userMessageId =
          parsedUrl.searchParams.get("userMessageId") ??
          readHeader("x-conductor-user-message-id");
        const callContext: MCPToolCallContext | undefined =
          laneId || assistantMessageId || userMessageId
            ? {
                ...(laneId ? { laneId } : {}),
                ...(assistantMessageId ? { assistantMessageId } : {}),
                ...(userMessageId ? { userMessageId } : {}),
              }
            : undefined;
        try {
          const outcome = await this.handler(toolName, args, callContext);
          this.sendJsonRpc(res, {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: outcome.text }],
              isError: Boolean(outcome.isError),
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.sendJsonRpc(res, {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: msg }],
              isError: true,
            },
          });
        }
        return;
      }

      default:
        this.sendJsonRpc(res, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${rpcMethod}` },
        });
    }
  }

  private sendJsonRpc(res: http.ServerResponse, payload: Record<string, unknown>): void {
    const body = JSON.stringify(payload);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body, "utf8"),
    });
    res.end(body);
  }
}

export function conductorMCPTools(): MCPToolDefinition[] {
  const s = (description: string) => ({ type: "string", description });
  const b = (description: string) => ({ type: "boolean", description });
  const n = (description: string) => ({ type: "number", description });
  const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object",
    properties,
    required,
  });

  return [
    {
      name: "list_projects",
      description:
        "List discovered and registered local projects (sorted by recent activity from Codex history and ~/Documents).",
      inputSchema: schema({ limit: n("Max projects to return (default 40)") }),
    },
    {
      name: "search_projects",
      description:
        "Search all auto-discovered and registered local projects by name or path substring.",
      inputSchema: schema({ query: s("Substring to match against project name or path") }, ["query"]),
    },
    {
      name: "register_project",
      description:
        "Register an existing local directory as a managed project in Conductor's persistent project list (use this whenever you discover a project path during chat).",
      inputSchema: schema({ path: s("Absolute path to local folder"), name: s("Optional display name") }, ["path"]),
    },
    {
      name: "scan_directory_projects",
      description:
        "Scan a parent directory (1 level deep) for Git repositories or project folders and add all discovered projects to Conductor's persistent project list.",
      inputSchema: schema({ directory: s("Absolute path to the parent directory to scan") }, ["directory"]),
    },
    {
      name: "list_tasks",
      description: "List all tasks currently shown in the left Agent Tasks sidebar.",
      inputSchema: schema({}),
    },
    {
      name: "create_task",
      description:
        "ONLY create a passive `queued` task card in the left sidebar WITHOUT starting a worker. Must ONLY be used when the user explicitly asks to register, memo, or queue a task without executing it yet (e.g. 'キューに入れといて', 'まだ動かさないで', 'タスクだけ登録して'). For any request to add, implement, fix, investigate, or work on something, use `start_worker` instead.",
      inputSchema: schema(
        {
          title: s("Short task title (written in Conductor's configured output language)"),
          project_name: s("Project name or General"),
          summary: s("Brief task summary (written in Conductor's configured output language)"),
          status: s("queued | running | needs_review | done | failed (default: queued)"),
          current_step: s("Current progress label (written in Conductor's configured output language)"),
          preview_url: s("Optional preview URL"),
        },
        ["title", "project_name"],
      ),
    },
    {
      name: "update_task",
      description: "Update an existing task's status, title, summary, current step, or preview URL.",
      inputSchema: schema(
        {
          task_id: s("Task ID"),
          title: s("Updated title (written in Conductor's configured output language)"),
          summary: s("Updated summary (written in Conductor's configured output language)"),
          status: s("queued | running | needs_review | done | failed"),
          current_step: s("Updated progress label (written in Conductor's configured output language)"),
          preview_url: s("Preview URL"),
        },
        ["task_id"],
      ),
    },
    {
      name: "start_worker",
      description:
        "DEFAULT tool for creating and immediately executing tasks: creates a task card in the left sidebar (or starts an existing `queued` task when `task_id` is passed) and immediately dispatches an asynchronous background coding worker in the project's directory. Use this instead of `create_task` for all implementation, fix, investigation, and work requests.",
      inputSchema: schema(
        {
          project_name: s("Registered project name"),
          project_path: s("Optional directory path if registering on the fly"),
          task_id: s("Optional existing task ID (UUID or T# code) to start an existing queued task"),
          title: s("Short task title (written in Conductor's configured output language)"),
          summary: s("Short summary (written in Conductor's configured output language)"),
          prompt: s(
            "Detailed coding/investigation instructions for the worker (for frontend/UI/style changes, the worker is automatically required to attach a screenshot or video via Markdown `![description](/abs/path/to/media.png)` in its completion report; do not narrow or override the target repository's AGENTS.md/CLAUDE.md/GEMINI.md verification or deployment policy unless the user explicitly asks to exclude specific steps)",
          ),
          provider: s("Optional agent provider override: codex | agy | claude"),
          model: s("Optional model override"),
        },
        ["prompt"],
      ),
    },
    {
      name: "send_to_worker",
      description:
        "Steer a currently running background worker with a course-correction, or send a follow-up instruction to an idle/paused task worker to continue, fix, or resume work. Use ONLY when the user explicitly wants to give additional instructions, change direction, fix something, or resume work—NEVER use this for read-only questions, status checks, or progress/error investigations (use `get_task_detail` instead).",
      inputSchema: schema(
        {
          task_id: s("Task ID (UUID or T# code)"),
          prompt: s("Steering or follow-up instruction for the worker"),
        },
        ["task_id", "prompt"],
      ),
    },
    {
      name: "stop_worker",
      description: "Interrupt a running background project worker.",
      inputSchema: schema({ task_id: s("Task ID (UUID or T# code)") }, ["task_id"]),
    },
    {
      name: "get_task_detail",
      description:
        "Strictly read-only, non-blocking inspection of a task: returns live active worker status (`is_worker_active`), task prompts, resolved worktree path, latest worker output, recent activities (with details), Git status & diff stat, and recent AGY transcript excerpts. ALWAYS use this (never `send_to_worker`) to answer questions about a task's progress, status, design, modified files, or errors immediately without waiting for task completion.",
      inputSchema: schema({ task_id: s("Task ID (UUID or T# code)") }, ["task_id"]),
    },
    // --- Real Chromium CDP Browser Automation Tools ---
    {
      name: "browser_open",
      description: "Open a URL in the right-side In-App Chromium Browser (localhost dev servers, PRs, docs).",
      inputSchema: schema(
        {
          url: s("URL to open"),
          new_tab: b("Open in a new tab (default false)"),
          task_id: s("Optional task ID to link as preview URL"),
        },
        ["url"],
      ),
    },
    {
      name: "browser_snapshot",
      description:
        "Inspect the active In-App Chromium page: returns URL, title, interactive elements with ref IDs (e1, e2, ...) for browser_click/browser_type, visible text excerpt, and console/network error counts.",
      inputSchema: schema({}),
    },
    {
      name: "browser_click",
      description:
        "Click an element in the active In-App Chromium Browser using either a ref ID from browser_snapshot (e.g. 'e3') or a CSS selector.",
      inputSchema: schema({ target: s("Ref ID (e.g. 'e3') or CSS selector") }, ["target"]),
    },
    {
      name: "browser_type",
      description:
        "Focus an input/textarea in the active In-App Chromium Browser and type text via real CDP input events.",
      inputSchema: schema(
        {
          target: s("Ref ID (e.g. 'e1') or CSS selector"),
          text: s("Text to type"),
          clear: b("Clear existing value before typing (default true)"),
          submit: b("Press Enter after typing (default false)"),
        },
        ["target", "text"],
      ),
    },
    {
      name: "browser_press_key",
      description: "Press a keyboard key in the active In-App Chromium Browser (e.g. Enter, Escape, Tab, ArrowDown).",
      inputSchema: schema({ key: s("Key name") }, ["key"]),
    },
    {
      name: "browser_scroll",
      description: "Scroll the active In-App Chromium Browser vertically by deltaY pixels (positive = down, negative = up).",
      inputSchema: schema({ delta_y: n("Pixels to scroll vertically (default 500)") }),
    },
    {
      name: "browser_screenshot",
      description: "Capture a PNG screenshot of the active In-App Chromium Browser viewport and return its saved file path.",
      inputSchema: schema({}),
    },
    {
      name: "browser_console_errors",
      description: "Return recent console errors/warnings and failed network requests (4xx/5xx) captured via CDP on the active tab.",
      inputSchema: schema({}),
    },
  ];
}
