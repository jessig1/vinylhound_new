"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LibraryNotesEditor({
  itemId,
  notes,
}: {
  itemId: string;
  notes: string | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(notes ?? "");
  // Tracked locally rather than read from the prop so the saved state settles
  // immediately, instead of waiting for the server refresh to bring it back.
  const [baseline, setBaseline] = useState(notes ?? "");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = draft.trim() !== baseline.trim();

  async function save() {
    if (pending || !changed) return;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch(`/api/v1/library/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notes: draft.trim() ? draft.trim() : null }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? "Your notes could not be saved.",
        );
      }
      setBaseline(draft.trim());
      setSaved(true);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Your notes could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="notes-editor">
      <label className="field field--wide">
        <span className="visually-hidden">Notes about this record</span>
        <textarea
          maxLength={2_000}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
          placeholder="Where you found it, what to look for in a better pressing, who you lent it to…"
          rows={3}
          value={draft}
        />
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="notes-editor__actions">
        <button
          className="secondary-button"
          disabled={pending || !changed}
          onClick={save}
          type="button"
        >
          {pending ? "Saving…" : "Save notes"}
        </button>
        <span aria-live="polite" className="notes-editor__status">
          {saved && !changed ? "Notes saved." : ""}
        </span>
      </div>
    </div>
  );
}
