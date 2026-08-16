import type { PriceSnapshot } from "./price-registry.js";

// Managed routing fails closed until an operator supplies dated price snapshots.
// Provider prices are intentionally not baked into releases because they drift.
export const DEFAULT_PRICES: PriceSnapshot[] = [];
