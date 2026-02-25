/**
 * Model pricing configuration and cost estimation.
 *
 * Supports:
 * - Per-million-token pricing (input / output / cache)
 * - Tiered pricing by context length (e.g., Gemini >200K)
 * - Multi-currency (USD / CNY) — each model declares its billing currency
 * - User overrides via pricing.json
 */

export type Currency = "USD" | "CNY";

/** A single pricing tier. If contextTokensAbove is omitted, this is the base tier. */
export type PricingTier = {
  /** Applies when total context tokens exceed this threshold. Omit for base tier. */
  contextTokensAbove?: number;
  /** Cost per 1M input tokens */
  inputPer1M: number;
  /** Cost per 1M output tokens */
  outputPer1M: number;
  /** Cost per 1M cached input tokens (defaults to inputPer1M if omitted) */
  cacheReadPer1M?: number;
};

export type ModelPricing = {
  /** Billing currency for this model */
  currency: Currency;
  /**
   * Pricing tiers, ordered from base to highest threshold.
   * At least one tier (base) is required.
   * For tiered models, the tier whose contextTokensAbove is the highest
   * value still <= actual context size is selected.
   */
  tiers: PricingTier[];
};

export type PricingConfig = Record<string, ModelPricing>;

/** Helper: single-tier USD model */
function usd(inputPer1M: number, outputPer1M: number, cacheReadPer1M?: number): ModelPricing {
  return { currency: "USD", tiers: [{ inputPer1M, outputPer1M, cacheReadPer1M }] };
}

/** Helper: single-tier CNY model */
function cny(inputPer1M: number, outputPer1M: number, cacheReadPer1M?: number): ModelPricing {
  return { currency: "CNY", tiers: [{ inputPer1M, outputPer1M, cacheReadPer1M }] };
}

/** Helper: tiered USD model */
function usdTiered(tiers: PricingTier[]): ModelPricing {
  return { currency: "USD", tiers };
}

/**
 * Built-in pricing defaults (per 1M tokens).
 * Updated 2026-02-24. Users can override via pricing.json.
 */
const DEFAULT_PRICING: PricingConfig = {
  // --- Anthropic (USD) ---
  "claude-opus-4-6": usd(15, 75, 1.5),
  "claude-sonnet-4-6": usd(3, 15, 0.3),
  "claude-haiku-4-5": usd(0.8, 4, 0.08),

  // --- OpenAI (USD) ---
  "gpt-4o": usd(2.5, 10),
  "gpt-4o-mini": usd(0.15, 0.6),
  "o3": usd(10, 40),
  "o3-mini": usd(1.1, 4.4),
  "o4-mini": usd(1.1, 4.4),

  // --- Google (USD, tiered by context length) ---
  "gemini-2.5-pro": usdTiered([
    { inputPer1M: 1.25, outputPer1M: 10 },
    { contextTokensAbove: 200_000, inputPer1M: 2.5, outputPer1M: 15 },
  ]),
  "gemini-2.5-flash": usdTiered([
    { inputPer1M: 0.15, outputPer1M: 0.6 },
    { contextTokensAbove: 200_000, inputPer1M: 0.3, outputPer1M: 1.2 },
  ]),
  "gemini-3-flash": usd(0.15, 0.6),

  // --- 字节跳动 / Volcengine (CNY) ---
  "doubao-1.5-pro-32k": cny(0.8, 2),
  "doubao-1.5-pro-256k": cny(5, 9),
  "doubao-2.0-pro": cny(0.8, 2),

  // --- 阿里 / Qwen (CNY) ---
  "qwen-max": cny(2, 6),
  "qwen-plus": cny(0.8, 2),
  "qwen-turbo": cny(0.3, 0.6),
  "qwen3-235b-a22b": cny(4, 16),

  // --- DeepSeek (CNY, tiered by cache) ---
  "deepseek-chat": cny(1, 2, 0.1),
  "deepseek-reasoner": cny(4, 16, 0.4),

  // --- Moonshot / Kimi (CNY) ---
  // kimi-k2.5: input(cache miss) ¥4/1M, input(cache hit) ¥0.70/1M, output ¥21/1M, 262K ctx
  "kimi-k2.5": cny(4, 21, 0.7),
  "moonshot-v1-auto": cny(15, 60),
  "kimi-latest": cny(15, 60),

  // --- MiniMax (CNY) ---
  "minimax-text-01": cny(1, 8),
};

let activePricing: PricingConfig = { ...DEFAULT_PRICING };

export function loadPricingOverrides(overrides: PricingConfig): void {
  activePricing = { ...DEFAULT_PRICING, ...overrides };
}

export function getModelPricing(modelId: string): ModelPricing | undefined {
  // Exact match
  if (activePricing[modelId]) {
    return activePricing[modelId];
  }
  // Prefix match (e.g., "claude-opus-4-6-20260215" → "claude-opus-4-6")
  for (const key of Object.keys(activePricing)) {
    if (modelId.startsWith(key)) {
      return activePricing[key];
    }
  }
  return undefined;
}

/**
 * Select the applicable pricing tier based on total context token count.
 * Picks the tier with the highest contextTokensAbove that is still <= contextTokens.
 */
function selectTier(tiers: PricingTier[], contextTokens: number): PricingTier {
  let selected = tiers[0]!; // base tier (no threshold)
  for (const tier of tiers) {
    if (
      tier.contextTokensAbove !== undefined &&
      contextTokens > tier.contextTokensAbove &&
      (selected.contextTokensAbove === undefined ||
        tier.contextTokensAbove > selected.contextTokensAbove)
    ) {
      selected = tier;
    }
  }
  return selected;
}

export type CostEstimate = {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  totalCost: number;
  /** Billing currency of the model */
  currency: Currency;
  /** Whether pricing data was found for this model */
  pricingFound: boolean;
};

export function estimateCost(params: {
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** Total context tokens (for tiered pricing selection) */
  contextTokens?: number;
}): CostEstimate {
  const pricing = getModelPricing(params.modelId);
  if (!pricing) {
    return {
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      totalCost: 0,
      currency: "USD",
      pricingFound: false,
    };
  }

  // Select tier based on context size
  const contextTokens =
    params.contextTokens ??
    (params.inputTokens ?? 0) + (params.cacheReadTokens ?? 0);
  const tier = selectTier(pricing.tiers, contextTokens);

  const inputCost = ((params.inputTokens ?? 0) / 1_000_000) * tier.inputPer1M;
  const outputCost = ((params.outputTokens ?? 0) / 1_000_000) * tier.outputPer1M;
  const cacheReadCost =
    ((params.cacheReadTokens ?? 0) / 1_000_000) * (tier.cacheReadPer1M ?? tier.inputPer1M);

  return {
    inputCost,
    outputCost,
    cacheReadCost,
    totalCost: inputCost + outputCost + cacheReadCost,
    currency: pricing.currency,
    pricingFound: true,
  };
}
