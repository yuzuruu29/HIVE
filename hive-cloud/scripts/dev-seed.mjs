#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { CloudStore } from "../apps/api/dist/store.js";

const databaseUrl = process.env.DATABASE_URL || "postgres://hive:hive@localhost:5432/hive_cloud";
const kekBase64 = Buffer.alloc(32, 1).toString("base64");

const store = new CloudStore({ databaseUrl, kekBase64 });
await store.ready();

try {
  const tenantA = randomUUID();
  const ownerA = { userId: randomUUID(), tenantId: tenantA, role: "owner", email: `owner-${tenantA}@hive.local` };
  await store.ensureSubject(ownerA);

  const conv1 = await store.createConversation(ownerA, "chat", "Farming in the Philippines");
  await store.appendMessage(ownerA, conv1.id, { role: "user", content: "What crops grow best in the Philippine climate?", status: "complete" });
  await store.appendMessage(ownerA, conv1.id, { role: "assistant", content: "Rice, coconut, banana, mango, and sugarcane thrive in the tropical Philippine climate with year-round warmth and rainfall. Rice is the staple crop, grown across Luzon and Mindanao.", status: "complete" });
  await store.appendMessage(ownerA, conv1.id, { role: "user", content: "What about coffee production?", status: "complete" });
  await store.appendMessage(ownerA, conv1.id, { role: "assistant", content: "Coffee is grown in the highlands of Batangas, Benguet, and Sagada. Arabica thrives at higher elevations while Robusta grows at lower altitudes. The Philippines has a growing specialty coffee scene.", status: "complete" });

  const conv2 = await store.createConversation(ownerA, "chat", "Building a semantic search engine");
  await store.appendMessage(ownerA, conv2.id, { role: "user", content: "How do I implement semantic search with PostgreSQL and pgvector?", status: "complete" });
  await store.appendMessage(ownerA, conv2.id, { role: "assistant", content: "You need the pgvector extension, create an embedding column, and use cosine similarity with an index. For multilingual data, use a model that supports your target languages.", status: "complete" });
  await store.appendMessage(ownerA, conv2.id, { role: "user", content: "Can I combine full-text search with vector search?", status: "complete" });
  await store.appendMessage(ownerA, conv2.id, { role: "assistant", content: "Yes, a hybrid approach using to_tsvector for exact keyword matching and pgvector for semantic similarity gives the best results for most search applications.", status: "complete" });
  await store.appendMessage(ownerA, conv2.id, { role: "user", content: "What about performance for large datasets?", status: "complete" });
  await store.appendMessage(ownerA, conv2.id, { role: "assistant", content: "Use HNSW indexes for vector search and GIN indexes for full-text search. Partition large tables by tenant_id. Set appropriate work_mem and maintenance_work_mem values.", status: "complete" });

  const conv3 = await store.createConversation(ownerA, "chat", "Tagalog language model discussion");
  await store.appendMessage(ownerA, conv3.id, { role: "user", content: "Are there any good Tagalog language models?", status: "complete" });
  await store.appendMessage(ownerA, conv3.id, { role: "assistant", content: "Most multilingual models like mT5, XLM-R, and GPT-4o handle Tagalog reasonably well. Fine-tuning on Tagalog corpora improves performance significantly for downstream tasks.", status: "complete" });
  await store.appendMessage(ownerA, conv3.id, { role: "user", content: "What about code-switching between Tagalog and English?", status: "complete" });
  await store.appendMessage(ownerA, conv3.id, { role: "assistant", content: "Code-switching (Taglish) is common in the Philippines. Models trained on mixed-language data handle this better. The CALM dataset and TLUnified dataset are good resources.", status: "complete" });

  const conv4 = await store.createConversation(ownerA, "chat", "Deployment and testing notes");
  await store.appendMessage(ownerA, conv4.id, { role: "user", content: "What CI/CD pipeline do you recommend for Next.js apps?", status: "complete" });
  await store.appendMessage(ownerA, conv4.id, { role: "assistant", content: "Use GitHub Actions with parallel linting, type checking, unit tests, and E2E tests. Deploy to Vercel with preview deployments for each PR. Use Sentry for error tracking.", status: "complete" });

  const conv5 = await store.createConversation(ownerA, "chat", "Archived discussion about APIs");
  await store.appendMessage(ownerA, conv5.id, { role: "user", content: "What's the best way to design REST API versioning?", status: "complete" });
  await store.appendMessage(ownerA, conv5.id, { role: "assistant", content: "URL-based versioning (/v1/, /v2/) is the most explicit approach. Maintain backward compatibility for at least one version. Use OpenAPI specs for documentation.", status: "complete" });
  await store.updateConversation(ownerA, conv5.id, { archived: true });

  const tenantB = randomUUID();
  const ownerB = { userId: randomUUID(), tenantId: tenantB, role: "owner", email: `owner-${tenantB}@other.net` };
  await store.ensureSubject(ownerB);
  const otherConv = await store.createConversation(ownerB, "chat", "Isolation test data");
  await store.appendMessage(ownerB, otherConv.id, { role: "user", content: "This content should never appear in Tenant A searches. Our secret project code is Project Aurora.", status: "complete" });
  await store.appendMessage(ownerB, otherConv.id, { role: "assistant", content: "Confirmed. The Aurora project budget is confidential and should not leak across tenant boundaries.", status: "complete" });

  console.log(JSON.stringify({ event: "dev_seed_complete", tenantA, tenantB, conversationCount: 6, messageCount: 18 }));
} finally {
  await store.close();
}
