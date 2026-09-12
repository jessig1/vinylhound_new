import { describe, expect, it } from "vitest";

import { GetBatchResponseSchema } from "./batch.ts";

describe("GetBatchResponseSchema", () => {
  it("accepts a batch with mixed-status scans and no candidate yet", () => {
    expect(
      GetBatchResponseSchema.parse({
        batchId: "00000000-0000-4000-8000-000000000001",
        createdAt: new Date().toISOString(),
        scans: [
          {
            scanId: "00000000-0000-4000-8000-000000000002",
            status: "processing",
            createdAt: new Date().toISOString(),
            completedAt: null,
            thumbnailImageId: null,
            topCandidate: null,
          },
          {
            scanId: "00000000-0000-4000-8000-000000000003",
            status: "identified",
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            thumbnailImageId: "00000000-0000-4000-8000-000000000005",
            topCandidate: {
              id: "00000000-0000-4000-8000-000000000004",
              rank: 1,
              artist: "Miles Davis",
              title: "Kind of Blue",
              releaseYear: 1959,
              label: null,
              catalogNumber: null,
              barcode: null,
              confidence: 0.97,
              evidence: [],
              warnings: [],
            },
          },
        ],
        cost: {
          attemptCount: 1,
          totalInputTokens: 100,
          totalOutputTokens: 25,
          totalTokens: 125,
          estimatedCostUsd: 0.0009,
          averageDurationMs: 4200,
        },
      }).scans,
    ).toHaveLength(2);
  });
});
