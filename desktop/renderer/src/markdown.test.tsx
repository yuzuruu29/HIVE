import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown parser", () => {
  it("renders fenced code blocks with language and copy button", async () => {
    const markdown = "```typescript\nconst x = 42;\nconsole.log(x);\n```";
    const writeText = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });

    render(<div>{renderMarkdown(markdown)}</div>);

    expect(screen.getByText("typescript")).toBeInTheDocument();
    expect(screen.getByText(/const x = 42;/)).toBeInTheDocument();

    const copyBtn = screen.getByRole("button", { name: /copy code/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("const x = 42;\nconsole.log(x);");
    });
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });

  it("safely escapes HTML injection and blocks javascript: links", () => {
    const markdown = "Hello <script>alert(1)</script> [evil](javascript:alert(1)) https://example.com";
    render(<div>{renderMarkdown(markdown)}</div>);

    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "evil" })).not.toBeInTheDocument();

    const validLink = screen.getByRole("link", { name: "https://example.com" });
    expect(validLink).toHaveAttribute("href", "https://example.com");
    expect(validLink).toHaveAttribute("target", "_blank");
  });

  it("renders headings, bold, italic, and inline code", () => {
    const markdown = "# Heading 1\n## Heading 2\n### Heading 3\n\nThis is **bold**, *italic*, and `inline code`.";
    render(<div>{renderMarkdown(markdown)}</div>);

    expect(screen.getByRole("heading", { level: 1, name: "Heading 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Heading 2" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Heading 3" })).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("italic")).toBeInTheDocument();
    expect(screen.getByText("inline code")).toBeInTheDocument();
  });

  it("renders unordered lists, ordered lists, and task checkboxes", () => {
    const markdown = "- [ ] Pending item\n- [x] Done item\n- Regular item\n\n1. First\n2. Second";
    render(<div>{renderMarkdown(markdown)}</div>);

    expect(screen.getByText("Pending item")).toBeInTheDocument();
    expect(screen.getByText("Done item")).toBeInTheDocument();
    expect(screen.getByText("Regular item")).toBeInTheDocument();
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.getByText("[ ]")).toBeInTheDocument();
    expect(screen.getByText("[x]")).toBeInTheDocument();
  });
});
