import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDatabase, invitations, waitlistEntries, withServiceRole } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to seed local beta access.");
if (process.env.NODE_ENV === "production") throw new Error("The local beta seed cannot run in production.");

const email = (process.env.LOCAL_OWNER_EMAIL || "owner@hive.local").trim().toLowerCase();
const rawToken = randomBytes(32).toString("base64url");
const tokenDigest = createHash("sha256").update(rawToken).digest("hex");
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
const database = createDatabase(databaseUrl);

try {
  await withServiceRole(database.db, async (tx) => {
    await tx.insert(waitlistEntries).values({ email, useCase: "Local owner acceptance testing", approvedAt: new Date() })
      .onConflictDoUpdate({ target: waitlistEntries.email, set: { approvedAt: new Date(), useCase: "Local owner acceptance testing" } });
    await tx.update(invitations).set({ status: "revoked" }).where(and(eq(invitations.email, email), eq(invitations.status, "pending")));
    await tx.insert(invitations).values({ email, tokenDigest, status: "pending", expiresAt });
  });
  console.log(JSON.stringify({ event: "local_beta_seeded", email, invite_path: `/invite/${rawToken}`, expires_at: expiresAt.toISOString() }));
} finally {
  await database.pool.end();
}
