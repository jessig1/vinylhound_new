"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { LibraryList } from "@vinylhound/contracts";

import { Icon } from "./ui";

export function LibraryItemActions({
  itemId,
  list,
  copyCount,
  title,
}: {
  itemId: string;
  list: LibraryList;
  copyCount: number;
  title: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blockedByCopies = list === "collection" && copyCount > 0;

  async function moveTo(nextList: LibraryList) {
    if (pending) return;
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
        throw new Error(
          body.error?.message ?? "The record could not be moved.",
        );
      }
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
      setPending(false);
    }
  }

  async function remove() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/library/${itemId}`, {
        method: "DELETE",
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? "The record could not be removed.",
        );
      }
      router.push(`/${list}`);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
      setPending(false);
    }
  }

  return (
    <div className="library-item-actions">
      <div className="library-item-actions__buttons">
        {list === "wishlist" ? (
          <button
            className="primary-button"
            disabled={pending}
            onClick={() => moveTo("collection")}
            type="button"
          >
            <Icon name="collection" size={17} />
            {pending ? "Moving…" : "I own this now"}
          </button>
        ) : (
          <button
            className="secondary-button"
            disabled={pending || blockedByCopies}
            onClick={() => moveTo("wishlist")}
            title={
              blockedByCopies
                ? "Remove this record's copies before moving it back to the wishlist."
                : undefined
            }
            type="button"
          >
            <Icon name="heart" size={17} />
            {pending ? "Moving…" : "Move to wishlist"}
          </button>
        )}
      </div>

      {blockedByCopies ? (
        <p className="field-help">
          Moving this back to your wishlist means you no longer own it, so
          remove its {copyCount === 1 ? "copy" : "copies"} above first.
        </p>
      ) : null}

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {confirmingDelete ? (
        <div className="library-item-actions__confirm">
          <p>
            Remove <strong>{title}</strong> from your{" "}
            {list === "wishlist" ? "wishlist" : "collection"}? The scan it came
            from is kept, so you can save it again later.
          </p>
          <div className="library-item-actions__buttons">
            <button
              className="secondary-button"
              disabled={pending}
              onClick={remove}
              type="button"
            >
              {pending ? "Removing…" : "Yes, remove it"}
            </button>
            <button
              className="text-button"
              disabled={pending}
              onClick={() => setConfirmingDelete(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="text-button text-button--danger"
          disabled={pending}
          onClick={() => setConfirmingDelete(true)}
          type="button"
        >
          Remove from {list === "wishlist" ? "wishlist" : "collection"}
        </button>
      )}
    </div>
  );
}
