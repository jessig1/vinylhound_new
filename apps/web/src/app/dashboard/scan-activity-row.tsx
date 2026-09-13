"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  CancelScanResponseSchema,
  ConfirmScanResponseSchema,
  type LibraryList,
  parseResponse,
} from "@vinylhound/contracts";
import type { listScansForUser } from "@vinylhound/database";

import { CoverArt } from "../cover-art";
import { Icon } from "../ui";

export type ScanActivitySummary = Awaited<
  ReturnType<typeof listScansForUser>
>["summaries"][number];

const DISMISSIBLE_STATUSES = new Set([
  "identified",
  "needs_review",
  "unresolved",
  "failed",
]);

export function ScanActivityRow({ scan }: { scan: ScanActivitySummary }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = scan.topCandidate?.title ?? "Untitled scan";
  const href = scan.batchId
    ? `/scans/batch/${scan.batchId}`
    : `/scans/${scan.scanId}`;
  const canAct = !scan.confirmedList && DISMISSIBLE_STATUSES.has(scan.status);
  const canConfirm = canAct && scan.topCandidate;

  async function addToList(list: LibraryList) {
    if (!scan.topCandidate || pending) return;
    const candidate = scan.topCandidate;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/scans/${scan.scanId}/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `confirm-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          selectedCandidateId: candidate.id,
          artist: candidate.artist,
          title: candidate.title,
          releaseYear: candidate.releaseYear,
          label: candidate.label,
          catalogNumber: candidate.catalogNumber,
          barcode: candidate.barcode,
          list,
          notes: null,
        }),
      });
      const body = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "The match could not be saved.");
      }
      parseResponse(ConfirmScanResponseSchema, body);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The match could not be saved.",
      );
    } finally {
      setPending(false);
    }
  }

  async function dismiss() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/scans/${scan.scanId}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": `dismiss-${crypto.randomUUID()}` },
      });
      const body = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? "The scan could not be dismissed.",
        );
      }
      parseResponse(CancelScanResponseSchema, body);
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The scan could not be dismissed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="scan-activity-item" data-scan-id={scan.scanId}>
      <Link className="scan-row" href={href}>
        <CoverArt
          image={
            scan.thumbnailImageId
              ? { scanId: scan.scanId, imageId: scan.thumbnailImageId }
              : null
          }
          title={title}
          tone={toneFor(scan.scanId)}
        />
        <div className="scan-row__title">
          <h3>{title}</h3>
          <p>{scan.topCandidate?.artist ?? "No candidate yet"}</p>
        </div>
        <span className={`status ${statusTone(scan.status)}`}>
          {scan.status === "identified" ? (
            <Icon name="check" size={14} />
          ) : (
            <Icon name="clock" size={14} />
          )}
          {scan.status === "canceled" ? "Dismissed" : statusLabel(scan.status)}
        </span>
        <time dateTime={scan.createdAt}>
          {new Date(scan.createdAt).toLocaleDateString()}
        </time>
        <Icon name="chevronRight" size={18} />
      </Link>
      {scan.confirmedList ? (
        <p className="scan-activity-item__confirmed" role="status">
          <Icon name="check" size={14} /> Added to your {scan.confirmedList}
        </p>
      ) : canAct ? (
        <div className="scan-activity-item__actions">
          {canConfirm ? (
            <>
              <button
                className="text-button"
                disabled={pending}
                onClick={() => addToList("collection")}
                type="button"
              >
                <Icon name="collection" size={14} />
                {pending ? "Saving…" : "Add to collection"}
              </button>
              <button
                className="text-button"
                disabled={pending}
                onClick={() => addToList("wishlist")}
                type="button"
              >
                <Icon name="heart" size={14} /> Add to wishlist
              </button>
            </>
          ) : null}
          <button
            className="text-button text-button--danger"
            disabled={pending}
            onClick={dismiss}
            type="button"
          >
            {pending ? "Dismissing…" : "Dismiss"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function statusLabel(status: string) {
  switch (status) {
    case "awaiting_upload":
      return "Waiting for upload";
    case "queued":
      return "Queued";
    case "processing":
      return "Processing";
    case "identified":
      return "Matched";
    case "needs_review":
      return "Needs review";
    case "unresolved":
      return "No match";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    default:
      return status;
  }
}

function statusTone(status: string) {
  if (status === "identified") return "status--success";
  if (status === "failed" || status === "canceled") return "status--error";
  return "status--review";
}

const tones = [
  "blue",
  "cream",
  "sun",
  "crosswalk",
  "classroom",
  "chrome",
  "ocean",
  "green",
  "snow",
  "red",
  "rainbow",
  "water",
] as const;

function toneFor(id: string) {
  let value = 0;
  for (const character of id) value = (value + character.charCodeAt(0)) % 997;
  return tones[value % tones.length]!;
}
