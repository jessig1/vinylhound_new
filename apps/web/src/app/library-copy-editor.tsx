"use client";

import { useRouter } from "next/navigation";
import type { LibraryCopy } from "@vinylhound/contracts";

export function LibraryCopyEditor({
  itemId,
  copy,
}: {
  itemId: string;
  copy: LibraryCopy;
}) {
  const router = useRouter();
  async function save(form: FormData) {
    const value = (name: string) => (form.get(name) as string) || null;
    await fetch(`/api/v1/library/${itemId}/copies/${copy.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        location: value("location"),
        notes: value("notes"),
        acquiredAt: value("acquiredAt"),
      }),
    });
    router.refresh();
  }
  async function remove() {
    if (window.confirm("Delete this physical copy?")) {
      await fetch(`/api/v1/library/${itemId}/copies/${copy.id}`, {
        method: "DELETE",
      });
      router.refresh();
    }
  }
  return (
    <details className="copy-editor">
      <summary>Copy details</summary>
      <form action={save}>
        <label>
          Location <input defaultValue={copy.location ?? ""} name="location" />
        </label>
        <label>
          Acquired{" "}
          <input
            defaultValue={copy.acquiredAt ?? ""}
            name="acquiredAt"
            type="date"
          />
        </label>
        <label>
          Notes <textarea defaultValue={copy.notes ?? ""} name="notes" />
        </label>
        <button className="text-button" type="submit">
          Save copy
        </button>
        <button
          className="text-button text-button--danger"
          onClick={remove}
          type="button"
        >
          Delete copy
        </button>
      </form>
    </details>
  );
}
