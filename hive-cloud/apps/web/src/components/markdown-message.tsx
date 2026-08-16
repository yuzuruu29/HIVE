"use client";

import { Children, memo, type ReactElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./code-block";

const MarkdownRenderer = memo(function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        pre({ children }) {
          const code = Children.toArray(children)[0] as ReactElement<{
            className?: string;
            children?: ReactNode;
          }>;
          if (!code?.props) return <pre>{children}</pre>;
          const match = /language-(\w+)/.exec(code.props.className ?? "");
          return <CodeBlock language={match?.[1] ?? null}>{children}</CodeBlock>;
        },
        a({ href, children }) {
          const external = href?.startsWith("http");
          return (
            <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
              {children}
            </a>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

export function MarkdownMessage({ content }: { content: string }) {
  return <MarkdownRenderer content={content} />;
}
