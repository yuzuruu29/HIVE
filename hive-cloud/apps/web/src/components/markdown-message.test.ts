import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CodeBlock, extractText } from "./code-block";
import { MarkdownMessage } from "./markdown-message";

describe("CodeBlock", () => {
  it("renders a Copy button and language label inside a pre block", () => {
    const markup = renderToStaticMarkup(
      React.createElement(CodeBlock, { language: "ts", children: React.createElement("code", null, "const a = 1") }),
    );
    expect(markup).toContain("<pre>");
    expect(markup).toContain("Copy");
    expect(markup).toContain("code-block-lang");
    expect(markup).toContain(">ts<");
  });

  it("defaults language to text when null", () => {
    const markup = renderToStaticMarkup(
      React.createElement(CodeBlock, { language: null, children: React.createElement("code", null, "plain") }),
    );
    expect(markup).toContain(">text<");
  });
});

describe("extractText", () => {
  it("extracts string content from nested React nodes", () => {
    const node = React.createElement("code", null,
      "const a = ",
      React.createElement("span", null, "1"),
    );
    expect(extractText(node)).toBe("const a = 1");
  });
});

describe("MarkdownMessage URLs", () => {
  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "javascript%3Aalert(1)"])("does not emit a dangerous href for %s", (url) => {
    const markup = renderToStaticMarkup(React.createElement(MarkdownMessage, { content: `[unsafe](${url})` }));
    expect(markup.toLowerCase()).not.toContain('href="javascript:');
  });

  it("preserves safe external links with opener isolation", () => {
    const markup = renderToStaticMarkup(React.createElement(MarkdownMessage, { content: "[safe](https://example.com)" }));
    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});
