/**
 * A favorite is an attribute of a user's saved relationship to a release
 * (their library item), not a third list beside collection and wishlist: a
 * record in either list can be a favorite, and removing the record removes
 * the favorite with it — nothing is favorited that is not saved.
 *
 * Favoriting is idempotent by identity. Marking an already favorited record
 * keeps the moment it was first favorited rather than resetting it, and
 * unmarking an unfavorited record changes nothing, so a repeated request
 * converges on the same state.
 */
export function resolveFavoritedAt(
  current: Date | null,
  favorite: boolean,
  now: Date,
): Date | null {
  if (!favorite) return null;
  return current ?? now;
}
