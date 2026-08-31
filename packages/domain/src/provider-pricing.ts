export interface ModelPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export const MODEL_PRICING_USD: Readonly<Record<string, ModelPricing>> = {
  "gpt-5.6-sol": {
    inputUsdPerMillionTokens: 4,
    outputUsdPerMillionTokens: 20,
  },
  "gpt-5.6": {
    inputUsdPerMillionTokens: 4,
    outputUsdPerMillionTokens: 20,
  },
  "gpt-5.6-terra": {
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 12,
  },
  "gpt-5.6-luna": {
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
  },
};

export const MODEL_PRICING_AS_OF = "2026-08-29";

function pricingForModel(model: string): ModelPricing | undefined {
  const exact = MODEL_PRICING_USD[model];
  if (exact) return exact;
  return Object.entries(MODEL_PRICING_USD).find(([prefix]) =>
    model.startsWith(`${prefix}-`),
  )?.[1];
}

export function estimateTokenUsageCostUsd(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
  } | null,
): number | null {
  if (!usage) return null;
  const pricing = pricingForModel(model);
  if (!pricing) return null;
  return (
    (usage.inputTokens * pricing.inputUsdPerMillionTokens +
      usage.outputTokens * pricing.outputUsdPerMillionTokens) /
    1_000_000
  );
}
