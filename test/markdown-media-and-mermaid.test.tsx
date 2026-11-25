import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readLocalImageFile } from "../src/main/image-viewer.js";
import { conductorUrlTransform, MarkdownView } from "../src/renderer/components/MarkdownView.js";
import { MarkdownImageCache } from "../src/renderer/lib/markdown-image-cache.js";
import { classifyMarkdownImageSrc } from "../src/renderer/lib/markdown-utils.js";
import {
  clearMermaidRenderCache,
  extractMermaidErrorMessage,
  getMermaidConfig,
  isMermaidLanguage,
  renderMermaidDiagram,
  type MermaidLike,
} from "../src/renderer/lib/mermaid-renderer.js";

describe("Markdown image URL transform & classification", () => {
  it("allows safe file://, data:image/*, and blob: on src/srcSet while blocking unsafe URLs", () => {
    expect(conductorUrlTransform("file:///Users/me/README.md", "href")).toBe(
      "file:///Users/me/README.md",
    );
    expect(conductorUrlTransform("file:///Users/me/shot.png", "src")).toBe(
      "file:///Users/me/shot.png",
    );
    expect(conductorUrlTransform("file:///Users/me/shot.png", "srcSet")).toBe(
      "file:///Users/me/shot.png",
    );
    expect(conductorUrlTransform("data:image/png;base64,AAAA", "src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(conductorUrlTransform("blob:http://localhost:5179/abc", "src")).toBe(
      "blob:http://localhost:5179/abc",
    );
    expect(conductorUrlTransform("docs/images/a.png", "src")).toBe("docs/images/a.png");

    // Unsafe schemes must be neutralized
    expect(conductorUrlTransform("javascript:alert(1)", "src")).toBe("");
    expect(conductorUrlTransform("javascript:alert(1)", "href")).toBe("");
    expect(conductorUrlTransform("data:text/html,<script>alert(1)</script>", "src")).toBe("");

    // Repo-root style absolute path carries baseFilePath when provided
    expect(classifyMarkdownImageSrc("/docs/images/a.png", "/repo/guides/doc.md")).toEqual({
      kind: "local",
      target: "/docs/images/a.png",
      baseFilePath: "/repo/guides/doc.md",
      resolvedPath: "/docs/images/a.png",
      cacheKey: "/docs/images/a.png",
    });
  });
});

describe("MarkdownView HTML <img>, <picture>, XSS sanitization, and Mermaid rendering", () => {
  beforeEach(() => {
    clearMermaidRenderCache();
  });

  it("renders HTML <img> and <picture><source> tags, resolves local images via MarkdownImageCache, and sanitizes XSS", () => {
    const emptyCache = new MarkdownImageCache();
    const md = [
      "![Remote Pic](https://example.com/remote.png)",
      "",
      "![Inline Data](data:image/png;base64,AAAA)",
      "",
      "![Relative Pic](./docs/images/conductor-overview.png)",
      "",
      '<img src="https://example.com/html.png" width="320" alt="HTML Remote" />',
      "",
      '<p align="center"><img src="docs/images/conductor-markdown-viewer.png" width="480" alt="HTML Local" /></p>',
      "",
      '<picture><source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.png" /><img src="https://example.com/light.png" alt="Picture Img" /></picture>',
      "",
      "<script>window.__xss = true;</script>",
      '<img src="https://example.com/safe.png" onerror="alert(1)" alt="No Handler" />',
      '<img src="javascript:alert(1)" alt="Bad Scheme" />',
    ].join("\n");

    const html = renderToStaticMarkup(
      <MarkdownView
        content={md}
        variant="document"
        baseFilePath="/Users/dev/conductor/README.md"
        imageCache={emptyCache}
        onOpenUrl={vi.fn()}
      />,
    );

    // Direct URLs & data:image/* render directly as <img>
    expect(html).toContain('src="https://example.com/remote.png"');
    expect(html).toContain('alt="Remote Pic"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');

    // HTML <img> tags render as real images (preserving width/alt)
    expect(html).toContain('src="https://example.com/html.png"');
    expect(html).toContain('width="320"');
    expect(html).toContain('alt="HTML Remote"');

    // <picture><source><img> preserves remote source and img
    expect(html).toContain("<picture>");
    expect(html).toContain('srcSet="https://example.com/dark.png"');
    expect(html).toContain('src="https://example.com/light.png"');

    // Relative Markdown and HTML local images are routed to MarkdownImage loader (NOT broken raw <img>)
    expect(html).toContain('data-testid="markdown-image-loading"');
    expect(html).toContain(
      'data-markdown-image-path="/Users/dev/conductor/docs/images/conductor-overview.png"',
    );
    expect(html).toContain(
      'data-markdown-image-path="/Users/dev/conductor/docs/images/conductor-markdown-viewer.png"',
    );
    expect(html).not.toContain('src="./docs/images/conductor-overview.png"');
    expect(html).not.toContain('src="docs/images/conductor-markdown-viewer.png"');

    // XSS vectors are neutralized
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("window.__xss");
    expect(html).not.toContain("onerror=");
    expect(html).not.toContain("javascript:alert");
  });

  it("routes mermaid fenced blocks to MermaidBlock while keeping normal code blocks intact", () => {
    const md = [
      "```mermaid",
      "flowchart LR",
      "  A[Start] --> B[End]",
      "```",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");

    const html = renderToStaticMarkup(
      <MarkdownView content={md} variant="document" onOpenUrl={vi.fn()} />,
    );

    expect(html).toContain('data-testid="mermaid-block"');
    expect(html).toContain("Diagram");
    expect(html).toContain("Code");
    expect(html).toContain("const x = 1;");
    expect(html).toContain(">ts<");
  });

  it("handles the repository README.md images and Mermaid architecture diagram cleanly", () => {
    const repoRoot = path.resolve(__dirname, "..");
    const readmePath = path.join(repoRoot, "README.md");
    const readmeContent = fs.readFileSync(readmePath, "utf8");
    const emptyCache = new MarkdownImageCache();

    // All three relative images referenced in README.md resolve via main-process loader
    for (const relImg of [
      "docs/images/conductor-overview.png",
      "docs/images/conductor-worktree-inspector.png",
      "docs/images/conductor-markdown-viewer.png",
    ]) {
      const res = readLocalImageFile(relImg, readmePath);
      expect(res.ok).toBe(true);
      expect(res.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
    }

    const html = renderToStaticMarkup(
      <MarkdownView
        content={readmeContent}
        variant="document"
        baseFilePath={readmePath}
        imageCache={emptyCache}
        onOpenUrl={vi.fn()}
      />,
    );
    expect(html).toContain(
      `data-markdown-image-path="${path.join(repoRoot, "docs/images/conductor-overview.png")}"`,
    );
    expect(html).toContain(
      `data-markdown-image-path="${path.join(repoRoot, "docs/images/conductor-markdown-viewer.png")}"`,
    );
    expect(html).toContain('data-testid="mermaid-block"');
  });
});

describe("Mermaid renderer helper", () => {
  beforeEach(() => {
    clearMermaidRenderCache();
  });

  it("matches mermaid language names case-insensitively and builds theme-aware strict configs", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true);
    expect(isMermaidLanguage("MERMAID")).toBe(true);
    expect(isMermaidLanguage(" mermaid ")).toBe(true);
    expect(isMermaidLanguage("typescript")).toBe(false);
    expect(isMermaidLanguage(undefined)).toBe(false);

    const lightCfg = getMermaidConfig("light");
    expect(lightCfg.theme).toBe("default");
    expect(lightCfg.securityLevel).toBe("strict");
    expect(lightCfg.startOnLoad).toBe(false);
    expect(lightCfg.suppressErrorRendering).toBe(true);

    const darkCfg = getMermaidConfig("dark");
    expect(darkCfg.theme).toBe("dark");
    expect(darkCfg.securityLevel).toBe("strict");
  });

  it("renders with theme-specific caching, serializes concurrent calls, and handles errors cleanly", async () => {
    const events: string[] = [];
    const renderedThemes: string[] = [];

    const mockMermaid: MermaidLike = {
      initialize(cfg) {
        renderedThemes.push(String(cfg.theme));
      },
      async render(id, text) {
        events.push(`start:${id}`);
        await new Promise((r) => setTimeout(r, 15));
        events.push(`end:${id}`);
        if (text.includes("BROKEN")) {
          throw new Error("Syntax error on line 1");
        }
        return {
          svg: `<svg data-theme="${renderedThemes[renderedThemes.length - 1]}">${text}</svg>`,
          diagramType: "flowchart-v2",
        };
      },
    };

    const loader = async () => mockMermaid;

    // Concurrent renders must serialize strictly (start1 -> end1 -> start2 -> end2)
    const [svgLight, svgDark] = await Promise.all([
      renderMermaidDiagram("flowchart LR\nA-->B", "light", { loader }),
      renderMermaidDiagram("flowchart LR\nA-->B", "dark", { loader }),
    ]);

    expect(svgLight).toContain('data-theme="default"');
    expect(svgDark).toContain('data-theme="dark"');
    expect(events).toHaveLength(4);
    expect(events[0].startsWith("start:")).toBe(true);
    expect(events[1].startsWith("end:")).toBe(true);
    expect(events[2].startsWith("start:")).toBe(true);
    expect(events[3].startsWith("end:")).toBe(true);

    // Cached result does not invoke render again
    const callsBefore = events.length;
    const cachedLight = await renderMermaidDiagram("flowchart LR\nA-->B", "light", { loader });
    expect(cachedLight).toBe(svgLight);
    expect(events.length).toBe(callsBefore);

    // Error propagates cleanly and does not break subsequent renders
    await expect(
      renderMermaidDiagram("BROKEN DIAGRAM", "light", { loader }),
    ).rejects.toThrow("Syntax error on line 1");

    await expect(renderMermaidDiagram("   ", "light", { loader })).rejects.toThrow(
      "Mermaid 図の定義が空です。",
    );

    const afterError = await renderMermaidDiagram("graph TD\nX-->Y", "dark", { loader });
    expect(afterError).toContain("X-->Y");

    expect(extractMermaidErrorMessage(new Error("Parse failed"))).toBe("Parse failed");
    expect(extractMermaidErrorMessage({ str: "Lexical error" })).toBe("Lexical error");
    expect(extractMermaidErrorMessage(null)).toContain("Mermaid");
  });
});
