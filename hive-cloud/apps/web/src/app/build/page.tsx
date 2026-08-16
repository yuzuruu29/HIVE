import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { BuildSurface } from "@/components/build-surface";
import { requireSubject } from "@/lib/require-subject";

export const metadata: Metadata = { title: "Council run" };
export const dynamic = "force-dynamic";

export default async function BuildPage({ searchParams }: { searchParams: Promise<{ task?: string }> }) {
  const subject = await requireSubject();
  const { task } = await searchParams;
  return <AppShell title="Council run" email={subject.email}><BuildSurface initialObjective={task?.slice(0, 20_000)} /></AppShell>;
}
