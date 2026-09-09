"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { LibraryCopy, RecordCondition } from "@vinylhound/contracts";

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

export function LibraryCopyEditor({
  itemId,
  copy,
  index,
}: {
  itemId: string;
  copy: LibraryCopy;
  index: number;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftFromCopy(copy));
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function edit(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  async function request(method: "PATCH" | "DELETE", body?: unknown) {
    setPending(true);
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
      if (method === "PATCH") setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setPending(false);
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

      <div className="copy-editor__actions">
        <button
          className="secondary-button"
          disabled={pending}
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
          {pending ? "Saving…" : "Save copy"}
        </button>
        {confirmingDelete ? (
          <>
            <button
              className="text-button text-button--danger"
              disabled={pending}
              onClick={() => request("DELETE")}
              type="button"
            >
              Yes, remove copy {index}
            </button>
            <button
              className="text-button"
              disabled={pending}
              onClick={() => setConfirmingDelete(false)}
              type="button"
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            className="text-button text-button--danger"
            disabled={pending}
            onClick={() => setConfirmingDelete(true)}
            type="button"
          >
            Remove copy
          </button>
        )}
        <span aria-live="polite" className="notes-editor__status">
          {saved ? "Copy saved." : ""}
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
