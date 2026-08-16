export function betaBypassEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.HIVE_BETA_BYPASS === "true";
}
