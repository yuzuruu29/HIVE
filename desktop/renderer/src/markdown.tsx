import { ReactNode, useState } from "react";

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    const clipboard =
      typeof window !== "undefined" && window.navigator?.clipboard
        ? window.navigator.clipboard
        : typeof navigator !== "undefined" && navigator?.clipboard
        ? navigator.clipboard
        : undefined;

    if (clipboard && typeof clipboard.writeText === "function") {
      await clipboard.writeText(text);
      return;
    }
  } catch {
    // fallback
  }

  if (typeof document !== "undefined") {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    } catch {
      // ignore
    }
  }
}

export function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await copyTextToClipboard(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span>{language || "text"}</span>
        <button type="button" onClick={() => void handleCopy()} aria-label="Copy code">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code className="block-code">{code}</code>
      </pre>
    </div>
  );
}

function isSafeUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  if (trimmed.startsWith("javascript:") || trimmed.startsWith("data:") || trimmed.startsWith("vbscript:")) {
    return false;
  }
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function renderInline(text: string): ReactNode[] {
  const tokens: ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<)"']+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  let keyIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      tokens.push(<code key={`code-${keyIndex++}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**") && token.endsWith("**")) {
      tokens.push(<strong key={`bold-${keyIndex++}`}>{renderInline(token.slice(2, -2))}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      tokens.push(<em key={`italic-${keyIndex++}`}>{renderInline(token.slice(1, -1))}</em>);
    } else if (token.startsWith("[") && token.includes("](")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch && isSafeUrl(linkMatch[2])) {
        tokens.push(
          <a key={`link-${keyIndex++}`} href={linkMatch[2]} target="_blank" rel="noreferrer">
            {linkMatch[1]}
          </a>
        );
      } else {
        tokens.push(token);
      }
    } else if (token.startsWith("http://") || token.startsWith("https://")) {
      if (isSafeUrl(token)) {
        tokens.push(
          <a key={`url-${keyIndex++}`} href={token} target="_blank" rel="noreferrer">
            {token}
          </a>
        );
      } else {
        tokens.push(token);
      }
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }

  return tokens;
}

export function renderMarkdown(source: string): ReactNode {
  if (!source) return null;

  const lines = source.split(/\r?\n/);
  const elements: ReactNode[] = [];
  let index = 0;
  let elementKey = 0;

  while (index < lines.length) {
    const line = lines[index];

    // 1. Fenced Code Block
    if (line.trim().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index++;
      }
      index++; // skip closing ```
      elements.push(
        <CodeBlock key={`block-${elementKey++}`} language={language} code={codeLines.join("\n")} />
      );
      continue;
    }

    // 2. Headings
    if (line.startsWith("### ")) {
      elements.push(<h3 key={`h3-${elementKey++}`}>{renderInline(line.slice(4))}</h3>);
      index++;
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(<h2 key={`h2-${elementKey++}`}>{renderInline(line.slice(3))}</h2>);
      index++;
      continue;
    }
    if (line.startsWith("# ")) {
      elements.push(<h1 key={`h1-${elementKey++}`}>{renderInline(line.slice(2))}</h1>);
      index++;
      continue;
    }

    // 3. Lists (Unordered & Task lists)
    if (line.match(/^[-*]\s+/)) {
      const listItems: ReactNode[] = [];
      while (index < lines.length && lines[index].match(/^[-*]\s+/)) {
        const itemText = lines[index].replace(/^[-*]\s+/, "");
        if (itemText.startsWith("[ ] ")) {
          listItems.push(
            <li key={`task-${index}`} className="task-item">
              <span className="glyph">[ ]</span>
              <span>{renderInline(itemText.slice(4))}</span>
            </li>
          );
        } else if (itemText.startsWith("[x] ") || itemText.startsWith("[X] ")) {
          listItems.push(
            <li key={`task-${index}`} className="task-item">
              <span className="glyph">[x]</span>
              <span>{renderInline(itemText.slice(4))}</span>
            </li>
          );
        } else {
          listItems.push(<li key={`li-${index}`}>{renderInline(itemText)}</li>);
        }
        index++;
      }
      elements.push(<ul key={`ul-${elementKey++}`}>{listItems}</ul>);
      continue;
    }

    // 4. Ordered Lists
    if (line.match(/^\d+\.\s+/)) {
      const listItems: ReactNode[] = [];
      while (index < lines.length && lines[index].match(/^\d+\.\s+/)) {
        const itemText = lines[index].replace(/^\d+\.\s+/, "");
        listItems.push(<li key={`oli-${index}`}>{renderInline(itemText)}</li>);
        index++;
      }
      elements.push(<ol key={`ol-${elementKey++}`}>{listItems}</ol>);
      continue;
    }

    // 5. Blank line
    if (!line.trim()) {
      index++;
      continue;
    }

    // 6. Regular Paragraph
    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().startsWith("```") &&
      !lines[index].startsWith("#") &&
      !lines[index].match(/^[-*]\s+/) &&
      !lines[index].match(/^\d+\.\s+/)
    ) {
      paragraphLines.push(lines[index]);
      index++;
    }

    if (paragraphLines.length) {
      elements.push(
        <p key={`p-${elementKey++}`}>
          {paragraphLines.map((pLine, i) => (
            <span key={i}>
              {i > 0 && " "}
              {renderInline(pLine)}
            </span>
          ))}
        </p>
      );
    }
  }

  return <div className="markdown-body">{elements}</div>;
}
