"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { LibraryList } from "@vinylhound/contracts";

export function LibraryItemActions({
  itemId,
  list,
  copyCount,
  hasConfirmationHistory,
}: {
  itemId: string;
  list: LibraryList;
  copyCount: number;
  hasConfirmationHistory: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function moveTo(nextList: LibraryList) {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/library/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ list: nextList }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "The item could not be moved.");
      }
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/library/${itemId}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? "The item could not be removed.",
        );
      }
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
    <div className="library-item-actions">
      <div className="library-item-actions__buttons">
        {list === "wishlist" ? (
          <button
            className="text-button"
            disabled={pending}
            onClick={() => moveTo("collection")}
            type="button"
          >
            Move to collection
          </button>
        ) : (
          <button
            className="text-button"
            disabled={pending || copyCount > 0}
            onClick={() => moveTo("wishlist")}
            title={
              copyCount > 0
                ? "Remove this item's copies before moving it to the wishlist."
                : undefined
            }
            type="button"
          >
            Move to wishlist
          </button>
        )}
        {hasConfirmationHistory ? null : (
          <button
            className="text-button text-button--danger"
            disabled={pending}
            onClick={remove}
            type="button"
          >
            Remove
          </button>
        )}
      </div>
      {error ? (
        <p className="library-item-actions__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
