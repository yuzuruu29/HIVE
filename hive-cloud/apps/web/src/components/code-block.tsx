"use client";

import { Check, Copy } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useCopyFeedback } from "../lib/copy-feedback";

export function CodeBlock({
  language,
  children,
}: {
  language: string | null;
  children: ReactNode;
}) {
  const { copy, status } = useCopyFeedback();

  const copied = status === "copied";

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{language ?? "text"}</span>
        <button type="button" className="code-block-copy" onClick={() => void copy(extractText(children))}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copied ? "Copied" : status === "failed" ? "Copy failed" : "Copy"}
        </button>
        <span className="sr-only" aria-live="polite">{status === "copied" ? "Code copied to clipboard" : status === "failed" ? "Code could not be copied" : ""}</span>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node && typeof node === "object" && "props" in node) {
    return extractText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}
