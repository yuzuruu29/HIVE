import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ProvidersSurface } from "@/components/providers-surface";
import { requireSubject } from "@/lib/require-subject";
export const metadata: Metadata = { title: "Providers" }; export const dynamic = "force-dynamic";
export default async function Page() { const subject = await requireSubject(); return <AppShell title="Provider control" email={subject.email}><ProvidersSurface /></AppShell>; }
