import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { redactKnownSecrets } from "../../security/secrets.js";

export interface RendererLocationPolicy { rendererFile?: string; developmentUrl?: string }
export interface IpcSenderLike { url: string }


function normalizedFileUrl(file: string): string {
  return pathToFileURL(path.resolve(file)).href;
}

export function isTrustedRendererUrl(url: string, policy: RendererLocationPolicy): boolean {
  try {
    const parsed = new URL(url);
    if (policy.developmentUrl) {
      const expected = new URL(policy.developmentUrl);
      if (parsed.protocol === expected.protocol && parsed.hostname === expected.hostname && parsed.port === expected.port && parsed.pathname === expected.pathname) return true;
    }
    if (policy.rendererFile && parsed.protocol === "file:") {
      const parsedNormalized = normalizedFileUrl(fileURLToPath(parsed));
      const policyNormalized = normalizedFileUrl(policy.rendererFile);
      if (process.platform === "win32") {
        return parsedNormalized.toLowerCase() === policyNormalized.toLowerCase();
      }
      return parsedNormalized === policyNormalized;
    }
    return false;
  } catch { return false; }
}

export function validateIpcSender(sender: IpcSenderLike, policy: RendererLocationPolicy): void {
  if (!sender || typeof sender.url !== "string" || !isTrustedRendererUrl(sender.url, policy)) throw new Error("Rejected untrusted desktop IPC sender.");
}

export function redactDesktopFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const value = redactKnownSecrets(raw);
  return value.slice(0, 2_000) || "Desktop request failed.";
}

export const DESKTOP_BROWSER_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
} as const);

const BASE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
];

export const DESKTOP_CSP = [...BASE_CSP, "connect-src 'self'"].join("; ");

export function desktopContentSecurityPolicy(developmentUrl?: string): string {
  if (!developmentUrl) return DESKTOP_CSP;
  const parsed = new URL(developmentUrl);
  const websocket = `${parsed.protocol === "https:" ? "wss:" : "ws:"}//${parsed.host}`;
  return [...BASE_CSP, `connect-src 'self' ${parsed.origin} ${websocket}`].join("; ");
}
