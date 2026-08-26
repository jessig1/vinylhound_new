import { describe, expect, it } from "vitest";

import type { AlbumCandidate } from "@vinylhound/contracts";

import { determineReviewOutcome } from "./review-policy.js";

function candidate(confidence: number, title = "Kind of Blue"): AlbumCandidate {
  return {
    artist: "Miles Davis",
    title,
    releaseYear: 1959,
    label: "Columbia",
    catalogNumber: null,
    barcode: null,
    confidence,
    evidence: ["Artist and title are visible on the cover"],
    warnings: [],
  };
}

describe("determineReviewOutcome", () => {
  it("leaves scans with no candidates unresolved", () => {
    expect(determineReviewOutcome([])).toEqual({
      status: "unresolved",
      reason: "no_candidates",
    });
  });

  it("requires review below the confidence threshold", () => {
    expect(determineReviewOutcome([candidate(0.8)])).toEqual({
      status: "needs_review",
      reason: "low_confidence",
    });
  });

  it("honors explicit provider review reasons", () => {
    expect(
      determineReviewOutcome(
        [candidate(0.99)],
        ["The pressing cannot be established from the front cover."],
      ),
    ).toEqual({
      status: "needs_review",
      reason: "provider_review_reason",
    });
  });

  it("requires review when the leading candidates are too close", () => {
    expect(
      determineReviewOutcome([candidate(0.97), candidate(0.9, "Blue Train")]),
    ).toEqual({
      status: "needs_review",
      reason: "ambiguous_candidates",
    });
  });

  it("accepts a high-confidence candidate with a clear lead", () => {
    expect(
      determineReviewOutcome([candidate(0.97), candidate(0.7, "Blue Train")]),
    ).toEqual({
      status: "identified",
      reason: "high_confidence_clear_lead",
    });
  });
});
