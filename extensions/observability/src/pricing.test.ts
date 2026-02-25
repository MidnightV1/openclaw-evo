/**
 * Unit tests for pricing.ts — model pricing lookup and cost estimation.
 *
 * Tests cover:
 * - Exact and prefix model lookup
 * - Cost calculation with known token counts
 * - Tiered pricing (context-length based)
 * - Cache read token pricing (explicit and fallback to input rate)
 * - Multi-currency (USD / CNY)
 * - Fallback behavior for unknown models
 * - User pricing overrides via loadPricingOverrides
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  estimateCost,
  getModelPricing,
  loadPricingOverrides,
  type CostEstimate,
  type PricingConfig,
} from "./pricing.js";

// ---------------------------------------------------------------------------
// Reset active pricing after each test to prevent cross-test pollution.
// loadPricingOverrides({}) would merge empty onto defaults, restoring them.
// ---------------------------------------------------------------------------
afterEach(() => {
  loadPricingOverrides({});
});

// =========================================================================
// getModelPricing — lookup
// =========================================================================
describe("getModelPricing", () => {
  describe("exact match", () => {
    it("returns pricing for claude-opus-4-6", () => {
      const p = getModelPricing("claude-opus-4-6");
      expect(p).toBeDefined();
      expect(p!.currency).toBe("USD");
      expect(p!.tiers).toHaveLength(1);
      expect(p!.tiers[0].inputPer1M).toBe(15);
      expect(p!.tiers[0].outputPer1M).toBe(75);
      expect(p!.tiers[0].cacheReadPer1M).toBe(1.5);
    });

    it("returns pricing for a CNY model (deepseek-chat)", () => {
      const p = getModelPricing("deepseek-chat");
      expect(p).toBeDefined();
      expect(p!.currency).toBe("CNY");
      expect(p!.tiers[0].inputPer1M).toBe(1);
      expect(p!.tiers[0].outputPer1M).toBe(2);
      expect(p!.tiers[0].cacheReadPer1M).toBe(0.1);
    });

    it("returns pricing for a tiered model (gemini-2.5-pro)", () => {
      const p = getModelPricing("gemini-2.5-pro");
      expect(p).toBeDefined();
      expect(p!.tiers).toHaveLength(2);
      expect(p!.tiers[0].contextTokensAbove).toBeUndefined();
      expect(p!.tiers[1].contextTokensAbove).toBe(200_000);
    });
  });

  describe("prefix match", () => {
    it("matches claude-opus-4-6-20260215 to claude-opus-4-6", () => {
      const p = getModelPricing("claude-opus-4-6-20260215");
      expect(p).toBeDefined();
      expect(p!.tiers[0].inputPer1M).toBe(15);
    });

    it("matches gpt-4o-2024-11-20 to gpt-4o", () => {
      const p = getModelPricing("gpt-4o-2024-11-20");
      expect(p).toBeDefined();
      expect(p!.tiers[0].inputPer1M).toBe(2.5);
    });

    it("matches gemini-2.5-flash-preview to gemini-2.5-flash", () => {
      const p = getModelPricing("gemini-2.5-flash-preview");
      expect(p).toBeDefined();
      expect(p!.tiers).toHaveLength(2);
    });
  });

  describe("no match", () => {
    it("returns undefined for completely unknown model", () => {
      const p = getModelPricing("nonexistent-model-xyz");
      expect(p).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      const p = getModelPricing("");
      expect(p).toBeUndefined();
    });
  });
});

// =========================================================================
// estimateCost — cost calculation
// =========================================================================
describe("estimateCost", () => {
  describe("known single-tier model (claude-opus-4-6)", () => {
    it("calculates cost for 1M input + 1M output tokens", () => {
      const cost = estimateCost({
        modelId: "claude-opus-4-6",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(cost.pricingFound).toBe(true);
      expect(cost.currency).toBe("USD");
      expect(cost.inputCost).toBeCloseTo(15, 5);
      expect(cost.outputCost).toBeCloseTo(75, 5);
      expect(cost.cacheReadCost).toBe(0);
      expect(cost.totalCost).toBeCloseTo(90, 5);
    });

    it("calculates cost for small token counts", () => {
      const cost = estimateCost({
        modelId: "claude-opus-4-6",
        inputTokens: 1000,
        outputTokens: 500,
      });
      // 1000/1M * 15 = 0.015, 500/1M * 75 = 0.0375
      expect(cost.inputCost).toBeCloseTo(0.015, 6);
      expect(cost.outputCost).toBeCloseTo(0.0375, 6);
      expect(cost.totalCost).toBeCloseTo(0.0525, 6);
    });

    it("handles zero tokens", () => {
      const cost = estimateCost({
        modelId: "claude-opus-4-6",
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(cost.pricingFound).toBe(true);
      expect(cost.totalCost).toBe(0);
    });

    it("handles undefined token counts (defaults to 0)", () => {
      const cost = estimateCost({
        modelId: "claude-opus-4-6",
      });
      expect(cost.pricingFound).toBe(true);
      expect(cost.inputCost).toBe(0);
      expect(cost.outputCost).toBe(0);
      expect(cost.cacheReadCost).toBe(0);
      expect(cost.totalCost).toBe(0);
    });
  });

  describe("cache read tokens", () => {
    it("uses explicit cacheReadPer1M when available (claude-opus-4-6)", () => {
      const cost = estimateCost({
        modelId: "claude-opus-4-6",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      });
      // cacheReadPer1M = 1.5 for claude-opus-4-6
      expect(cost.cacheReadCost).toBeCloseTo(1.5, 5);
      expect(cost.totalCost).toBeCloseTo(1.5, 5);
    });

    it("falls back to inputPer1M when cacheReadPer1M is undefined (gpt-4o)", () => {
      const cost = estimateCost({
        modelId: "gpt-4o",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      });
      // gpt-4o has no cacheReadPer1M, falls back to inputPer1M = 2.5
      expect(cost.cacheReadCost).toBeCloseTo(2.5, 5);
    });

    it("includes cache read in total cost alongside input and output", () => {
      const cost = estimateCost({
        modelId: "claude-sonnet-4-6",
        inputTokens: 500_000,
        outputTokens: 100_000,
        cacheReadTokens: 200_000,
      });
      // sonnet: input=3, output=15, cacheRead=0.3
      const expectedInput = (500_000 / 1_000_000) * 3; // 1.5
      const expectedOutput = (100_000 / 1_000_000) * 15; // 1.5
      const expectedCache = (200_000 / 1_000_000) * 0.3; // 0.06
      expect(cost.inputCost).toBeCloseTo(expectedInput, 6);
      expect(cost.outputCost).toBeCloseTo(expectedOutput, 6);
      expect(cost.cacheReadCost).toBeCloseTo(expectedCache, 6);
      expect(cost.totalCost).toBeCloseTo(expectedInput + expectedOutput + expectedCache, 6);
    });
  });

  describe("tiered pricing (gemini-2.5-pro)", () => {
    it("uses base tier when context <= 200K", () => {
      const cost = estimateCost({
        modelId: "gemini-2.5-pro",
        inputTokens: 100_000,
        outputTokens: 50_000,
        contextTokens: 150_000,
      });
      // Base tier: input=1.25, output=10
      expect(cost.inputCost).toBeCloseTo((100_000 / 1_000_000) * 1.25, 6);
      expect(cost.outputCost).toBeCloseTo((50_000 / 1_000_000) * 10, 6);
    });

    it("uses elevated tier when context > 200K", () => {
      const cost = estimateCost({
        modelId: "gemini-2.5-pro",
        inputTokens: 100_000,
        outputTokens: 50_000,
        contextTokens: 250_000,
      });
      // Elevated tier: input=2.5, output=15
      expect(cost.inputCost).toBeCloseTo((100_000 / 1_000_000) * 2.5, 6);
      expect(cost.outputCost).toBeCloseTo((50_000 / 1_000_000) * 15, 6);
    });

    it("uses base tier at exactly 200K context (threshold is >)", () => {
      const cost = estimateCost({
        modelId: "gemini-2.5-pro",
        inputTokens: 1_000_000,
        outputTokens: 0,
        contextTokens: 200_000,
      });
      // Exactly at threshold — selectTier uses >, not >=
      expect(cost.inputCost).toBeCloseTo((1_000_000 / 1_000_000) * 1.25, 6);
    });

    it("infers context from inputTokens + cacheReadTokens when contextTokens omitted", () => {
      // inputTokens=150000 + cacheReadTokens=100000 = 250000 > 200K → elevated tier
      const cost = estimateCost({
        modelId: "gemini-2.5-pro",
        inputTokens: 150_000,
        outputTokens: 10_000,
        cacheReadTokens: 100_000,
      });
      // contextTokens = 150000 + 100000 = 250000 → elevated tier
      expect(cost.inputCost).toBeCloseTo((150_000 / 1_000_000) * 2.5, 6);
      expect(cost.outputCost).toBeCloseTo((10_000 / 1_000_000) * 15, 6);
    });

    it("infers context from inputTokens alone when cacheReadTokens undefined", () => {
      const cost = estimateCost({
        modelId: "gemini-2.5-pro",
        inputTokens: 100_000,
        outputTokens: 10_000,
        // no cacheReadTokens, no contextTokens
      });
      // contextTokens = 100000 + 0 = 100000 → base tier
      expect(cost.inputCost).toBeCloseTo((100_000 / 1_000_000) * 1.25, 6);
    });
  });

  describe("unknown model fallback", () => {
    it("returns zero costs with pricingFound=false", () => {
      const cost = estimateCost({
        modelId: "nonexistent-model",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      });
      expect(cost.pricingFound).toBe(false);
      expect(cost.currency).toBe("USD");
      expect(cost.inputCost).toBe(0);
      expect(cost.outputCost).toBe(0);
      expect(cost.cacheReadCost).toBe(0);
      expect(cost.totalCost).toBe(0);
    });
  });

  describe("CNY models", () => {
    it("reports CNY currency for deepseek-reasoner", () => {
      const cost = estimateCost({
        modelId: "deepseek-reasoner",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 500_000,
      });
      expect(cost.pricingFound).toBe(true);
      expect(cost.currency).toBe("CNY");
      // deepseek-reasoner: input=4, output=16, cacheRead=0.4
      expect(cost.inputCost).toBeCloseTo(4, 5);
      expect(cost.outputCost).toBeCloseTo(16, 5);
      expect(cost.cacheReadCost).toBeCloseTo(0.2, 5); // 500K/1M * 0.4
      expect(cost.totalCost).toBeCloseTo(20.2, 5);
    });

    it("calculates kimi-k2.5 with cache savings", () => {
      const cost = estimateCost({
        modelId: "kimi-k2.5",
        inputTokens: 500_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
      });
      expect(cost.currency).toBe("CNY");
      // input: 500K/1M * 4 = 2
      // output: 100K/1M * 21 = 2.1
      // cache: 500K/1M * 0.7 = 0.35
      expect(cost.inputCost).toBeCloseTo(2, 5);
      expect(cost.outputCost).toBeCloseTo(2.1, 5);
      expect(cost.cacheReadCost).toBeCloseTo(0.35, 5);
      expect(cost.totalCost).toBeCloseTo(4.45, 5);
    });
  });
});

// =========================================================================
// loadPricingOverrides — custom pricing
// =========================================================================
describe("loadPricingOverrides", () => {
  it("overrides an existing model's pricing", () => {
    loadPricingOverrides({
      "gpt-4o": {
        currency: "USD",
        tiers: [{ inputPer1M: 999, outputPer1M: 999 }],
      },
    });

    const p = getModelPricing("gpt-4o");
    expect(p!.tiers[0].inputPer1M).toBe(999);
    expect(p!.tiers[0].outputPer1M).toBe(999);
  });

  it("adds a new model not in defaults", () => {
    loadPricingOverrides({
      "custom-model-v1": {
        currency: "USD",
        tiers: [{ inputPer1M: 1, outputPer1M: 2 }],
      },
    });

    const p = getModelPricing("custom-model-v1");
    expect(p).toBeDefined();
    expect(p!.tiers[0].inputPer1M).toBe(1);
  });

  it("preserves default models not in overrides", () => {
    loadPricingOverrides({
      "custom-only": {
        currency: "CNY",
        tiers: [{ inputPer1M: 10, outputPer1M: 20 }],
      },
    });

    // Default model should still be available
    const p = getModelPricing("claude-haiku-4-5");
    expect(p).toBeDefined();
    expect(p!.tiers[0].inputPer1M).toBe(0.8);
  });

  it("overrides propagate to estimateCost", () => {
    loadPricingOverrides({
      "claude-opus-4-6": {
        currency: "USD",
        tiers: [{ inputPer1M: 100, outputPer1M: 200 }],
      },
    });

    const cost = estimateCost({
      modelId: "claude-opus-4-6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost.inputCost).toBeCloseTo(100, 5);
    expect(cost.outputCost).toBeCloseTo(200, 5);
  });
});

// =========================================================================
// CostEstimate structure validation
// =========================================================================
describe("CostEstimate structure", () => {
  it("has all required fields for a known model", () => {
    const cost = estimateCost({
      modelId: "claude-opus-4-6",
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(cost).toHaveProperty("inputCost");
    expect(cost).toHaveProperty("outputCost");
    expect(cost).toHaveProperty("cacheReadCost");
    expect(cost).toHaveProperty("totalCost");
    expect(cost).toHaveProperty("currency");
    expect(cost).toHaveProperty("pricingFound");

    expect(typeof cost.inputCost).toBe("number");
    expect(typeof cost.outputCost).toBe("number");
    expect(typeof cost.cacheReadCost).toBe("number");
    expect(typeof cost.totalCost).toBe("number");
    expect(typeof cost.currency).toBe("string");
    expect(typeof cost.pricingFound).toBe("boolean");
  });

  it("totalCost equals sum of inputCost + outputCost + cacheReadCost", () => {
    const cost = estimateCost({
      modelId: "claude-opus-4-6",
      inputTokens: 123_456,
      outputTokens: 78_901,
      cacheReadTokens: 45_678,
    });
    expect(cost.totalCost).toBeCloseTo(
      cost.inputCost + cost.outputCost + cost.cacheReadCost,
      10,
    );
  });
});
