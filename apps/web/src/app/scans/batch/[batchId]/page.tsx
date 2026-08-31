"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

import {
  CancelScanResponseSchema,
  GetBatchResponseSchema,
  RetryScanResponseSchema,
  type BatchScanSummary,
  type GetBatchResponse,
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
        const nextBatch = GetBatchResponseSchema.parse(body);
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
  }, [batchId]);

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
      CancelScanResponseSchema.parse(body);
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
      RetryScanResponseSchema.parse(body);
      setBatch((current) => updateScanStatus(current, scanId, "queued"));
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

      <section className="view-grid">
        {batch.scans.map((scan) => (
          <BatchItemCard
            error={itemErrors[scan.scanId]}
            key={scan.scanId}
            onCancel={() => cancelItem(scan.scanId)}
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
  error,
  onCancel,
  onRetry,
}: {
  scan: BatchScanSummary;
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const canCancel = ACTIVE_STATUSES.has(scan.status);
  const canRetry = RETRYABLE_STATUSES.has(scan.status);

  return (
    <article className="view-card">
      <div className="view-card__body">
        <span className={`status ${statusTone(scan.status)}`}>
          {statusLabel(scan.status)}
        </span>
        {scan.topCandidate ? (
          <div>
            <strong>{scan.topCandidate.title}</strong>
            <small>{scan.topCandidate.artist}</small>
          </div>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <Link className="text-button" href={`/scans/${scan.scanId}`}>
            {scan.status === "identified" || scan.status === "needs_review"
              ? "Review"
              : "View"}
          </Link>
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
