"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Records another copy of an owned record: a second pressing, or a copy
 * again after the last one was removed (ADR-0024). One idempotency key is
 * held for the whole attempt — a retry after a dropped connection replays
 * against the same key and gets the copy already recorded, never a second
 * one — and a fresh key is drawn only once the server has answered.
 */
export function AddLibraryCopy({
  itemId,
  copyCount,
}: {
  itemId: string;
  copyCount: number;
}) {
  const router = useRouter();
  const keyRef = useRef<string | null>(null);
  const [pending, setPending] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = pending || refreshing;

  async function add() {
    if (busy) return;
    setPending(true);
    setError(null);
    setAdded(false);
    keyRef.current ??= `copy-${crypto.randomUUID()}`;
    try {
      const response = await fetch(`/api/v1/library/${itemId}/copies`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": keyRef.current,
        },
        body: JSON.stringify({}),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "The copy could not be added.");
      }
      keyRef.current = null;
      setAdded(true);
      startRefresh(() => router.refresh());
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="copy-add">
      <div className="copy-editor__actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={add}
          type="button"
        >
          {busy
            ? "Adding…"
            : copyCount === 0
              ? "Add a copy"
              : "Add another copy"}
        </button>
        <span aria-live="polite" className="notes-editor__status">
          {added && !busy ? "Copy added." : ""}
        </span>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
