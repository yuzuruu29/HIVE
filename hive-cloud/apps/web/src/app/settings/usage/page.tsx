import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { UsageSurface } from "@/components/usage-surface";
import { requireSubject } from "@/lib/require-subject";
export const metadata: Metadata = { title: "Usage" }; export const dynamic = "force-dynamic";
export default async function Page() { const subject = await requireSubject(); return <AppShell title="Usage" email={subject.email}><UsageSurface /></AppShell>; }
