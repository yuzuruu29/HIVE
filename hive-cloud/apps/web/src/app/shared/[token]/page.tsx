import type { Metadata } from "next";
import Link from "next/link";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Shared conversation", robots: { index: false, follow: false } };

interface SharedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface SharedConversation {
  title: string;
  createdAt: string;
  messages: SharedMessage[];
}

function displayContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((part) => typeof part === "object" && part && "text" in part ? [String(part.text)] : []).join("\n");
  return "";
}

async function fetchShared(token: string): Promise<SharedConversation | null> {
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) return null;
  const origin = process.env.API_INTERNAL_ORIGIN || "http://localhost:4000";
  try {
    const response = await fetch(`${origin}/api/shared/${token}`, { cache: "no-store" });
    if (!response.ok) return null;
    const { data } = await response.json();
    return data as SharedConversation;
  } catch {
    return null;
  }
}

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const conversation = await fetchShared(token);

  if (!conversation) {
    return (
      <main className="signin-page">
        <section className="signin-card">
          <WarningCircle size={32} color="var(--danger)" />
          <h1>This shared conversation is unavailable.</h1>
          <p>The link may have been revoked or the conversation no longer exists.</p>
          <Link className="button button-secondary" href="/">Return home</Link>
        </section>
      </main>
    );
  }

  return (
    <main className="shared-page">
      <header className="shared-page-header">
        <Link className="brand-lockup" href="/"><span className="brand-mark" aria-hidden="true">H</span><span className="brand-name">HIVE</span></Link>
        <h1>{conversation.title}</h1>
        <time>{new Date(conversation.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</time>
      </header>
      <div className="shared-messages">
        {conversation.messages.map((message) => (
          <div className={`shared-message shared-message-${message.role}`} key={message.id}>
            <div className="shared-message-avatar">{message.role === "user" ? "You" : "H"}</div>
            <div className="shared-message-content">{displayContent(message.content)}</div>
          </div>
        ))}
      </div>
    </main>
  );
}
