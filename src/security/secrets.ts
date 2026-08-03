const KNOWN_SECRET_RULES: Array<{ pattern: RegExp; replacement: string | ((match: string, key: string) => string) }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{12,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bhf_[A-Za-z0-9]{20,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{3,}\b/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*([^\s"'`]+)/gi, replacement: (_match, key) => `${key}=[REDACTED]` },
];

const SENSITIVE_FIELD_NAMES = new Set([
  "secret", "token", "apikey", "password", "privatekey", "authorization", "accesskey", "accesskeyid",
  "secretaccesskey", "accesstoken", "refreshtoken", "clientsecret", "credential", "credentials",
]);

export function redactKnownSecrets(value: string): string {
  let redacted = value;
  for (const rule of KNOWN_SECRET_RULES) redacted = typeof rule.replacement === "string"
    ? redacted.replace(rule.pattern, rule.replacement)
    : redacted.replace(rule.pattern, rule.replacement);
  return redacted;
}

export function containsKnownSecret(value: string): boolean { return redactKnownSecrets(value) !== value; }

export function isCredentialFieldName(key: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(key.replace(/[^A-Za-z0-9]/g, "").toLowerCase());
}
