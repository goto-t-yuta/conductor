import React, { useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, FileText } from "lucide-react";
import { classifyLinkHref, uniqueSlug } from "../lib/markdown-utils.js";

interface MarkdownViewProps {
  content: string;
  onOpenUrl: (url: string) => void;
  onOpenMarkdownFile?: (target: string, baseFilePath?: string) => void;
  baseFilePath?: string;
  variant?: "chat" | "document";
  headingIdPrefix?: string;
  onScrollToHeading?: (id: string) => void;
}

function conductorUrlTransform(url: string, key: string): string {
  // Allow local file:// URLs strictly on anchor hrefs so local .md links remain clickable
  if (key === "href" && /^file:\/\//i.test(url)) {
    return url;
  }
  return defaultUrlTransform(url);
}

function extractNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractNodeText).join("");
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return extractNodeText(node.props.children);
  }
  return "";
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const lineCount = code.length === 0 ? 0 : code.split("\n").length;

  return (
    <div className="my-2.5 overflow-hidden rounded-lg border border-zinc-200/80 dark:border-zinc-800 bg-zinc-50 dark:bg-[#14171f]">
      <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 bg-zinc-100/80 dark:bg-zinc-900/80 border-b border-zinc-200/70 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium">{language || "code"}</span>
          {lineCount > 1 && (
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{lineCount} lines</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="inline-flex items-center gap-1 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors cursor-pointer"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-[12.5px] leading-relaxed font-mono select-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({
  content,
  onOpenUrl,
  onOpenMarkdownFile,
  baseFilePath,
  variant = "chat",
  headingIdPrefix = "",
  onScrollToHeading,
}) => {
  const slugCounts = new Map<string, number>();

  const makeHeading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
    return ({ children }: { children?: React.ReactNode }) => {
      const slug = uniqueSlug(extractNodeText(children), slugCounts);
      const id = headingIdPrefix ? `${headingIdPrefix}${slug}` : undefined;
      return <Tag id={id}>{children}</Tag>;
    };
  };

  return (
    <div
      className={`conductor-markdown ${
        variant === "document" ? "conductor-markdown-doc" : ""
      } select-text text-zinc-800 dark:text-zinc-100`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={conductorUrlTransform}
        components={{
          h1: makeHeading("h1"),
          h2: makeHeading("h2"),
          h3: makeHeading("h3"),
          h4: makeHeading("h4"),
          h5: makeHeading("h5"),
          h6: makeHeading("h6"),
          a({ href, children }) {
            const classified = classifyLinkHref(href, baseFilePath);
            const isLocalMd = classified.kind === "markdown" && Boolean(onOpenMarkdownFile);

            return (
              <a
                href={href}
                title={isLocalMd ? "Markdown Viewer で開く" : undefined}
                onClick={(e) => {
                  if (classified.kind === "web") {
                    e.preventDefault();
                    onOpenUrl(classified.url);
                  } else if (classified.kind === "markdown" && onOpenMarkdownFile) {
                    e.preventDefault();
                    onOpenMarkdownFile(classified.target, classified.baseFilePath);
                  } else if (classified.kind === "anchor") {
                    e.preventDefault();
                    if (onScrollToHeading) {
                      onScrollToHeading(classified.id);
                    } else if (headingIdPrefix) {
                      const el = document.getElementById(`${headingIdPrefix}${classified.id}`);
                      el?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                  }
                }}
              >
                {isLocalMd && (
                  <FileText className="inline-block w-3.5 h-3.5 mr-1 -mt-0.5 text-indigo-500 align-middle" />
                )}
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="conductor-md-table-wrap">
                <table>{children}</table>
              </div>
            );
          },
          pre({ children }) {
            const child = React.Children.only(children) as React.ReactElement<{
              className?: string;
              children?: React.ReactNode;
            }>;
            const className = child?.props?.className ?? "";
            const match = /language-([^\s]+)/.exec(className);
            const code = String(child?.props?.children ?? "").replace(/\n$/, "");
            return <CodeBlock language={match?.[1] ?? ""} code={code} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
