import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AdminSurface } from "@/components/admin-surface";
import { betaBypassEnabled } from "@/lib/beta-bypass";
import { requireSubject } from "@/lib/require-subject";
export const metadata: Metadata = { title: "Beta admin" }; export const dynamic = "force-dynamic";
export default async function Page() {
  const subject = await requireSubject();
  const owners = (process.env.OWNER_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  if (!betaBypassEnabled() && (subject.role !== "owner" || !owners.includes(subject.email.toLowerCase()))) notFound();
  return <AppShell title="Beta admin" email={subject.email}><AdminSurface /></AppShell>;
}
