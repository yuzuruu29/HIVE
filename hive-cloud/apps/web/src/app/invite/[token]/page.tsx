import { createHash } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { and, eq, gt } from "drizzle-orm";
import { createDatabase, invitations, withServiceRole } from "@hive-cloud/database";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accept your HIVE invite", robots: { index: false, follow: false } };

function maskedEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}${"*".repeat(Math.max(2, local.length - 2))}@${domain}`;
}

async function invitedEmail(token: string): Promise<string | undefined> {
  if (!process.env.DATABASE_URL || !/^[A-Za-z0-9_-]{40,128}$/.test(token)) return undefined;
  const database = createDatabase(process.env.DATABASE_URL);
  try {
    const tokenDigest = createHash("sha256").update(token).digest("hex");
    return await withServiceRole(database.db, async (tx) => {
      const [invite] = await tx.select({ email: invitations.email }).from(invitations).where(and(eq(invitations.tokenDigest, tokenDigest), eq(invitations.status, "pending"), gt(invitations.expiresAt, new Date()))).limit(1);
      return invite?.email;
    });
  } finally {
    await database.pool.end();
  }
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const email = await invitedEmail(token);
  return (
    <main className="signin-page">
      <section className="signin-card">
        <Link className="brand-lockup" href="/"><span className="brand-mark" aria-hidden="true">H</span><span className="brand-name">HIVE</span></Link>
        {email ? (
          <>
            <h1>Your beta cell is ready.</h1>
            <p>This single-use invitation is bound to <strong>{maskedEmail(email)}</strong>. Sign in with that same verified address to create your personal tenant.</p>
            <Link className="button button-primary" href={`/signin?email=${encodeURIComponent(email)}`}>Continue to sign in <ArrowRight size={16} /></Link>
            <p className="form-message" style={{ marginTop: 18 }}>The invitation is consumed when the invited account is created.</p>
          </>
        ) : (
          <>
            <WarningCircle size={32} color="var(--danger)" />
            <h1>This invite is unavailable.</h1>
            <p>It may have expired, already been accepted, or been replaced by a newer invitation.</p>
            <Link className="button button-secondary" href="/#waitlist">Return to the waitlist</Link>
          </>
        )}
      </section>
    </main>
  );
}
