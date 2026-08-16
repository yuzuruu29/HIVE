import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { GeneralSettingsSurface } from "@/components/general-settings-surface";
import { requireSubject } from "@/lib/require-subject";

export const metadata: Metadata = { title: "General Settings" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const subject = await requireSubject();
  return (
    <AppShell title="General Settings" email={subject.email}>
      <GeneralSettingsSurface />
    </AppShell>
  );
}
