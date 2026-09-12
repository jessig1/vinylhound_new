"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Icon } from "./ui";

/**
 * Marks or unmarks a saved record as a favorite through
 * `PATCH /library/{itemId}`. The server call is idempotent by identity, so a
 * double tap converges on whichever state the second tap asked for.
 */
export function FavoriteToggle({
  itemId,
  favoritedAt,
}: {
  itemId: string;
  favoritedAt: string | null;
}) {
  const router = useRouter();
  // Tracked locally so the button settles immediately rather than waiting
  // for the server refresh to bring the new state back.
  const [favorite, setFavorite] = useState(favoritedAt !== null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending) return;
    const next = !favorite;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/library/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ favorite: next }),
      });
      const body = (await response.json()) as {
        error?: { message?: string };
        favoritedAt?: string | null;
      };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? "The favorite could not be changed.",
        );
      }
      setFavorite(body.favoritedAt !== null && body.favoritedAt !== undefined);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="favorite-toggle">
      <button
        aria-pressed={favorite}
        className={
          favorite ? "secondary-button is-favorite" : "secondary-button"
        }
        disabled={pending}
        onClick={toggle}
        type="button"
      >
        <Icon name="star" size={17} />
        {pending
          ? "Saving…"
          : favorite
            ? "Remove from favorites"
            : "Add to favorites"}
      </button>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
