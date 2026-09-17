"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { LibraryList } from "@vinylhound/contracts";

import { Icon } from "./ui";

/**
 * List moves and removal. A move is idempotent by identity and settles when
 * the refreshed page arrives, so the buttons re-enable with the new list
 * rather than staying stuck on "Moving…"; removal leaves the page. Moving to
 * the wishlist stays behind removing every copy first (ADR-0011), which the
 * last-copy rule makes reachable (ADR-0024).
 */
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
  const [refreshing, startRefresh] = useTransition();
  const [moved, setMoved] = useState<LibraryList | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blockedByCopies = list === "collection" && copyCount > 0;
  const busy = pending || refreshing;

  async function moveTo(nextList: LibraryList) {
    if (busy) return;
    setPending(true);
    setError(null);
    setMoved(null);
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
      setMoved(nextList);
      startRefresh(() => router.refresh());
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (busy) return;
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
            disabled={busy}
            onClick={() => moveTo("collection")}
            type="button"
          >
            <Icon name="collection" size={17} />
            {busy && !confirmingDelete ? "Moving…" : "I own this now"}
          </button>
        ) : (
          <button
            className="secondary-button"
            disabled={busy || blockedByCopies}
            onClick={() => moveTo("wishlist")}
            title={
              blockedByCopies
                ? "Remove this record's copies before moving it back to the wishlist."
                : undefined
            }
            type="button"
          >
            <Icon name="heart" size={17} />
            {busy && !confirmingDelete ? "Moving…" : "Move to wishlist"}
          </button>
        )}
        <span aria-live="polite" className="notes-editor__status">
          {moved && !busy
            ? `Moved to your ${moved === "wishlist" ? "wishlist" : "collection"}.`
            : ""}
        </span>
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
              disabled={busy}
              onClick={remove}
              type="button"
            >
              {busy ? "Removing…" : "Yes, remove it"}
            </button>
            <button
              className="text-button"
              disabled={busy}
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
          disabled={busy}
          onClick={() => setConfirmingDelete(true)}
          type="button"
        >
          Remove from {list === "wishlist" ? "wishlist" : "collection"}
        </button>
      )}
    </div>
  );
}
