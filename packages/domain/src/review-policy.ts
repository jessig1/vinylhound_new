import type { AlbumCandidate } from "@vinylhound/contracts";

export const AUTO_ACCEPT_CONFIDENCE = 0.93;
export const MINIMUM_CANDIDATE_LEAD = 0.12;

export type ReviewOutcome =
  | { status: "identified"; reason: "high_confidence_clear_lead" }
  | {
      status: "needs_review";
      reason:
        "provider_review_reason" | "low_confidence" | "ambiguous_candidates";
    }
  | { status: "unresolved"; reason: "no_candidates" };

export function determineReviewOutcome(
  candidates: readonly AlbumCandidate[],
  needsReviewReasons: readonly string[] = [],
): ReviewOutcome {
  const ranked = [...candidates].sort(
    (left, right) => right.confidence - left.confidence,
  );
  const [first, second] = ranked;

  if (!first) {
    return { status: "unresolved", reason: "no_candidates" };
  }

  if (needsReviewReasons.length > 0) {
    return { status: "needs_review", reason: "provider_review_reason" };
  }

  if (first.confidence < AUTO_ACCEPT_CONFIDENCE) {
    return { status: "needs_review", reason: "low_confidence" };
  }

  if (second && first.confidence - second.confidence < MINIMUM_CANDIDATE_LEAD) {
    return { status: "needs_review", reason: "ambiguous_candidates" };
  }

  return { status: "identified", reason: "high_confidence_clear_lead" };
}
