"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

import {
  CancelScanResponseSchema,
  ConfirmScanResponseSchema,
  GetBatchResponseSchema,
  parseResponse,
  RetryScanResponseSchema,
  SignedImageReadSchema,
  type BatchScanSummary,
  type GetBatchResponse,
  type LibraryList,
} from "@vinylhound/contracts";

import { Icon } from "../../../ui";

const ACTIVE_STATUSES = new Set(["awaiting_upload", "queued", "processing"]);
const RETRYABLE_STATUSES = new Set(["failed", "unresolved"]);

export default function BatchProgressPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const failedToStartCount = Number(useSearchParams().get("failed") ?? 0);
  const [batch, setBatch] = useState<GetBatchResponse | null>(null);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [pendingItems, setPendingItems] = useState<Record<string, boolean>>({});
  const [confirmedItems, setConfirmedItems] = useState<
    Record<string, LibraryList>
  >({});
  const [pollVersion, setPollVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const response = await fetch(`/api/v1/batches/${batchId}`, {
          cache: "no-store",
        });
        const body = (await response.json()) as {
          error?: { message?: string };
        };
        if (!response.ok) {
          throw new Error(
            body.error?.message ?? "The batch could not be loaded.",
          );
        }
        const nextBatch = parseResponse(GetBatchResponseSchema, body);
        if (cancelled) return;
        setBatch(nextBatch);
        setLoadingError(null);
        if (nextBatch.scans.some((scan) => ACTIVE_STATUSES.has(scan.status))) {
          timer = setTimeout(poll, 2_000);
        }
      } catch (caught) {
        if (cancelled) return;
        setLoadingError(
          caught instanceof Error
            ? caught.message
            : "The batch could not be loaded.",
        );
        timer = setTimeout(poll, 4_000);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [batchId, pollVersion]);

  async function cancelItem(scanId: string) {
    if (pendingItems[scanId]) return;
    setPendingItems((current) => ({ ...current, [scanId]: true }));
    setItemErrors((current) => ({ ...current, [scanId]: "" }));
    try {
      const response = await fetch(`/api/v1/scans/${scanId}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": `cancel-${crypto.randomUUID()}` },
      });
      const body = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? "The scan could not be canceled.",
        );
      }
      parseResponse(CancelScanResponseSchema, body);
      setBatch((current) => updateScanStatus(current, scanId, "canceled"));
    } catch (caught) {
      setItemErrors((current) => ({
        ...current,
        [scanId]:
          caught instanceof Error
            ? caught.message
            : "The scan could not be canceled.",
      }));
    } finally {
      setPendingItems((current) => ({ ...current, [scanId]: false }));
    }
  }

  async function retryItem(scanId: string) {
    if (pendingItems[scanId]) return;
    setPendingItems((current) => ({ ...current, [scanId]: true }));
    setItemErrors((current) => ({ ...current, [scanId]: "" }));
    try {
      const response = await fetch(`/api/v1/scans/${scanId}/retry`, {
        method: "POST",
        headers: { "idempotency-key": `retry-${crypto.randomUUID()}` },
      });
      const body = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? "The retry could not be started.",
        );
      }
      parseResponse(RetryScanResponseSchema, body);
      setBatch((current) => updateScanStatus(current, scanId, "queued"));
      setPollVersion((current) => current + 1);
    } catch (caught) {
      setItemErrors((current) => ({
        ...current,
        [scanId]:
          caught instanceof Error
            ? caught.message
            : "The retry could not be started.",
      }));
    } finally {
      setPendingItems((current) => ({ ...current, [scanId]: false }));
    }
  }

  async function confirmItem(scan: BatchScanSummary, list: LibraryList) {
    if (!scan.topCandidate || pendingItems[scan.scanId]) return;
    const candidate = scan.topCandidate;
    setPendingItems((current) => ({ ...current, [scan.scanId]: true }));
    setItemErrors((current) => ({ ...current, [scan.scanId]: "" }));
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
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "The match could not be saved.");
      }
      parseResponse(ConfirmScanResponseSchema, body);
      setConfirmedItems((current) => ({ ...current, [scan.scanId]: list }));
    } catch (caught) {
      setItemErrors((current) => ({
        ...current,
        [scan.scanId]:
          caught instanceof Error
            ? caught.message
            : "The match could not be saved.",
      }));
    } finally {
      setPendingItems((current) => ({ ...current, [scan.scanId]: false }));
    }
  }

  if (!batch && !loadingError) {
    return (
      <main className="content-page scan-result-page">
        <section className="scan-state-card" aria-live="polite">
          <span className="scan-spinner" />
          <h1>Loading batch…</h1>
        </section>
      </main>
    );
  }
  if (!batch && loadingError) {
    return (
      <main className="content-page scan-result-page">
        <section className="scan-state-card">
          <span className="upload-card__icon">
            <Icon name="info" size={26} />
          </span>
          <h1>We couldn&apos;t load this batch.</h1>
          <p>{loadingError}</p>
          <Link className="primary-button" href="/scans">
            Back to scan history
          </Link>
        </section>
      </main>
    );
  }
  if (!batch) return null;

  const activeCount = batch.scans.filter((scan) =>
    ACTIVE_STATUSES.has(scan.status),
  ).length;

  return (
    <main className="content-page scan-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">Batch scan</p>
          <h1>
            {batch.scans.length}{" "}
            {batch.scans.length === 1 ? "record" : "records"}
          </h1>
          <p>
            {activeCount > 0
              ? `${activeCount} still processing. You can leave this page and return from the same link.`
              : "All records in this batch have finished."}
          </p>
        </div>
      </header>

      {failedToStartCount > 0 ? (
        <p className="form-error" role="alert">
          {failedToStartCount} {failedToStartCount === 1 ? "photo" : "photos"}{" "}
          could not be uploaded and {failedToStartCount === 1 ? "is" : "are"}{" "}
          not shown below. Go back to <Link href="/scan">start a new scan</Link>{" "}
          for the missing record{failedToStartCount === 1 ? "" : "s"}.
        </p>
      ) : null}

      {batch.cost.attemptCount > 0 ? (
        <p className="section-kicker">
          {formatCost(batch.cost.estimatedCostUsd)} estimated ·{" "}
          {batch.cost.totalTokens.toLocaleString()} tokens across{" "}
          {batch.cost.attemptCount}{" "}
          {batch.cost.attemptCount === 1 ? "attempt" : "attempts"}
        </p>
      ) : null}

      <section className="batch-scan-grid" aria-label="Scanned records">
        {batch.scans.map((scan) => (
          <BatchItemCard
            confirmedList={confirmedItems[scan.scanId]}
            error={itemErrors[scan.scanId]}
            key={scan.scanId}
            onCancel={() => cancelItem(scan.scanId)}
            onConfirm={(list) => confirmItem(scan, list)}
            onRetry={() => retryItem(scan.scanId)}
            pending={pendingItems[scan.scanId] ?? false}
            scan={scan}
          />
        ))}
      </section>
    </main>
  );
}

function BatchItemCard({
  scan,
  pending,
  confirmedList,
  error,
  onCancel,
  onConfirm,
  onRetry,
}: {
  scan: BatchScanSummary;
  pending: boolean;
  confirmedList?: LibraryList;
  error?: string;
  onCancel: () => void;
  onConfirm: (list: LibraryList) => void;
  onRetry: () => void;
}) {
  const canCancel = ACTIVE_STATUSES.has(scan.status);
  const canRetry = RETRYABLE_STATUSES.has(scan.status);
  const [showMismatchActions, setShowMismatchActions] = useState(false);
  const canConfirm =
    (scan.status === "identified" || scan.status === "needs_review") &&
    scan.topCandidate &&
    !confirmedList;

  return (
    <article className="batch-scan-card" data-scan-id={scan.scanId}>
      <BatchThumbnail imageId={scan.thumbnailImageId} scanId={scan.scanId} />
      <div className="batch-scan-card__body">
        <div className="batch-scan-card__heading">
          <span className={`status ${statusTone(scan.status)}`}>
            {statusLabel(scan.status)}
          </span>
          {scan.topCandidate ? (
            <div className="batch-scan-card__identity">
              <strong>{scan.topCandidate.title}</strong>
              <small>{scan.topCandidate.artist}</small>
              <CandidateFacts candidate={scan.topCandidate} />
            </div>
          ) : (
            <p className="batch-scan-card__waiting">Finding album details…</p>
          )}
        </div>
        {confirmedList ? (
          <p className="batch-scan-card__confirmed" role="status">
            <Icon name="check" size={16} /> Added to your {confirmedList}
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="batch-scan-card__actions">
          {canConfirm ? (
            <>
              <button
                className="primary-button"
                disabled={pending}
                onClick={() => onConfirm("collection")}
                type="button"
              >
                <Icon name="collection" size={16} />
                {pending ? "Saving…" : "Add to collection"}
              </button>
              <button
                className="secondary-button"
                disabled={pending}
                onClick={() => onConfirm("wishlist")}
                type="button"
              >
                <Icon name="heart" size={16} /> Add to wishlist
              </button>
              <button
                className="text-button batch-scan-card__mismatch"
                disabled={pending}
                onClick={() => setShowMismatchActions((current) => !current)}
                type="button"
              >
                This isn&apos;t a match
              </button>
            </>
          ) : null}
          {showMismatchActions ? (
            <div className="batch-scan-card__mismatch-actions">
              <Link className="secondary-button" href="/scan">
                Scan again
              </Link>
              <Link
                className="secondary-button"
                href={`/scans/${scan.scanId}?manual=1`}
              >
                Enter details manually
              </Link>
            </div>
          ) : null}
          {!canConfirm && !confirmedList ? (
            <Link className="text-button" href={`/scans/${scan.scanId}`}>
              View details
            </Link>
          ) : null}
          {canCancel ? (
            <button
              className="text-button"
              disabled={pending}
              onClick={onCancel}
              type="button"
            >
              {pending ? "Canceling…" : "Cancel"}
            </button>
          ) : null}
          {canRetry ? (
            <button
              className="text-button"
              disabled={pending}
              onClick={onRetry}
              type="button"
            >
              {pending ? "Retrying…" : "Retry"}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function CandidateFacts({
  candidate,
}: {
  candidate: NonNullable<BatchScanSummary["topCandidate"]>;
}) {
  const facts = [
    candidate.releaseYear ? `Released ${candidate.releaseYear}` : null,
    candidate.label,
    candidate.catalogNumber ? `Cat. ${candidate.catalogNumber}` : null,
  ].filter((fact): fact is string => Boolean(fact));

  if (!facts.length) return null;
  return (
    <p className="batch-scan-card__facts" aria-label="Potential match details">
      {facts.join(" · ")}
    </p>
  );
}

function BatchThumbnail({
  scanId,
  imageId,
}: {
  scanId: string;
  imageId: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!imageId) return;
    let cancelled = false;
    void fetch(`/api/v1/scans/${scanId}/images/${imageId}/thumbnail`, {
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Thumbnail unavailable");
        return parseResponse(SignedImageReadSchema, await response.json());
      })
      .then((image) => {
        if (!cancelled) setUrl(image.url);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [imageId, scanId]);

  if (!url) {
    return (
      <div className="batch-scan-card__art batch-scan-card__art--empty">
        <Icon name="collection" size={30} />
        <span>Cover preview</span>
      </div>
    );
  }
  return (
    <img
      alt="Scanned album cover"
      className="batch-scan-card__art"
      onError={() => setUrl(null)}
      src={url}
    />
  );
}

function statusLabel(status: BatchScanSummary["status"]) {
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
  }
}

function formatCost(estimatedCostUsd: number | null) {
  if (estimatedCostUsd === null) return "Cost unavailable";
  if (estimatedCostUsd < 0.01) return "<$0.01";
  return `$${estimatedCostUsd.toFixed(2)}`;
}

function statusTone(status: BatchScanSummary["status"]) {
  if (status === "identified") return "status--success";
  if (status === "failed" || status === "canceled") return "status--error";
  return "status--review";
}

function updateScanStatus(
  batch: GetBatchResponse | null,
  scanId: string,
  status: BatchScanSummary["status"],
): GetBatchResponse | null {
  if (!batch) return batch;
  return {
    ...batch,
    scans: batch.scans.map((scan) =>
      scan.scanId === scanId ? { ...scan, status } : scan,
    ),
  };
}
