import { createHash } from "node:crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { and, eq } from "drizzle-orm";
import { attachments, createDatabase, memberships, users, withServiceRole } from "@hive-cloud/database";
import { createInternalAuthHeaders } from "@hive-cloud/security";

const required = ["DATABASE_URL", "API_INTERNAL_ORIGIN", "INTERNAL_SERVICE_SECRET", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
for (const key of required) if (!process.env[key]) throw new Error(`${key} is required for the file-pipeline smoke test.`);

const database = createDatabase(process.env.DATABASE_URL);
const email = (process.env.LOCAL_OWNER_EMAIL || "owner@hive.local").toLowerCase();
const apiOrigin = process.env.API_INTERNAL_ORIGIN.replace(/\/$/, "");
const content = Buffer.from("HIVE local file-pipeline acceptance\n", "utf8");
const name = "hive-file-smoke.txt";
const mimeType = "text/plain";

try {
  const subject = await withServiceRole(database.db, async (tx) => {
    const [row] = await tx.select({ userId: users.id, tenantId: memberships.tenantId, role: memberships.role })
      .from(users).innerJoin(memberships, eq(memberships.userId, users.id)).where(eq(users.email, email)).limit(1);
    if (!row) throw new Error(`No seeded local owner exists for ${email}.`);
    return { ...row, email };
  });

  const presignPath = "/api/files/presign";
  const presign = await fetch(`${apiOrigin}${presignPath}`, {
    method: "POST",
    headers: { ...createInternalAuthHeaders(subject, process.env.INTERNAL_SERVICE_SECRET, "POST", presignPath), "content-type": "application/json" },
    body: JSON.stringify({ name, mime_type: mimeType, size_bytes: content.byteLength }),
  });
  if (!presign.ok) throw new Error(`Presign failed with HTTP ${presign.status}: ${await presign.text()}`);
  const { data } = await presign.json();
  const uploaded = await fetch(data.upload_url, { method: "PUT", headers: data.upload_headers, body: content });
  if (!uploaded.ok) throw new Error(`Object upload failed with HTTP ${uploaded.status}: ${await uploaded.text()}`);

  const completePath = `/api/files/${data.id}/complete`;
  const complete = await fetch(`${apiOrigin}${completePath}`, {
    method: "POST",
    headers: { ...createInternalAuthHeaders(subject, process.env.INTERNAL_SERVICE_SECRET, "POST", completePath), "content-type": "application/json" },
    body: JSON.stringify({ name, mime_type: mimeType, size_bytes: content.byteLength, object_key: data.object_key }),
  });
  if (!complete.ok) throw new Error(`Completion failed with HTTP ${complete.status}: ${await complete.text()}`);

  let attachment;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    [attachment] = await withServiceRole(database.db, (tx) => tx.select().from(attachments).where(and(eq(attachments.id, data.id), eq(attachments.tenantId, subject.tenantId))).limit(1));
    if (attachment?.status === "approved" || attachment?.status === "rejected") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!attachment || attachment.status !== "approved" || !attachment.sha256) throw new Error(`File pipeline ended in ${attachment?.status || "unknown"}.`);

  const storage = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    forcePathStyle: process.env.R2_FORCE_PATH_STYLE === "true",
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  const object = await storage.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET || "hive-cloud", Key: attachment.objectKey }));
  const downloaded = Buffer.from(await object.Body.transformToByteArray());
  const expectedSha256 = createHash("sha256").update(content).digest("hex");
  if (!downloaded.equals(content) || attachment.sha256 !== expectedSha256) throw new Error("Approved object content or checksum did not match the upload.");
  console.log(JSON.stringify({ event: "file_pipeline_verified", id: data.id, status: attachment.status, sha256: attachment.sha256 }));
} finally {
  await database.pool.end();
}
