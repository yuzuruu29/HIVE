import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "@hive-cloud/database/test-helpers";
import {
  accounts,
  auditEvents,
  createDatabase,
  invitations,
  memberships,
  sessions,
  tenants,
  users,
  verificationTokens,
  withServiceRole,
} from "@hive-cloud/database";
import { emailIsInvited, provisionInvitedUser } from "./auth-access";

const baseUrl = process.env.DATABASE_URL;

describe.runIf(Boolean(baseUrl))("Auth.js PostgreSQL integration", () => {
  let database!: ReturnType<typeof createDatabase>;
  let disposeDb: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const testDb = await createTestDatabase(baseUrl!, "auth");
    disposeDb = testDb.dispose;
    database = createDatabase(testDb.dbUrl);
  }, 120_000);

  afterAll(async () => {
    await database?.pool.end();
    if (disposeDb) await disposeDb();
  });

  function adapter() {
    return DrizzleAdapter(database.db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    });
  }

  it("creates and reads a user through the configured adapter", async () => {
    const email = `adapter-${crypto.randomUUID()}@example.test`;
    try {
      const created = await adapter().createUser!({ id: crypto.randomUUID(), email, name: "Adapter test", emailVerified: null, image: null });
      const read = await adapter().getUserByEmail!(email);

      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(read?.email).toBe(email);
    } finally {
      await database.db.delete(users).where(eq(users.email, email));
    }
  });

  it("consumes a verification token exactly once", async () => {
    const identifier = `token-${crypto.randomUUID()}@example.test`;
    const token = crypto.randomUUID();
    const authAdapter = adapter();
    try {
      await authAdapter.createVerificationToken!({ identifier, token, expires: new Date(Date.now() + 60_000) });

      expect(await authAdapter.useVerificationToken!({ identifier, token })).toMatchObject({ identifier, token });
      expect(await authAdapter.useVerificationToken!({ identifier, token })).toBeNull();
    } finally {
      await database.db.delete(verificationTokens).where(and(eq(verificationTokens.identifier, identifier), eq(verificationTokens.token, token)));
    }
  });

  it("persists and retrieves a database session with its user", async () => {
    const email = `session-${crypto.randomUUID()}@example.test`;
    const sessionToken = crypto.randomUUID();
    const authAdapter = adapter();
    try {
      const created = await authAdapter.createUser!({ id: crypto.randomUUID(), email, name: null, emailVerified: null, image: null });
      await authAdapter.createSession!({ sessionToken, userId: created.id, expires: new Date(Date.now() + 60_000) });

      const result = await authAdapter.getSessionAndUser!(sessionToken);

      expect(result?.session.userId).toBe(created.id);
      expect(result?.user.email).toBe(email);
    } finally {
      await database.db.delete(users).where(eq(users.email, email));
    }
  });

  it("allows an email with an unexpired pending invitation", async () => {
    const email = `invited-${crypto.randomUUID()}@example.test`;
    const invitationId = crypto.randomUUID();
    try {
      await database.db.insert(invitations).values({
        id: invitationId,
        email,
        tokenDigest: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      });

      expect(await emailIsInvited(database.db, email.toUpperCase())).toBe(true);
    } finally {
      await database.db.delete(invitations).where(eq(invitations.id, invitationId));
    }
  });

  it("rejects and expires a stale invitation", async () => {
    const email = `expired-${crypto.randomUUID()}@example.test`;
    const invitationId = crypto.randomUUID();
    try {
      await database.db.insert(invitations).values({
        id: invitationId,
        email,
        tokenDigest: crypto.randomUUID(),
        expiresAt: new Date(Date.now() - 60_000),
      });

      expect(await emailIsInvited(database.db, email)).toBe(false);
      const [invite] = await database.db.select({ status: invitations.status }).from(invitations).where(eq(invitations.id, invitationId));
      expect(invite?.status).toBe("expired");
    } finally {
      await database.db.delete(auditEvents).where(and(eq(auditEvents.targetType, "invitation"), eq(auditEvents.targetId, invitationId)));
      await database.db.delete(invitations).where(eq(invitations.id, invitationId));
    }
  });

  it("rejects an email without an invitation or membership", async () => {
    expect(await emailIsInvited(database.db, `uninvited-${crypto.randomUUID()}@example.test`)).toBe(false);
  });

  it("accepts the invitation and provisions one owner workspace after account creation", async () => {
    const email = `provision-${crypto.randomUUID()}@example.test`;
    const invitationId = crypto.randomUUID();
    let userId: string | undefined;
    let tenantId: string | undefined;
    try {
      await database.db.insert(invitations).values({
        id: invitationId,
        email,
        tokenDigest: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const created = await adapter().createUser!({ id: crypto.randomUUID(), email, name: "Provision test", emailVerified: null, image: null });
      userId = created.id;
      const createdUserId = created.id;

      await provisionInvitedUser(database.db, { id: createdUserId, email, name: "Provision test" });

      const result = await withServiceRole(database.db, async (tx) => {
        const [membership] = await tx.select().from(memberships).where(eq(memberships.userId, createdUserId));
        const [invite] = await tx.select().from(invitations).where(eq(invitations.id, invitationId));
        return { membership, invite };
      });
      tenantId = result.membership?.tenantId;
      expect(result.membership).toMatchObject({ userId: createdUserId, role: "owner" });
      expect(result.invite?.status).toBe("accepted");
      expect(result.invite?.acceptedAt).toBeInstanceOf(Date);
    } finally {
      await withServiceRole(database.db, async (tx) => {
        if (tenantId) await tx.delete(tenants).where(eq(tenants.id, tenantId));
        await tx.delete(users).where(eq(users.email, email));
        await tx.delete(auditEvents).where(and(eq(auditEvents.targetType, "invitation"), eq(auditEvents.targetId, invitationId)));
        await tx.delete(invitations).where(eq(invitations.id, invitationId));
      });
    }
  });

  it("keeps forced RLS enabled for memberships while service transactions can access it", async () => {
    const email = `rls-${crypto.randomUUID()}@example.test`;
    const userId = crypto.randomUUID();
    const tenantId = crypto.randomUUID();
    try {
      await database.db.insert(users).values({ id: userId, email });
      await withServiceRole(database.db, async (tx) => {
        await tx.insert(tenants).values({ id: tenantId, name: "RLS test", slug: `rls-${tenantId}` });
        await tx.insert(memberships).values({ tenantId, userId, role: "owner" });
      });

      const privileged = await withServiceRole(database.db, (tx) => tx.select().from(memberships).where(eq(memberships.userId, userId)));
      const catalog = await database.pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.memberships'::regclass",
      );
      const authCatalog = await database.pool.query<{ relname: string; relrowsecurity: boolean }>(
        "select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[]) order by relname",
        [["accounts", "sessions", "users", "verification_tokens"]],
      );

      expect(privileged).toHaveLength(1);
      expect(catalog.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect(authCatalog.rows).toEqual([
        { relname: "accounts", relrowsecurity: false },
        { relname: "sessions", relrowsecurity: false },
        { relname: "users", relrowsecurity: false },
        { relname: "verification_tokens", relrowsecurity: false },
      ]);
    } finally {
      await withServiceRole(database.db, async (tx) => {
        await tx.delete(tenants).where(eq(tenants.id, tenantId));
        await tx.delete(users).where(eq(users.id, userId));
      });
    }
  });
});
