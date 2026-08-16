import type { FastifyRequest } from "fastify";
import type { InternalSubject } from "@hive-cloud/security";
import { verifyInternalAuthHeaders } from "@hive-cloud/security";
import type { CloudStore } from "./store.js";
import type { ApiEnv } from "./env.js";

export interface AuthContext extends InternalSubject {
  apiKeyId?: string;
  scopes: string[];
  internal: boolean;
}

function asHeaders(headers: FastifyRequest["headers"]): Record<string, string | string[] | undefined> {
  return headers;
}

export async function authenticateRequest(
  request: FastifyRequest,
  env: ApiEnv,
  store: CloudStore,
  requiredScopes: string[] = [],
): Promise<AuthContext | null> {
  const internal = verifyInternalAuthHeaders(
    asHeaders(request.headers),
    env.INTERNAL_SERVICE_SECRET,
    request.method,
    request.url,
  );
  if (internal) return { ...internal, scopes: ["models:read", "chat:write", "product:write"], internal: true };

  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return null;
  const key = await store.authenticateApiKey(bearer, env.HIVE_API_KEY_PEPPER);
  if (!key || requiredScopes.some((scope) => !key.scopes.includes(scope))) return null;
  return { ...key.subject, apiKeyId: key.id, scopes: key.scopes, internal: false };
}
