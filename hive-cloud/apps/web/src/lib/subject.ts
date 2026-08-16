import { eq } from "drizzle-orm";
import { createDatabase, memberships, users, withServiceRole } from "@hive-cloud/database";
import type { InternalSubject } from "@hive-cloud/security";
import { auth } from "@/auth";
import { betaBypassEnabled } from "@/lib/beta-bypass";

const DEMO_SUBJECT: InternalSubject = {
  userId: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.com",
};

export async function currentSubject(): Promise<InternalSubject | null> {
  if (betaBypassEnabled()) return DEMO_SUBJECT;
  const session = await auth();
  if (!session?.user?.id || !session.user.email || !process.env.DATABASE_URL) return null;
  const database = createDatabase(process.env.DATABASE_URL);
  try {
    return await withServiceRole(database.db, async (tx) => {
      const [row] = await tx.select({ membership: memberships, user: users }).from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.userId, session.user.id)).limit(1);
      return row ? { userId: row.user.id, tenantId: row.membership.tenantId, role: row.membership.role, email: row.user.email } : null;
    });
  } finally {
    await database.pool.end();
  }
}
