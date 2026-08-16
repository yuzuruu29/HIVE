import { lte, and, eq } from "drizzle-orm";
import { conversations, invitations, attachments, messages, messageAttachments, citations, createDatabase } from "@hive-cloud/database";
import type { Job } from "bullmq";

export function createMaintenanceProcessor(database: ReturnType<typeof createDatabase>) {
  return async (job: Job) => {
    const now = new Date();
    
    // Expire pending invitations
    await database.db.transaction(async (tx: any) => {
      await tx.update(invitations)
        .set({ status: "expired" })
        .where(and(eq(invitations.status, "pending"), lte(invitations.expiresAt, now)));
    });

    // Delete conversations scheduled for purge
    await database.db.transaction(async (tx: any) => {
      const purged = await tx.delete(conversations)
        .where(lte(conversations.purgeAfter, now))
        .returning({ id: conversations.id });
      
      if (purged.length > 0) {
        console.log(`Purged ${purged.length} conversations`);
      }
    });

    return { status: "maintenance_complete" };
  };
}
