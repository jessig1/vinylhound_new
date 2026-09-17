import {
  MAX_LIBRARY_COPIES_PER_ITEM,
  type LibraryList,
} from "@vinylhound/contracts";

export type CopyAdditionOutcome =
  | { status: "allowed" }
  | { status: "rejected"; reason: "wishlist" | "capacity" };

/**
 * Copies are a collection record's inventory; the list is the user's
 * statement of intent (ADR-0024). A wishlist record wants the release and
 * owns nothing, so it cannot hold a copy — converting it to the collection
 * records the first one. A collection record holds as many copies as the
 * user owns pressings, up to the cap every list response embeds.
 *
 * Removal has no rule to resolve: any copy, including the last, can be
 * removed, and the record stays in whichever list it was in. A collection
 * record with no copies is one whose inventory was cleared, not one the
 * user stopped owning — that decision is the separate list change.
 */
export function resolveCopyAddition(
  list: LibraryList,
  copyCount: number,
): CopyAdditionOutcome {
  if (list === "wishlist") {
    return { status: "rejected", reason: "wishlist" };
  }
  if (copyCount >= MAX_LIBRARY_COPIES_PER_ITEM) {
    return { status: "rejected", reason: "capacity" };
  }
  return { status: "allowed" };
}
