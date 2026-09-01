"use client";

import { useClerk } from "@clerk/nextjs";
import { useState } from "react";

import { isProductionAuth } from "../auth-mode";

const CONFIRM_PHRASE = "delete my account";

export function AccountDataActions() {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const clerk = isProductionAuth ? useClerk() : null;

  async function exportData() {
    setExporting(true);
    setExportError(null);
    try {
      const response = await fetch("/api/v1/account/export");
      if (!response.ok) {
        const body = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(
          body.error?.message ?? "The export could not be created.",
        );
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "vinylhound-account-export.json";
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setExportError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
    } finally {
      setExporting(false);
    }
  }

  async function deleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch("/api/v1/account", { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json()) as {
          error?: { message?: string };
        };
        throw new Error(
          body.error?.message ?? "The account could not be deleted.",
        );
      }
      if (clerk) {
        await clerk.signOut({ redirectUrl: "/" });
      } else {
        window.location.assign("/");
      }
    } catch (caught) {
      setDeleteError(
        caught instanceof Error ? caught.message : "Something went wrong.",
      );
      setDeleting(false);
    }
  }

  return (
    <section className="settings-card settings-card--danger">
      <div className="settings-card__heading">
        <div>
          <h2>Your data</h2>
          <p>
            Export everything VinylHound has stored for you, or delete your
            account.
          </p>
        </div>
      </div>
      <div className="settings-actions">
        <button
          className="text-button"
          disabled={exporting}
          onClick={exportData}
          type="button"
        >
          {exporting ? "Preparing export…" : "Export my data"}
        </button>
      </div>
      {exportError ? (
        <p className="settings-card__error" role="alert">
          {exportError}
        </p>
      ) : null}

      {confirmOpen ? (
        <div className="settings-card__confirm">
          <p>
            This permanently deletes your account, scans, images, and library.
            Type <strong>{CONFIRM_PHRASE}</strong> to confirm.
          </p>
          <label>
            <span>Confirmation phrase</span>
            <input
              onChange={(event) => setConfirmText(event.target.value)}
              placeholder={CONFIRM_PHRASE}
              value={confirmText}
            />
          </label>
          <div className="settings-actions">
            <button
              className="text-button text-button--danger"
              disabled={deleting || confirmText.trim() !== CONFIRM_PHRASE}
              onClick={deleteAccount}
              type="button"
            >
              {deleting ? "Deleting…" : "Permanently delete my account"}
            </button>
            <button
              className="text-button"
              disabled={deleting}
              onClick={() => {
                setConfirmOpen(false);
                setConfirmText("");
                setDeleteError(null);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
          {deleteError ? (
            <p className="settings-card__error" role="alert">
              {deleteError}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="settings-actions">
          <button
            className="text-button text-button--danger"
            onClick={() => setConfirmOpen(true)}
            type="button"
          >
            Delete my account
          </button>
        </div>
      )}
    </section>
  );
}
