import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { BillingSurface } from "@/components/billing-surface";
import { requireSubject } from "@/lib/require-subject";

export const metadata: Metadata = { title: "Billing" };
export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const subject = await requireSubject();
  return <AppShell title="Billing" email={subject.email}><BillingSurface /></AppShell>;
}
