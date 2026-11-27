import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildTaskCompletionExcerpt,
  buildWorkerDeveloperInstructions,
  buildWorkerVisualVerificationInstruction,
} from "../src/main/conductor-controller.js";
import { conductorMCPTools } from "../src/main/local-mcp-server.js";
import {
  buildConductorMediaUrl,
  getMimeTypeForVideoPath,
  getPlaybackContentTypeForVideoPath,
  handleConductorMediaRequest,
  parseHttpByteRange,
  readLocalVideoFile,
  resolveLocalVideoPath,
} from "../src/main/media-viewer.js";
import { conductorUrlTransform, MarkdownView } from "../src/renderer/components/MarkdownView.js";
import { TaskInspectorModal } from "../src/renderer/components/TaskInspectorModal.js";
import { TaskEventCard } from "../src/renderer/components/UnifiedChat.js";
import { MarkdownImageCache } from "../src/renderer/lib/markdown-image-cache.js";
import {
  classifyMarkdownVideoSrc,
  isVideoPathOrUrl,
  normalizeMarkdownSpacedMediaDestinations,
} from "../src/renderer/lib/markdown-utils.js";
import { MarkdownVideoCache } from "../src/renderer/lib/markdown-video-cache.js";
import { buildTaskMarkdownBasePath } from "../src/renderer/lib/task-event.js";
import { t } from "../src/shared/i18n.js";
import type { AgentTask, ChatMessage } from "../src/shared/types.js";

function makeSampleTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "task-ui-1",
    taskNumber: 12,
    title: "UI メディア表示対応",
    summary: "完了報告でスクリーンショットと動画をインライン表示",
    projectId: "proj-1",
    projectName: "conductor",
    projectPath: "/workspace/conductor",
    worktreePath: "/workspace/worktrees/task-12",
    worktreeBranch: "conductor/task-12",
    status: "needs_review",
    provider: "agy",
    currentStep: "完了（確認待ち）",
    workerThreadId: null,
    activeTurnId: null,
    previewURL: null,
    latestOutput: "",
    activities: [],
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T01:00:00.000Z",
    ...overrides,
  };
}

describe("Worker visual verification instructions", () => {
  it("instructs workers to capture and attach screenshots or videos for frontend/UI changes", () => {
    const visualRule = buildWorkerVisualVerificationInstruction();
    expect(visualRule).toMatch(/screenshot/i);
    expect(visualRule).toMatch(/video/i);
    expect(visualRule).toContain("![Updated UI](/absolute/path/to/screenshot.png)");
    expect(visualRule).toMatch(/\.mp4/i);
    expect(visualRule).toMatch(/\.webm/i);
    expect(visualRule).toMatch(/\.mov/i);
    expect(visualRule).toMatch(/technically impossible/i);

    const worktreeInstructions = buildWorkerDeveloperInstructions({
      projectName: "conductor",
      cwd: "/tmp/wt/t1",
      worktreeBranch: "conductor/t1",
      preferredLanguage: "ja",
    });
    expect(worktreeInstructions).toContain(visualRule);

    const directInstructions = buildWorkerDeveloperInstructions({
      projectName: "conductor",
      cwd: "/tmp/conductor",
      preferredLanguage: "en",
    });
    expect(directInstructions).toContain(visualRule);

    const startWorkerTool = conductorMCPTools().find((tool) => tool.name === "start_worker");
    const promptDesc = String(
      ((startWorkerTool?.inputSchema as Record<string, unknown>)?.properties as Record<
        string,
        { description?: string }
      >)?.prompt?.description ?? "",
    );
    expect(promptDesc).toMatch(/screenshot or video/i);
  });
});

describe("buildTaskCompletionExcerpt", () => {
  it("returns short output untouched and truncates long text cleanly without losing trailing images/videos", () => {
    const short = "変更完了しました。\n![After](/tmp/after.png)";
    expect(buildTaskCompletionExcerpt(short)).toBe(short);

    const longProse = "フロントエンドのスタイルとレイアウトを更新し、テストとビルドを確認しました。".repeat(20);
    const withMedia = [
      longProse,
      "",
      "![変更後の画面](/Users/dev/Library/Application Support/Conductor/shots/after-ui.png)",
      "",
      "![操作デモ動画](/Users/dev/shots/demo.mp4)",
    ].join("\n");

    const excerpt = buildTaskCompletionExcerpt(withMedia, 160);
    expect(excerpt).toContain("…");
    expect(excerpt).toContain(
      "![変更後の画面](/Users/dev/Library/Application Support/Conductor/shots/after-ui.png)",
    );
    expect(excerpt).toContain("![操作デモ動画](/Users/dev/shots/demo.mp4)");
  });

  it("never cuts through the middle of a Markdown image/video token and avoids duplicating already-visible media", () => {
    const prefix = "a".repeat(80);
    const imgA = "![First](/Users/dev/first.png)";
    const imgB = "![Second](/Users/dev/second.webm)";
    const text = `${prefix} ${imgA} ${"b".repeat(120)} ${imgB} ${imgA}`;

    // Cutoff at 95 lands right inside imgA (starts at 81, ends at 111)
    const excerpt = buildTaskCompletionExcerpt(text, 95);
    expect(excerpt).not.toContain("![First](/Users/de…");
    expect(excerpt).toContain(imgA);
    expect(excerpt).toContain(imgB);
    // imgA must only appear once
    expect(excerpt.split(imgA).length - 1).toBe(1);
  });

  it("ignores media examples inside fenced code blocks and closes unclosed fences before appending real media", () => {
    const output = [
      "実装メモ:",
      "```markdown",
      "![Example Inside Fence](/fake/example.png)",
      "x".repeat(200),
      "```",
      "",
      "![Real Screenshot](/Users/dev/real-shot.png)",
      '<video src="/Users/dev/real-demo.mov" controls></video>',
    ].join("\n");

    const excerpt = buildTaskCompletionExcerpt(output, 100);
    // Fence must be closed before appending real media
    expect(excerpt).toContain("```");
    expect(excerpt).toContain("![Real Screenshot](/Users/dev/real-shot.png)");
    expect(excerpt).toContain('<video src="/Users/dev/real-demo.mov" controls></video>');
    // Fake example inside code fence should not be appended outside the fence
    const realIndex = excerpt.indexOf("![Real Screenshot](/Users/dev/real-shot.png)");
    expect(excerpt.slice(realIndex)).not.toContain("/fake/example.png");
  });
});

describe("Local video resolver & conductor-media protocol handler", () => {
  it("resolves and validates .mp4, .webm, .mov paths and blocks symlinks to non-video files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-video-test-"));
    try {
      const mp4Path = path.join(tmpDir, "demo.mp4");
      const webmPath = path.join(tmpDir, "walkthrough.webm");
      const movPath = path.join(tmpDir, "画面 録画.mov");
      fs.writeFileSync(mp4Path, Buffer.from("0123456789abcdef"));
      fs.writeFileSync(webmPath, Buffer.from("webm-bytes"));
      fs.writeFileSync(movPath, Buffer.from("mov-bytes"));

      expect(getMimeTypeForVideoPath(mp4Path)).toBe("video/mp4");
      expect(getMimeTypeForVideoPath(webmPath)).toBe("video/webm");
      expect(getMimeTypeForVideoPath(movPath)).toBe("video/quicktime");
      expect(getPlaybackContentTypeForVideoPath(movPath)).toBe("video/mp4");
      expect(getMimeTypeForVideoPath("shot.png")).toBeNull();

      const readMp4 = readLocalVideoFile(mp4Path);
      expect(readMp4.ok).toBe(true);
      expect(readMp4.mimeType).toBe("video/mp4");
      expect(readMp4.mediaUrl).toBe(buildConductorMediaUrl(fs.realpathSync(mp4Path)));

      const readViaFileUrl = readLocalVideoFile(pathToFileURL(movPath).toString());
      expect(readViaFileUrl.ok).toBe(true);
      expect(readViaFileUrl.fileName).toBe("画面 録画.mov");

      // Relative path with virtual baseFilePath
      const readRelative = readLocalVideoFile("./walkthrough.webm", path.join(tmpDir, "__task_report__.md"));
      expect(readRelative.ok).toBe(true);
      expect(readRelative.filePath).toBe(webmPath);

      // Symlink to non-video file is rejected
      const secretTxt = path.join(tmpDir, "secret.txt");
      fs.writeFileSync(secretTxt, "top secret");
      const evilLink = path.join(tmpDir, "fake.mp4");
      fs.symlinkSync(secretTxt, evilLink);
      expect(readLocalVideoFile(evilLink).ok).toBe(false);

      // Unsupported / invalid paths rejected
      expect(resolveLocalVideoPath("/etc/passwd").ok).toBe(false);
      expect(resolveLocalVideoPath("relative.mp4").ok).toBe(false);
      expect(resolveLocalVideoPath("/tmp/bad\0.mp4").ok).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("streams local videos with 200 OK, 206 Partial Content Range support, HEAD, and 403/404/416 guards", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-media-proto-"));
    try {
      const mp4Path = path.join(tmpDir, "clip.mp4");
      const movPath = path.join(tmpDir, "clip.mov");
      const txtPath = path.join(tmpDir, "note.txt");
      fs.writeFileSync(mp4Path, Buffer.from("0123456789ABCDEF"));
      fs.writeFileSync(movPath, Buffer.from("MOVDATA"));
      fs.writeFileSync(txtPath, "hello");

      expect(parseHttpByteRange("bytes=0-3", 16)).toEqual({ start: 0, end: 3 });
      expect(parseHttpByteRange("bytes=10-", 16)).toEqual({ start: 10, end: 15 });
      expect(parseHttpByteRange("bytes=-4", 16)).toEqual({ start: 12, end: 15 });
      expect(parseHttpByteRange("bytes=20-30", 16)).toBe("invalid");

      // Full GET
      const fullRes = await handleConductorMediaRequest(new Request(buildConductorMediaUrl(mp4Path)));
      expect(fullRes.status).toBe(200);
      expect(fullRes.headers.get("content-type")).toBe("video/mp4");
      expect(fullRes.headers.get("accept-ranges")).toBe("bytes");
      expect(await fullRes.text()).toBe("0123456789ABCDEF");

      // Range GET (206 Partial Content)
      const rangeRes = await handleConductorMediaRequest(
        new Request(buildConductorMediaUrl(mp4Path), { headers: { Range: "bytes=4-9" } }),
      );
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("content-range")).toBe("bytes 4-9/16");
      expect(rangeRes.headers.get("content-length")).toBe("6");
      expect(await rangeRes.text()).toBe("456789");

      // HEAD for .mov serves video/mp4 playback content-type with empty body
      const headMov = await handleConductorMediaRequest(
        new Request(buildConductorMediaUrl(movPath), { method: "HEAD" }),
      );
      expect(headMov.status).toBe(200);
      expect(headMov.headers.get("content-type")).toBe("video/mp4");
      expect(headMov.headers.get("content-length")).toBe("7");

      // Invalid range returns 416
      const badRange = await handleConductorMediaRequest(
        new Request(buildConductorMediaUrl(mp4Path), { headers: { Range: "bytes=100-200" } }),
      );
      expect(badRange.status).toBe(416);

      // Non-video file returns 403, missing video returns 404
      const forbidden = await handleConductorMediaRequest(new Request(buildConductorMediaUrl(txtPath)));
      expect(forbidden.status).toBe(403);

      const missing = await handleConductorMediaRequest(
        new Request(buildConductorMediaUrl(path.join(tmpDir, "missing.mp4"))),
      );
      expect(missing.status).toBe(404);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Inline image & video rendering in MarkdownView, TaskEventCard, and TaskInspectorModal", () => {
  it("classifies video URLs and allows conductor-media:// & data:video/* while blocking unsafe schemes", () => {
    expect(isVideoPathOrUrl("/tmp/demo.mp4")).toBe(true);
    expect(isVideoPathOrUrl("file:///tmp/demo.webm?v=1")).toBe(true);
    expect(isVideoPathOrUrl("/tmp/screen.MOV")).toBe(true);
    expect(isVideoPathOrUrl("data:video/mp4;base64,AAAA")).toBe(true);
    expect(isVideoPathOrUrl("/tmp/shot.png")).toBe(false);

    expect(conductorUrlTransform("conductor-media://local/video?path=%2Ftmp%2Fa.mp4", "src")).toBe(
      "conductor-media://local/video?path=%2Ftmp%2Fa.mp4",
    );
    expect(conductorUrlTransform("data:video/mp4;base64,AAAA", "src")).toBe(
      "data:video/mp4;base64,AAAA",
    );
    expect(conductorUrlTransform("javascript:alert(1)", "src")).toBe("");

    expect(classifyMarkdownVideoSrc("/tmp/demo.mp4")).toEqual({
      kind: "local",
      target: "/tmp/demo.mp4",
      resolvedPath: "/tmp/demo.mp4",
      cacheKey: "/tmp/demo.mp4",
    });
    expect(classifyMarkdownVideoSrc("https://example.com/demo.webm")).toEqual({
      kind: "direct",
      src: "https://example.com/demo.webm",
    });
    expect(classifyMarkdownVideoSrc("javascript:alert(1)").kind).toBe("invalid");

    // Bare macOS paths containing spaces (e.g. Application Support) are wrapped safely outside code
    const spacedInput = [
      "![UI Shot](/Users/me/Library/Application Support/Conductor/worktrees/t1/shot.png)",
      "Inline `![Keep](/Users/me/Application Support/keep.png)`",
      "```md",
      "![Fence](/Users/me/Application Support/fence.png)",
      "```",
    ].join("\n");
    const normalized = normalizeMarkdownSpacedMediaDestinations(spacedInput);
    expect(normalized).toContain(
      "![UI Shot](</Users/me/Library/Application Support/Conductor/worktrees/t1/shot.png>)",
    );
    expect(normalized).toContain("`![Keep](/Users/me/Application Support/keep.png)`");
    expect(normalized).toContain("![Fence](/Users/me/Application Support/fence.png)");
  });

  it("renders Markdown image syntax with .mp4/.webm/.mov and HTML <video> as inline <video controls>", () => {
    const videoCache = new MarkdownVideoCache();
    videoCache.set("/abs/demo.mp4", {
      mediaUrl: "conductor-media://local/video?path=%2Fabs%2Fdemo.mp4",
      filePath: "/abs/demo.mp4",
      fileName: "demo.mp4",
    });
    videoCache.set("/abs/walkthrough.webm", {
      mediaUrl: "conductor-media://local/video?path=%2Fabs%2Fwalkthrough.webm",
      filePath: "/abs/walkthrough.webm",
      fileName: "walkthrough.webm",
    });

    const md = [
      "![UI デモ](/abs/demo.mp4)",
      "",
      "![Pending Mov](/abs/pending.mov)",
      "",
      '<video controls><source src="/abs/walkthrough.webm" type="video/webm" /></video>',
      "",
      '<video src="https://example.com/remote.mp4" controls onerror="alert(1)"></video>',
    ].join("\n");

    const htmlJa = renderToStaticMarkup(
      <MarkdownView
        content={md}
        locale="ja"
        videoCache={videoCache}
        onOpenUrl={vi.fn()}
      />,
    );

    expect(htmlJa).toContain('data-testid="markdown-video"');
    expect(htmlJa).toContain('src="conductor-media://local/video?path=%2Fabs%2Fdemo.mp4"');
    expect(htmlJa).toContain('src="conductor-media://local/video?path=%2Fabs%2Fwalkthrough.webm"');
    expect(htmlJa).toContain('src="https://example.com/remote.mp4"');
    expect(htmlJa).toContain("controls");
    expect(htmlJa).toContain(t("ja", "markdown.videoRevealInFinder"));
    expect(htmlJa).toContain('data-testid="markdown-video-loading"');
    expect(htmlJa).toContain('data-markdown-video-path="/abs/pending.mov"');
    expect(htmlJa).not.toContain("onerror=");

    const htmlEn = renderToStaticMarkup(
      <MarkdownView
        content="![UI Demo](/abs/demo.mp4)"
        locale="en"
        videoCache={videoCache}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(htmlEn).toContain(t("en", "markdown.videoRevealInFinder"));
    expect(htmlEn).not.toContain("Finder で表示");
  });

  it("renders inline screenshots (with Image Viewer zoom) and videos inside TaskEventCard and TaskInspectorModal", () => {
    const task = makeSampleTask({
      latestOutput: [
        "UI を更新しました。",
        "",
        "![変更後スクリーンショット](/abs/after.png)",
        "",
        "![相対パス画像](./shots/rel.png)",
        "",
        "![操作動画](file:///abs/demo.mp4)",
      ].join("\n"),
    });

    expect(buildTaskMarkdownBasePath(task)).toBe("/workspace/worktrees/task-12/__task_report__.md");
    expect(buildTaskMarkdownBasePath({ worktreePath: null, projectPath: "/workspace/conductor" })).toBe(
      "/workspace/conductor/__task_report__.md",
    );

    const imageCache = new MarkdownImageCache();
    imageCache.set("/abs/after.png", {
      dataUrl: "data:image/png;base64,AFTER_PNG",
      filePath: "/abs/after.png",
    });
    imageCache.set("/workspace/worktrees/task-12/shots/rel.png", {
      dataUrl: "data:image/png;base64,REL_PNG",
      filePath: "/workspace/worktrees/task-12/shots/rel.png",
    });

    const videoCache = new MarkdownVideoCache();
    videoCache.set("/abs/demo.mp4", {
      mediaUrl: "conductor-media://local/video?path=%2Fabs%2Fdemo.mp4",
      filePath: "/abs/demo.mp4",
      fileName: "demo.mp4",
    });

    const taskEventMessage: ChatMessage = {
      id: "msg-te-1",
      role: "taskEvent",
      relatedTaskId: task.id,
      text: `**[T12 · conductor · AGY] ${task.title}** — 完了（確認待ち）\n${buildTaskCompletionExcerpt(task.latestOutput)}`,
      attachments: [],
      toolChips: [],
      isStreaming: false,
      createdAt: "2026-11-26T01:00:00.000Z",
    };

    const cardHtml = renderToStaticMarkup(
      <TaskEventCard
        message={taskEventMessage}
        tasks={[task]}
        locale="ja"
        onOpenUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenImage={vi.fn()}
        onOpenTask={vi.fn()}
        imageCache={imageCache}
        videoCache={videoCache}
      />,
    );

    expect(cardHtml).toContain('src="data:image/png;base64,AFTER_PNG"');
    expect(cardHtml).toContain('src="data:image/png;base64,REL_PNG"');
    expect(cardHtml).toContain("cursor-zoom-in");
    expect(cardHtml).toContain('src="conductor-media://local/video?path=%2Fabs%2Fdemo.mp4"');
    expect(cardHtml).toContain("<video");

    const modalHtml = renderToStaticMarkup(
      <TaskInspectorModal
        task={task}
        projectColorHex="#3B82F6"
        locale="en"
        onClose={vi.fn()}
        onUpdateStatus={vi.fn()}
        onOpenPreviewUrl={vi.fn()}
        onOpenMarkdownFile={vi.fn()}
        onOpenImage={vi.fn()}
        onMentionInChat={vi.fn()}
        onStopWorker={vi.fn()}
        imageCache={imageCache}
        videoCache={videoCache}
      />,
    );

    expect(modalHtml).toContain('src="data:image/png;base64,AFTER_PNG"');
    expect(modalHtml).toContain('src="data:image/png;base64,REL_PNG"');
    expect(modalHtml).toContain("cursor-zoom-in");
    expect(modalHtml).toContain('src="conductor-media://local/video?path=%2Fabs%2Fdemo.mp4"');
    expect(modalHtml).toContain(t("en", "markdown.videoRevealInFinder"));
    expect(modalHtml).toContain(t("en", "markdown.imageZoomTitle"));
  });
});
