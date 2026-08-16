import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { createInternalAuthHeaders } from "@hive-cloud/security";
import { currentSubject } from "@/lib/subject";

const FORWARDED_HEADERS = [
  "content-type",
  "cache-control",
  "x-hive-request-id",
  "x-hive-provider",
  "x-hive-model",
  "x-hive-route-policy",
  "x-hive-fallback-count",
  "x-hive-conversation-id",
  "location",
] as const;

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const apiPath = `/api/${path.join("/")}${request.nextUrl.search}`;
  const pathStr = path.join("/");
  const publicWaitlist = pathStr === "waitlist";
  const publicShared = pathStr.startsWith("shared/");
  const subject = (publicWaitlist || publicShared) ? null : await currentSubject();
  if (!publicWaitlist && !publicShared && !subject) return NextResponse.json({ error: { code: "unauthorized", message: "Sign in with an invited account." } }, { status: 401 });
  const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
  if (!publicWaitlist && !publicShared && (!internalSecret || internalSecret.length < 32)) return NextResponse.json({ error: { code: "configuration_error", message: "The web service cannot authenticate to the API." } }, { status: 503 });
  const origin = process.env.API_INTERNAL_ORIGIN || "http://localhost:4000";
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
  const authHeaders = subject ? createInternalAuthHeaders(subject, internalSecret || "", request.method, apiPath) : {};
  const upstream = await fetch(`${origin.replace(/\/$/, "")}${apiPath}`, {
    method: request.method,
    headers: {
      ...authHeaders,
      ...(request.headers.get("content-type") ? { "content-type": request.headers.get("content-type")! } : {}),
      ...(request.headers.get("idempotency-key") ? { "idempotency-key": request.headers.get("idempotency-key")! } : {}),
      ...(request.headers.get("x-hive-conversation-id") ? { "x-hive-conversation-id": request.headers.get("x-hive-conversation-id")! } : {}),
    },
    body,
    cache: "no-store",
    redirect: "manual",
    signal: request.signal,
  });
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
