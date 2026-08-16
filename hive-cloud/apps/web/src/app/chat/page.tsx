import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ChatSurface } from "@/components/chat-surface";
import { requireSubject } from "@/lib/require-subject";

export const metadata: Metadata = { title: "Hive" };
export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const subject = await requireSubject();
  return <AppShell title="Hive" email={subject.email}><ChatSurface /></AppShell>;
}
