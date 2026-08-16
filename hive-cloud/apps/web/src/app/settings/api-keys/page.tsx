import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ApiKeysSurface } from "@/components/api-keys-surface";
import { requireSubject } from "@/lib/require-subject";
export const metadata: Metadata = { title: "API keys" }; export const dynamic = "force-dynamic";
export default async function Page() { const subject = await requireSubject(); return <AppShell title="API keys" email={subject.email}><ApiKeysSurface /></AppShell>; }
