import { describe, expect, it } from "vitest";

import { estimateTokenUsageCostUsd } from "./provider-pricing.ts";

describe("provider pricing", () => {
  it("uses the most specific family price for versioned model identifiers", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

    expect(estimateTokenUsageCostUsd("gpt-5.6-terra-2026-08-01", usage)).toBe(
      14,
    );
    expect(estimateTokenUsageCostUsd("gpt-5.6-luna-2026-08-01", usage)).toBe(
      1.4,
    );
  });
});
