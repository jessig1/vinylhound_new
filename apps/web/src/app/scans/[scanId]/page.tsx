"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import {
  ConfirmScanRequestSchema,
  ConfirmScanResponseSchema,
  GetScanResponseSchema,
  type GetScanResponse,
  type ScanCandidateResult,
} from "@vinylhound/contracts";

import { Icon } from "../../ui";

type Draft = {
  artist: string;
  title: string;
  releaseYear: string;
  label: string;
  catalogNumber: string;
  barcode: string;
  list: "collection" | "wishlist";
  notes: string;
};

const emptyDraft: Draft = {
  artist: "",
  title: "",
  releaseYear: "",
  label: "",
  catalogNumber: "",
  barcode: "",
  list: "collection",
  notes: "",
};

export default function ScanResultPage() {
  const { scanId } = useParams<{ scanId: string }>();
  const confirmationKey = useRef(`confirm-${crypto.randomUUID()}`);
  const draftInitialized = useRef(false);
  const [scan, setScan] = useState<GetScanResponse | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<
    string | null | undefined
  >(undefined);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const response = await fetch(`/api/v1/scans/${scanId}`, {
          cache: "no-store",
        });
        const body = (await response.json()) as {
          error?: { message?: string };
        };
        if (!response.ok) {
          throw new Error(
            body.error?.message ?? "The scan could not be loaded.",
          );
        }
        const nextScan = GetScanResponseSchema.parse(body);
        if (cancelled) return;
        setScan(nextScan);
        setLoadingError(null);
        if (!draftInitialized.current) {
          const first = nextScan.candidates[0];
          setDraft(first ? draftFromCandidate(first) : emptyDraft);
          setSelectedCandidateId(first?.id ?? null);
          draftInitialized.current = true;
        }
        if (nextScan.status === "queued" || nextScan.status === "processing") {
          timer = setTimeout(poll, 2_000);
        }
      } catch (caught) {
        if (cancelled) return;
        setLoadingError(
          caught instanceof Error
            ? caught.message
            : "The scan could not be loaded.",
        );
        timer = setTimeout(poll, 4_000);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [scanId]);

  function selectCandidate(candidate: ScanCandidateResult) {
    setSelectedCandidateId(candidate.id);
    setDraft((current) => ({
      ...draftFromCandidate(candidate),
      list: current.list,
      notes: current.notes,
    }));
    setSubmitError(null);
  }

  function enterManually() {
    setSelectedCandidateId(null);
    setDraft((current) => ({
      ...emptyDraft,
      list: current.list,
      notes: current.notes,
    }));
    setSubmitError(null);
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!scan || submitting) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      const confirmation = ConfirmScanRequestSchema.parse({
        selectedCandidateId: selectedCandidateId ?? null,
        artist: draft.artist,
        title: draft.title,
        releaseYear: draft.releaseYear ? Number(draft.releaseYear) : null,
        label: optional(draft.label),
        catalogNumber: optional(draft.catalogNumber),
        barcode: optional(draft.barcode),
        list: draft.list,
        notes: optional(draft.notes),
      });
      const response = await fetch(`/api/v1/scans/${scan.scanId}/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": confirmationKey.current,
        },
        body: JSON.stringify(confirmation),
      });
      const body = (await response.json()) as {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(
          body.error?.message ?? "The confirmation could not be saved.",
        );
      }
      const saved = ConfirmScanResponseSchema.parse(body);
      setScan({
        ...scan,
        confirmation: {
          selectedCandidateId: saved.selectedCandidateId,
          release: saved.release,
          libraryItem: saved.libraryItem,
          confirmedAt: saved.confirmedAt,
        },
      });
    } catch (caught) {
      setSubmitError(
        caught instanceof Error
          ? caught.message
          : "The confirmation could not be saved.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!scan && !loadingError) return <LoadingState title="Loading scan…" />;
  if (!scan && loadingError) {
    return (
      <MessageState
        title="We couldn't load this scan."
        message={loadingError}
        action="Try another scan"
      />
    );
  }
  if (!scan) return null;

  if (scan.confirmation) {
    const confirmation = scan.confirmation;
    return (
      <main className="content-page scan-result-page">
        <section className="result-success-card">
          <span className="result-success-card__icon">
            <Icon name="check" size={28} />
          </span>
          <p className="section-kicker">Saved</p>
          <h1>{confirmation.release.title}</h1>
          <p className="result-artist">{confirmation.release.artist}</p>
          <p>
            Added to your {confirmation.libraryItem.list}. The reviewed details,
            selected candidate, and model audit trail remain linked to this
            scan.
          </p>
          <div className="button-row">
            <Link
              className="primary-button"
              href={`/${confirmation.libraryItem.list}`}
            >
              View {confirmation.libraryItem.list}
            </Link>
            <Link className="secondary-button" href="/scan">
              Scan another
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (scan.status === "queued" || scan.status === "processing") {
    return (
      <LoadingState
        title={
          scan.status === "queued"
            ? "Your scan is queued."
            : "Reading the cover…"
        }
        message={`Analyzing ${scan.images.length} labeled ${scan.images.length === 1 ? "view" : "views"}. You can leave this page and return from the same link.`}
      />
    );
  }
  if (scan.status === "awaiting_upload") {
    return (
      <MessageState
        title="This scan is waiting for an image."
        message="Start a new scan to choose and upload a cover photo."
        action="Choose a photo"
      />
    );
  }
  if (scan.status === "failed") {
    return (
      <MessageState
        title="We couldn't identify this image."
        message={
          scan.attempt?.error?.message ??
          "The scan failed before a reviewable result was produced."
        }
        action="Try another photo"
      />
    );
  }

  return (
    <main className="content-page scan-result-page">
      <header className="page-heading scan-result-heading">
        <div>
          <p className="section-kicker">
            {scan.status === "identified" ? "Strong match" : "Review needed"}
          </p>
          <h1>Check the match.</h1>
          <p>
            Confirm the album, correct anything that is off, then choose where
            to save it. This result combined {scan.images.length} labeled{" "}
            {scan.images.length === 1 ? "view" : "views"}.
          </p>
        </div>
        <StatusBadge status={scan.status} />
      </header>

      {scan.attempt?.needsReviewReasons.length ? (
        <aside className="scan-tip scan-tip--result">
          <Icon name="info" size={20} />
          <div>
            <strong>Why this needs your review</strong>
            <p>{scan.attempt.needsReviewReasons.join(" ")}</p>
          </div>
        </aside>
      ) : null}

      <div className="review-layout">
        <section className="candidate-panel">
          <div className="review-section-heading">
            <div>
              <p className="section-kicker">Candidates</p>
              <h2>
                {scan.candidates.length ? "Possible matches" : "No match found"}
              </h2>
            </div>
            {scan.candidates.length ? (
              <button
                className="text-button"
                onClick={enterManually}
                type="button"
              >
                Enter manually
              </button>
            ) : null}
          </div>
          {scan.candidates.length ? (
            <div className="candidate-list">
              {scan.candidates.map((candidate) => (
                <button
                  className={`candidate-card${
                    selectedCandidateId === candidate.id ? " is-selected" : ""
                  }`}
                  key={candidate.id}
                  onClick={() => selectCandidate(candidate)}
                  type="button"
                >
                  <span className="candidate-card__rank">{candidate.rank}</span>
                  <span>
                    <strong>{candidate.title}</strong>
                    <small>
                      {candidate.artist}
                      {candidate.releaseYear
                        ? ` · ${candidate.releaseYear}`
                        : ""}
                    </small>
                  </span>
                  <span className="candidate-card__confidence">
                    {Math.round(candidate.confidence * 100)}%
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="empty-candidate-copy">
              The image did not produce a reliable candidate. You can still
              enter the album details yourself and keep the scan&apos;s audit
              trail.
            </p>
          )}

          {selectedCandidateId ? (
            <CandidateEvidence
              candidate={scan.candidates.find(
                (candidate) => candidate.id === selectedCandidateId,
              )}
            />
          ) : null}
        </section>

        <form className="review-form" onSubmit={confirm}>
          <div className="review-section-heading">
            <div>
              <p className="section-kicker">Your confirmation</p>
              <h2>Release details</h2>
            </div>
          </div>
          <div className="review-fields">
            <label className="field field--wide">
              <span>Artist</span>
              <input
                onChange={(event) =>
                  setDraft({ ...draft, artist: event.target.value })
                }
                required
                value={draft.artist}
              />
            </label>
            <label className="field field--wide">
              <span>Album title</span>
              <input
                onChange={(event) =>
                  setDraft({ ...draft, title: event.target.value })
                }
                required
                value={draft.title}
              />
            </label>
            <label className="field">
              <span>Release year</span>
              <input
                inputMode="numeric"
                max="2200"
                min="1900"
                onChange={(event) =>
                  setDraft({ ...draft, releaseYear: event.target.value })
                }
                type="number"
                value={draft.releaseYear}
              />
            </label>
            <label className="field">
              <span>Label</span>
              <input
                onChange={(event) =>
                  setDraft({ ...draft, label: event.target.value })
                }
                value={draft.label}
              />
            </label>
            <label className="field">
              <span>Catalog number</span>
              <input
                onChange={(event) =>
                  setDraft({ ...draft, catalogNumber: event.target.value })
                }
                value={draft.catalogNumber}
              />
            </label>
            <label className="field">
              <span>Barcode</span>
              <input
                inputMode="numeric"
                onChange={(event) =>
                  setDraft({ ...draft, barcode: event.target.value })
                }
                value={draft.barcode}
              />
            </label>
          </div>

          <fieldset className="list-choice">
            <legend>Save to</legend>
            <label className={draft.list === "collection" ? "is-selected" : ""}>
              <input
                checked={draft.list === "collection"}
                name="list"
                onChange={() => setDraft({ ...draft, list: "collection" })}
                type="radio"
              />
              <Icon name="collection" size={20} />
              <span>
                <strong>Collection</strong>
                <small>I own this record</small>
              </span>
            </label>
            <label className={draft.list === "wishlist" ? "is-selected" : ""}>
              <input
                checked={draft.list === "wishlist"}
                name="list"
                onChange={() => setDraft({ ...draft, list: "wishlist" })}
                type="radio"
              />
              <Icon name="heart" size={20} />
              <span>
                <strong>Wishlist</strong>
                <small>I want to find a copy</small>
              </span>
            </label>
          </fieldset>

          <label className="field field--wide">
            <span>Notes (optional)</span>
            <textarea
              maxLength={2_000}
              onChange={(event) =>
                setDraft({ ...draft, notes: event.target.value })
              }
              rows={3}
              value={draft.notes}
            />
          </label>
          <p className="pressing-note">
            <Icon name="info" size={16} /> Only keep edition details you can
            verify from the record. The cover alone may identify the album, not
            the pressing.
          </p>
          {submitError ? (
            <p className="form-error" role="alert">
              {submitError}
            </p>
          ) : null}
          <button
            className="primary-button confirm-button"
            disabled={submitting}
          >
            <Icon name="check" size={18} />
            {submitting ? "Saving…" : `Confirm and add to ${draft.list}`}
          </button>
        </form>
      </div>
    </main>
  );
}

function CandidateEvidence({ candidate }: { candidate?: ScanCandidateResult }) {
  if (
    !candidate ||
    (!candidate.evidence.length && !candidate.warnings.length)
  ) {
    return null;
  }
  return (
    <div className="candidate-evidence">
      {candidate.evidence.length ? (
        <div>
          <strong>Evidence</strong>
          <ul>
            {candidate.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {candidate.warnings.length ? (
        <div>
          <strong>Watch for</strong>
          <ul>
            {candidate.warnings.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: GetScanResponse["status"] }) {
  return (
    <span
      className={`status ${
        status === "identified" ? "status--success" : "status--review"
      }`}
    >
      {status === "identified" ? "High confidence" : "Needs review"}
    </span>
  );
}

function LoadingState({
  title,
  message = "Fetching the latest status…",
}: {
  title: string;
  message?: string;
}) {
  return (
    <main className="content-page scan-result-page">
      <section className="scan-state-card" aria-live="polite">
        <span className="scan-spinner" />
        <p className="section-kicker">Scan in progress</p>
        <h1>{title}</h1>
        <p>{message}</p>
      </section>
    </main>
  );
}

function MessageState({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action: string;
}) {
  return (
    <main className="content-page scan-result-page">
      <section className="scan-state-card">
        <span className="upload-card__icon">
          <Icon name="info" size={26} />
        </span>
        <h1>{title}</h1>
        <p>{message}</p>
        <Link className="primary-button" href="/scan">
          {action}
        </Link>
      </section>
    </main>
  );
}

function draftFromCandidate(candidate: ScanCandidateResult): Draft {
  return {
    artist: candidate.artist,
    title: candidate.title,
    releaseYear: candidate.releaseYear?.toString() ?? "",
    label: candidate.label ?? "",
    catalogNumber: candidate.catalogNumber ?? "",
    barcode: candidate.barcode ?? "",
    list: "collection",
    notes: "",
  };
}

function optional(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
