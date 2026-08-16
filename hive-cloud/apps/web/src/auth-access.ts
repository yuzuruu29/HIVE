import { and, eq, gt, lte } from "drizzle-orm";
import {
  auditEvents,
  invitations,
  memberships,
  tenants,
  users,
  withServiceRole,
  type HiveDatabase,
} from "@hive-cloud/database";

export async function emailIsInvited(database: HiveDatabase, email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  return withServiceRole(database, async (tx) => {
    const [member] = await tx
      .select({ id: users.id })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(eq(users.email, normalized))
      .limit(1);
    if (member) return true;

    const [invite] = await tx
      .select({ id: invitations.id, expiresAt: invitations.expiresAt })
      .from(invitations)
      .where(and(eq(invitations.email, normalized), eq(invitations.status, "pending")))
      .limit(1);
    if (!invite) return false;

    if (invite.expiresAt <= new Date()) {
      const expired = await tx
        .update(invitations)
        .set({ status: "expired" })
        .where(and(eq(invitations.id, invite.id), eq(invitations.status, "pending"), lte(invitations.expiresAt, new Date())))
        .returning({ id: invitations.id });
      if (expired[0]) {
        await tx.insert(auditEvents).values({
          eventType: "invitation.expired",
          targetType: "invitation",
          targetId: invite.id,
          metadata: {},
        });
      }
      return false;
    }

    return true;
  });
}

export async function provisionInvitedUser(
  database: HiveDatabase,
  user: { id: string; email: string; name?: string | null },
): Promise<void> {
  const normalized = user.email.trim().toLowerCase();
  await withServiceRole(database, async (tx) => {
    const [invite] = await tx
      .select({ id: invitations.id })
      .from(invitations)
      .where(and(eq(invitations.email, normalized), eq(invitations.status, "pending"), gt(invitations.expiresAt, new Date())))
      .limit(1);
    const tenantId = crypto.randomUUID();
    await tx.insert(tenants).values({
      id: tenantId,
      name: `${user.name || normalized.split("@")[0] || "HIVE"}'s workspace`,
      slug: `personal-${tenantId}`,
    });
    await tx.insert(memberships).values({ tenantId, userId: user.id, role: "owner" });
    await tx
      .update(invitations)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(and(eq(invitations.email, normalized), eq(invitations.status, "pending"), gt(invitations.expiresAt, new Date())));
    if (invite) {
      await tx.insert(auditEvents).values({
        tenantId,
        actorUserId: user.id,
        eventType: "invitation.accepted",
        targetType: "invitation",
        targetId: invite.id,
        metadata: { accepted_via: "auth" },
      });
    }
  });
}
