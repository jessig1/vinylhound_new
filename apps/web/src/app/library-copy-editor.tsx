"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  LibraryCopySchema,
  parseResponse,
  type LibraryCopy,
  type RecordCondition,
} from "@vinylhound/contracts";

const CONDITIONS: Array<{ value: RecordCondition; label: string }> = [
  { value: "mint", label: "Mint" },
  { value: "near_mint", label: "Near Mint" },
  { value: "very_good_plus", label: "Very Good Plus" },
  { value: "very_good", label: "Very Good" },
  { value: "good_plus", label: "Good Plus" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "poor", label: "Poor" },
];

type Draft = {
  mediaCondition: string;
  sleeveCondition: string;
  location: string;
  acquiredAt: string;
  notes: string;
};

function draftFromCopy(copy: LibraryCopy): Draft {
  return {
    mediaCondition: copy.mediaCondition ?? "",
    sleeveCondition: copy.sleeveCondition ?? "",
    location: copy.location ?? "",
    acquiredAt: copy.acquiredAt ?? "",
    notes: copy.notes ?? "",
  };
}

/**
 * Edits and removes one physical copy. Saving is idempotent by identity, so
 * a repeated save is harmless; the draft settles on what the server kept
 * (trimmed text, nulls for blanks) rather than what was typed. Removing the
 * last copy is allowed and says what follows: the record stays in the
 * collection with no copies until the user moves or removes it (ADR-0024).
 */
export function LibraryCopyEditor({
  itemId,
  copy,
  index,
  copyCount,
}: {
  itemId: string;
  copy: LibraryCopy;
  index: number;
  copyCount: number;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftFromCopy(copy));
  const [pending, setPending] = useState<"PATCH" | "DELETE" | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [saved, setSaved] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastCopy = copyCount === 1;
  const busy = pending !== null || refreshing || removed;

  function edit(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  async function request(method: "PATCH" | "DELETE", body?: unknown) {
    if (busy) return;
    setPending(method);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch(
        `/api/v1/library/${itemId}/copies/${copy.id}`,
        {
          method,
          ...(body === undefined
            ? {}
            : {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }),
        },
      );
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          payload.error?.message ??
            (method === "DELETE"
              ? "This copy could not be removed."
              : "This copy could not be saved."),
        );
      }
      if (method === "PATCH") {
        setDraft(draftFromCopy(parseResponse(LibraryCopySchema, payload)));
        setSaved(true);
      } else {
        // The editor leaves the page with the refresh; until then it reads
        // as removed rather than re-enabling a copy that no longer exists.
        setRemoved(true);
      }
      startRefresh(() => router.refresh());
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setPending(null);
    }
  }

  const summary = [
    draft.mediaCondition
      ? `Media ${conditionLabel(draft.mediaCondition)}`
      : null,
    draft.location || null,
    draft.acquiredAt ? `Acquired ${draft.acquiredAt}` : null,
  ].filter(Boolean);

  return (
    <details className="copy-editor">
      <summary>
        <strong>Copy {index}</strong>
        <small>{summary.length ? summary.join(" · ") : "No details yet"}</small>
      </summary>

      <div className="copy-editor__fields">
        <label className="field">
          <span>Media condition</span>
          <select
            onChange={(event) => edit({ mediaCondition: event.target.value })}
            value={draft.mediaCondition}
          >
            <option value="">Not graded</option>
            {CONDITIONS.map((condition) => (
              <option key={condition.value} value={condition.value}>
                {condition.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Sleeve condition</span>
          <select
            onChange={(event) => edit({ sleeveCondition: event.target.value })}
            value={draft.sleeveCondition}
          >
            <option value="">Not graded</option>
            {CONDITIONS.map((condition) => (
              <option key={condition.value} value={condition.value}>
                {condition.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Storage location</span>
          <input
            onChange={(event) => edit({ location: event.target.value })}
            placeholder="Shelf A"
            value={draft.location}
          />
        </label>
        <label className="field">
          <span>Acquired on</span>
          <input
            onChange={(event) => edit({ acquiredAt: event.target.value })}
            type="date"
            value={draft.acquiredAt}
          />
        </label>
        <label className="field field--wide">
          <span>Copy notes</span>
          <textarea
            maxLength={2_000}
            onChange={(event) => edit({ notes: event.target.value })}
            placeholder="Ring wear, insert included, pressing quirks…"
            rows={2}
            value={draft.notes}
          />
        </label>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {confirmingDelete && !removed ? (
        <div className="library-item-actions__confirm copy-editor__confirm">
          <p>
            {lastCopy
              ? "This is the only copy recorded. Removing it keeps the record in your collection with no copies; move it to your wishlist or remove it below if you no longer own it."
              : `Remove copy ${index}? Its condition, location, and notes are deleted with it.`}
          </p>
          <div className="library-item-actions__buttons">
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => request("DELETE")}
              type="button"
            >
              {pending === "DELETE" ? "Removing…" : `Yes, remove copy ${index}`}
            </button>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setConfirmingDelete(false)}
              type="button"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : null}

      <div className="copy-editor__actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() =>
            request("PATCH", {
              mediaCondition: draft.mediaCondition || null,
              sleeveCondition: draft.sleeveCondition || null,
              location: draft.location.trim() || null,
              acquiredAt: draft.acquiredAt || null,
              notes: draft.notes.trim() || null,
            })
          }
          type="button"
        >
          {pending === "PATCH" ? "Saving…" : "Save copy"}
        </button>
        {confirmingDelete ? null : (
          <button
            className="text-button text-button--danger"
            disabled={busy}
            onClick={() => setConfirmingDelete(true)}
            type="button"
          >
            Remove copy
          </button>
        )}
        <span aria-live="polite" className="notes-editor__status">
          {removed ? "Copy removed." : saved ? "Copy saved." : ""}
        </span>
      </div>
    </details>
  );
}

function conditionLabel(value: string) {
  return (
    CONDITIONS.find((condition) => condition.value === value)?.label ?? value
  );
}
