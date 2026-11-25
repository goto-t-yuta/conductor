import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../src/main/codex-client.js";
import { listAgyModels, runAgyTurn } from "../src/main/cli-agent-runner.js";
import {
  buildOrchestratorDeveloperInstructions,
  fastestEffortForModel,
} from "../src/main/conductor-controller.js";
import { LocalMCPServer, conductorMCPTools } from "../src/main/local-mcp-server.js";
import { mergeDiscoveredProjects, scanLocalProjectSeeds } from "../src/main/project-discovery.js";
import {
  normalizeUrl,
  resolveAgyExecutable,
  resolveClaudeExecutable,
  resolveCodexExecutable,
} from "../src/main/shell-env.js";
import { StateStore } from "../src/main/state-store.js";

describe("Conductor core", () => {
  it("normalizes localhost, domains, and search queries cleanly", () => {
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("127.0.0.1:5173/login")).toBe("http://127.0.0.1:5173/login");
    expect(normalizeUrl("github.com/openai/codex")).toBe("https://github.com/openai/codex");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeUrl("electron webcontentsview")).toMatch(/^https:\/\/www\.google\.com\/search\?q=/);
  });

  it("picks low effort by default for snappy chat responses", () => {
    expect(
      fastestEffortForModel({
        id: "m1",
        model: "gpt-5.4",
        displayName: "GPT-5.4",
        description: "",
        supportedEfforts: ["minimal", "low", "medium", "high"],
        defaultEffort: "high",
        isDefault: true,
      }),
    ).toBe("low");
  });

  it("instructs Conductor to default to start_worker instead of create_task", () => {
    const instructions = buildOrchestratorDeveloperInstructions();
    expect(instructions).toContain("start_worker");
    expect(instructions).toContain("create_task");
    expect(instructions).toContain("task_id");
    expect(instructions).toContain("queued");
    expect(instructions).toContain("追加して");
    expect(instructions).toContain("やって");
    expect(instructions).toContain("キューに入れといて");
    expect(instructions).toContain("まだ動かさないで");
    expect(instructions).toContain("タスクだけ登録して");

    const tools = conductorMCPTools();
    const createTask = tools.find((t) => t.name === "create_task");
    const startWorker = tools.find((t) => t.name === "start_worker");
    expect(createTask?.description).toMatch(/passive `queued`/i);
    expect(createTask?.description).toMatch(/without starting a worker/i);
    expect(createTask?.description).toMatch(/only be used when the user explicitly asks/i);
    expect(startWorker?.description).toMatch(/default tool/i);
    expect(startWorker?.description).toContain("task_id");
    expect(startWorker?.description).toContain("queued");
  });

  it("persists and reloads state cleanly", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-test-"));
    try {
      const store = new StateStore(tmpDir);
      const initial = store.load();
      expect(initial.projects).toEqual([]);
      store.save({
        ...initial,
        showBrowserPane: false,
        chatModel: "gpt-5.4",
        chatEffort: "low",
      });
      const reloaded = store.load();
      expect(reloaded.showBrowserPane).toBe(false);
      expect(reloaded.chatModel).toBe("gpt-5.4");
      expect(reloaded.chatEffort).toBe("low");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("auto-discovers project directories and ranks Codex history ahead of plain workspace scans", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-scan-"));
    try {
      const repoA = path.join(tmpRoot, "alpha-app");
      const repoB = path.join(tmpRoot, "beta-api");
      const notRepo = path.join(tmpRoot, "random-notes");
      fs.mkdirSync(path.join(repoA, ".git"), { recursive: true });
      fs.mkdirSync(repoB, { recursive: true });
      fs.writeFileSync(path.join(repoB, "package.json"), "{}");
      fs.mkdirSync(notRepo, { recursive: true });

      const seeds = scanLocalProjectSeeds({
        roots: [{ dir: tmpRoot, requireGitOnly: false }],
      });
      const names = seeds.map((s) => s.name);
      expect(names).toContain("alpha-app");
      expect(names).toContain("beta-api");
      expect(names).not.toContain("random-notes");

      const merged = mergeDiscoveredProjects({
        existing: [],
        seeds: [
          ...seeds,
          { path: repoB, source: "codex_history", lastActiveAt: Date.now() },
        ],
        resolveGitBranchForTopN: 0,
      });
      expect(merged[0]?.name).toBe("beta-api");
      expect(merged[0]?.source).toBe("codex_history");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("serves authenticated Streamable HTTP MCP with all 17 tools", async () => {
    const server = new LocalMCPServer(conductorMCPTools(), async (name, args) => ({
      text: `ok:${name}:${String(args.target ?? args.title ?? "")}`,
    }));
    const url = await server.start();
    try {
      // Unauthorized must return 401
      const unauth = await fetch(url, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(unauth.status).toBe(401);

      const postMcp = async (payload: Record<string, unknown>) => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${server.bearerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);
        return (await res.json()) as Record<string, unknown>;
      };

      const init = await postMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect((init.result as Record<string, unknown>).serverInfo).toEqual({
        name: "conductor",
        version: "0.1.0",
      });

      const list = await postMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = (list.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.length).toBe(19);
      expect(tools.some((t) => t.name === "search_projects")).toBe(true);
      expect(tools.some((t) => t.name === "scan_directory_projects")).toBe(true);
      expect(tools.some((t) => t.name === "browser_click")).toBe(true);
      expect(tools.some((t) => t.name === "browser_console_errors")).toBe(true);

      const call = await postMcp({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "browser_click", arguments: { target: "e3" } },
      });
      const content = (call.result as { content: Array<{ text: string }> }).content;
      expect(content[0]?.text).toBe("ok:browser_click:e3");
    } finally {
      await server.stop();
    }
  });

  it("connects live to codex app-server with embedded MCP config and lists models", async () => {
    if (!resolveCodexExecutable()) return;
    const server = new LocalMCPServer(conductorMCPTools(), async () => ({ text: "{}" }));
    const url = await server.start();
    const client = new CodexAppServerClient("vitest-smoke");
    try {
      await client.connect({
        serverName: "conductor",
        url,
        bearerTokenEnvVar: "CONDUCTOR_MCP_TOKEN",
        bearerToken: server.bearerToken,
      });
      const models = await client.listModels();
      expect(models.length).toBeGreaterThan(0);
    } finally {
      client.stop();
      await server.stop();
    }
  }, 30_000);

  it("detects agy and claude binaries and streams a live agy turn", async () => {
    const agyPath = resolveAgyExecutable();
    const claudePath = resolveClaudeExecutable();
    expect(agyPath === null || fs.existsSync(agyPath)).toBe(true);
    expect(claudePath === null || fs.existsSync(claudePath)).toBe(true);

    if (!agyPath) return;
    const models = await listAgyModels();
    expect(models.length).toBeGreaterThan(0);

    const outcome = await new Promise<{ ok: boolean; finalText: string }>((resolve) => {
      runAgyTurn(
        {
          cwd: os.tmpdir(),
          prompt: "Reply with just the single word OK.",
          model: "gemini-3.8-flash-low",
        },
        {
          onComplete: (res) => resolve({ ok: res.ok, finalText: res.finalText }),
        },
      );
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.finalText.toUpperCase()).toContain("OK");
  }, 30_000);
});
