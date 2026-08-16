export interface PriceSnapshot {
  id: string;
  provider: string;
  model: string;
  inputMicrousdPerMillionTokens: number;
  outputMicrousdPerMillionTokens: number;
  cacheReadMicrousdPerMillionTokens?: number;
  sourceUrl: string;
  effectiveFrom?: string;
}

export interface CostEstimate {
  estimatedProviderCostMicrousd: number;
  estimatedCredits: number;
  breakdown: {
    inputCostMicrousd: number;
    outputCostMicrousd: number;
    cacheWriteCostMicrousd: number;
  };
}

const MICROUSD_PER_CREDIT = 10_000;
const MANAGED_MULTIPLIER = 2;

export class PriceRegistry {
  readonly #prices = new Map<string, PriceSnapshot>();

  public loadSnapshot(snapshot: PriceSnapshot): void {
    for (const value of [snapshot.inputMicrousdPerMillionTokens, snapshot.outputMicrousdPerMillionTokens, snapshot.cacheReadMicrousdPerMillionTokens ?? 0]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Price snapshots must use non-negative integer micro-USD rates per million tokens");
    }
    const key = `${snapshot.provider}:${snapshot.model}`;
    this.#prices.set(key, snapshot);
  }

  public getPrice(provider: string, model: string): PriceSnapshot | undefined {
    return this.#prices.get(`${provider}:${model}`);
  }

  public isStale(provider: string, model: string, staleMinutes: number): boolean {
    const snapshot = this.getPrice(provider, model);
    if (!snapshot || !snapshot.effectiveFrom) return true;
    const age = Date.now() - new Date(snapshot.effectiveFrom).getTime();
    return age > staleMinutes * 60 * 1000;
  }

  public estimateCost(
    provider: string,
    model: string,
    estimatedInputTokens: number,
    estimatedOutputTokens: number,
  ): CostEstimate {
    const price = this.getPrice(provider, model);
    if (!price) {
      throw new Error(`No price data for ${provider}/${model}`);
    }

    const inputCostMicrousd = Math.ceil(
      (estimatedInputTokens * price.inputMicrousdPerMillionTokens) / 1_000_000
    );
    const outputCostMicrousd = Math.ceil(
      (estimatedOutputTokens * price.outputMicrousdPerMillionTokens) / 1_000_000
    );
    const cacheWriteCostMicrousd = 0;

    const totalProviderCostMicrousd = inputCostMicrousd + outputCostMicrousd + cacheWriteCostMicrousd;
    const retailCostMicrousd = totalProviderCostMicrousd * MANAGED_MULTIPLIER;
    const estimatedCredits = Math.ceil(retailCostMicrousd / MICROUSD_PER_CREDIT);

    return {
      estimatedProviderCostMicrousd: totalProviderCostMicrousd,
      estimatedCredits,
      breakdown: { inputCostMicrousd, outputCostMicrousd, cacheWriteCostMicrousd },
    };
  }

  public settleCost(
    provider: string,
    model: string,
    actualInputTokens: number,
    actualOutputTokens: number,
    cacheHitTokens: number = 0,
    cacheWriteTokens: number = 0,
  ): { providerCostMicrousd: number; debitedCredits: number } {
    const price = this.getPrice(provider, model);
    if (!price) {
      throw new Error(`No price data for ${provider}/${model}`);
    }

    const inputCost = Math.ceil((actualInputTokens * price.inputMicrousdPerMillionTokens) / 1_000_000);
    const outputCost = Math.ceil((actualOutputTokens * price.outputMicrousdPerMillionTokens) / 1_000_000);
    const cacheReadCost = price.cacheReadMicrousdPerMillionTokens
      ? Math.ceil((cacheHitTokens * price.cacheReadMicrousdPerMillionTokens) / 1_000_000)
      : 0;

    const totalProviderCostMicrousd = inputCost + outputCost + cacheReadCost;
    const retailCostMicrousd = totalProviderCostMicrousd * MANAGED_MULTIPLIER;
    const debitedCredits = Math.ceil(retailCostMicrousd / MICROUSD_PER_CREDIT);

    return { providerCostMicrousd: totalProviderCostMicrousd, debitedCredits };
  }
}
