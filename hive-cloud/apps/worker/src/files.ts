import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { UnrecoverableError, type Job } from "bullmq";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { extractText } from "./extract.js";
import type { InternalSubject } from "@hive-cloud/security";

interface FileJob {
  id: string;
  subject: InternalSubject;
  objectKey: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface FileProcessorOptions {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
  clamHost: string;
  clamPort: number;
  apiOrigin: string;
  serviceSecret: string;
}

class UnsafeFileError extends Error {}

function scanWithClamAv(buffer: Buffer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let response = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const evaluateResponse = () => {
      if (response.includes("FOUND")) finish(new UnsafeFileError("Malware signature detected."));
      else if (response.includes("OK")) finish();
      else finish(new Error(`ClamAV returned an invalid response: ${response.slice(0, 120)}`));
    };
    socket.setTimeout(15_000);
    socket.on("error", (error) => finish(error));
    socket.on("timeout", () => finish(new Error("ClamAV scan timed out.")));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (response.includes("\0") || response.includes("\n")) evaluateResponse();
    });
    socket.on("close", () => { if (!settled) evaluateResponse(); });
    socket.connect(port, host, () => {
      socket.write("zINSTREAM\0");
      for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
        const chunk = buffer.subarray(offset, Math.min(buffer.length, offset + 64 * 1024));
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}

async function validatedPayload(buffer: Buffer, mimeType: string): Promise<Buffer> {
  const detected = await fileTypeFromBuffer(buffer);
  const binaryTypes: Record<string, string> = {
    "image/png": "image/png",
    "image/jpeg": "image/jpeg",
    "image/webp": "image/webp",
    "application/pdf": "application/pdf",
  };
  if (mimeType in binaryTypes && detected?.mime !== binaryTypes[mimeType]) throw new UnsafeFileError("File magic bytes do not match the declared MIME type.");
  if (!(mimeType in binaryTypes) && (detected || buffer.includes(0))) throw new UnsafeFileError("A binary file was supplied as text.");
  if (!mimeType.startsWith("image/")) return buffer;
  const image = sharp(buffer, { failOn: "warning" }).rotate();
  if (mimeType === "image/png") return image.png().toBuffer();
  if (mimeType === "image/webp") return image.webp().toBuffer();
  return image.jpeg().toBuffer();
}

async function reportResult(options: FileProcessorOptions, data: FileJob, status: "approved" | "rejected", extra: { objectKey?: string; sha256?: string; extractedText?: string } = {}) {
  const response = await fetch(`${options.apiOrigin}/internal/files/${data.id}/result`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hive-service-secret": options.serviceSecret },
    body: JSON.stringify({
      tenant_id: data.subject.tenantId,
      user_id: data.subject.userId,
      email: data.subject.email,
      role: data.subject.role,
      status,
      ...(extra.objectKey ? { object_key: extra.objectKey } : {}),
      ...(extra.sha256 ? { sha256: extra.sha256 } : {}),
      ...(extra.extractedText ? { extracted_text: extra.extractedText } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Attachment result callback failed with HTTP ${response.status}.`);
}

export function createFileProcessor(options: FileProcessorOptions) {
  const client = new S3Client({ region: "auto", endpoint: options.endpoint, forcePathStyle: options.forcePathStyle, credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } });
  return async (job: Job<FileJob>) => {
    const data = job.data;
    try {
      const object = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: data.objectKey }));
      if (!object.Body) throw new Error("Quarantine object has no body.");
      const buffer = Buffer.from(await object.Body.transformToByteArray());
      if (buffer.length !== data.sizeBytes || buffer.length > 20 * 1024 * 1024) throw new UnsafeFileError("Quarantine object size does not match the upload record.");
      await scanWithClamAv(buffer, options.clamHost, options.clamPort);
      const approved = await validatedPayload(buffer, data.mimeType);
      const sha256 = createHash("sha256").update(approved).digest("hex");
      const approvedKey = `approved/${data.subject.tenantId}/${data.id}/${data.originalName}`;
      await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: approvedKey, Body: approved, ContentType: data.mimeType, Metadata: { tenant: data.subject.tenantId, file: data.id, sha256 } }));
      await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: data.objectKey }));
      const extractedText = await extractText(approved, data.mimeType);
      await reportResult(options, data, "approved", { 
        objectKey: approvedKey, 
        sha256, 
        ...(extractedText ? { extractedText } : {}) 
      });
      return { id: data.id, status: "approved", object_key: approvedKey, sha256 };
    } catch (error) {
      if (error instanceof UnsafeFileError) {
        await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: data.objectKey })).catch(() => undefined);
        await reportResult(options, data, "rejected");
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}
