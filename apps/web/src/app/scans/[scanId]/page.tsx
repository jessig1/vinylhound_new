"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";

import {
  CancelScanResponseSchema,
  ConfirmScanRequestSchema,
  ConfirmScanResponseSchema,
  GetScanResponseSchema,
  parseResponse,
  RetryScanResponseSchema,
  SearchCatalogReleasesResponseSchema,
  type CatalogReference,
  type CatalogReleaseCandidate,
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
  releaseDate: string;
  country: string;
  format: string;
  packaging: string;
  releaseStatus: string;
  list: "collection" | "wishlist";
  notes: string;
  mediaCondition: string;
  sleeveCondition: string;
  location: string;
  copyNotes: string;
  acquiredAt: string;
};

const emptyDraft: Draft = {
  artist: "",
  title: "",
  releaseYear: "",
  label: "",
  catalogNumber: "",
  barcode: "",
  releaseDate: "",
  country: "",
  format: "",
  packaging: "",
  releaseStatus: "",
  list: "collection",
  notes: "",
  mediaCondition: "",
  sleeveCondition: "",
  location: "",
  copyNotes: "",
  acquiredAt: "",
};

export default function ScanResultPage() {
  const { scanId } = useParams<{ scanId: string }>();
  const startManually = useSearchParams().get("manual") === "1";
  const confirmationKey = useRef(`confirm-${crypto.randomUUID()}`);
  const draftInitialized = useRef(false);
  const artistInput = useRef<HTMLInputElement>(null);
  const successHeading = useRef<HTMLHeadingElement>(null);
  const [scan, setScan] = useState<GetScanResponse | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<
    string | null | undefined
  >(undefined);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [catalogReference, setCatalogReference] =
    useState<CatalogReference | null>(null);
  const [catalogResults, setCatalogResults] = useState<
    CatalogReleaseCandidate[]
  >([]);
  const [catalogPending, setCatalogPending] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogSearched, setCatalogSearched] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const confirmedAt = scan?.confirmation?.confirmedAt;

  useEffect(() => {
    if (confirmedAt) successHeading.current?.focus();
  }, [confirmedAt]);

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
        const nextScan = parseResponse(GetScanResponseSchema, body);
        if (cancelled) return;
        setScan(nextScan);
        setLoadingError(null);
        if (
          !draftInitialized.current &&
          nextScan.status !== "queued" &&
          nextScan.status !== "processing"
        ) {
          const first = nextScan.candidates[0];
          setDraft(
            startManually
              ? emptyDraft
              : first
                ? draftFromCandidate(first)
                : emptyDraft,
          );
          setSelectedCandidateId(startManually ? null : (first?.id ?? null));
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
  }, [scanId, pollVersion, startManually]);

  useEffect(() => {
    if (startManually && draftInitialized.current) {
      artistInput.current?.focus();
    }
  }, [startManually, scan?.status]);

  function selectCandidate(candidate: ScanCandidateResult) {
    setSelectedCandidateId(candidate.id);
    setDraft((current) => ({
      ...draftFromCandidate(candidate),
      list: current.list,
      notes: current.notes,
    }));
    setSubmitError(null);
    setCatalogReference(null);
    setCatalogResults([]);
    setCatalogSearched(false);
  }

  function enterManually() {
    setSelectedCandidateId(null);
    setDraft((current) => ({
      ...emptyDraft,
      list: current.list,
      notes: current.notes,
    }));
    setSubmitError(null);
    setCatalogReference(null);
    setCatalogResults([]);
    setCatalogSearched(false);
    artistInput.current?.focus();
  }

  function editDraft(patch: Partial<Draft>, preserveCatalog = false) {
    setDraft((current) => ({ ...current, ...patch }));
    if (!preserveCatalog) setCatalogReference(null);
  }

  async function searchCatalog() {
    if (!draft.artist.trim() || !draft.title.trim() || catalogPending) return;
    setCatalogPending(true);
    setCatalogSearched(false);
    setCatalogResults([]);
    setCatalogError(null);
    try {
      const query = new URLSearchParams({
        artist: draft.artist,
        title: draft.title,
      });
      const response = await fetch(`/api/v1/catalog/releases?${query}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) {
        throw new Error(body.error?.message ?? "Catalog search failed.");
      }
      setCatalogResults(
        parseResponse(SearchCatalogReleasesResponseSchema, body).results,
      );
      setCatalogSearched(true);
    } catch (caught) {
      setCatalogError(
        caught instanceof Error ? caught.message : "Catalog search failed.",
      );
    } finally {
      setCatalogPending(false);
    }
  }

  function selectCatalogRelease(candidate: CatalogReleaseCandidate) {
    const firstLabel = candidate.labels[0];
    editDraft(
      {
        artist: candidate.artist,
        title: candidate.title,
        releaseYear: candidate.releaseDate?.slice(0, 4) ?? "",
        releaseDate: candidate.releaseDate ?? "",
        country: candidate.country ?? "",
        label: firstLabel?.name ?? "",
        catalogNumber: firstLabel?.catalogNumber ?? "",
        barcode: candidate.barcode ?? "",
        format: candidate.formats.join(", "),
        packaging: candidate.packaging ?? "",
        releaseStatus: candidate.status ?? "",
      },
      true,
    );
    setCatalogReference(candidate.reference);
    setCatalogError(null);
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
        releaseDate: optional(draft.releaseDate),
        country: optional(draft.country),
        format: optional(draft.format),
        packaging: optional(draft.packaging),
        releaseStatus: optional(draft.releaseStatus),
        catalogReference,
        list: draft.list,
        notes: optional(draft.notes),
        copy:
          draft.list === "collection"
            ? {
                mediaCondition: optional(draft.mediaCondition),
                sleeveCondition: optional(draft.sleeveCondition),
                location: optional(draft.location),
                notes: optional(draft.copyNotes),
                acquiredAt: optional(draft.acquiredAt),
              }
            : null,
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
      const saved = parseResponse(ConfirmScanResponseSchema, body);
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

  async function retry() {
    if (!scan || actionPending) return;
    setActionError(null);
    setActionPending(true);
    try {
      const response = await fetch(`/api/v1/scans/${scan.scanId}/retry`, {
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
      draftInitialized.current = false;
      setScan({ ...scan, status: "queued", attempt: null, candidates: [] });
      setPollVersion((current) => current + 1);
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "The retry could not be started.",
      );
    } finally {
      setActionPending(false);
    }
  }

  async function cancel() {
    if (!scan || actionPending) return;
    setActionError(null);
    setActionPending(true);
    try {
      const response = await fetch(`/api/v1/scans/${scan.scanId}/cancel`, {
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
      setScan({ ...scan, status: "canceled" });
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : "The scan could not be canceled.",
      );
    } finally {
      setActionPending(false);
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
          <h1 ref={successHeading} tabIndex={-1}>
            {confirmation.release.title}
          </h1>
          <p className="result-artist">{confirmation.release.artist}</p>
          <p>
            Added to your {confirmation.libraryItem.list}. You can find it there
            whenever you need it.
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
        error={actionError ?? loadingError}
        secondaryAction={{
          label: actionPending ? "Canceling…" : "Cancel scan",
          onClick: cancel,
          disabled: actionPending,
        }}
        batchId={scan.batchId}
      />
    );
  }
  if (scan.status === "awaiting_upload") {
    return (
      <MessageState
        title="This scan is waiting for an image."
        message="Start a new scan to choose and upload a cover photo."
        action="Choose a photo"
        batchId={scan.batchId}
      />
    );
  }
  if (scan.status === "canceled") {
    return (
      <MessageState
        title="This scan was canceled."
        message="No result was saved. Start a new scan to identify this record."
        action="Start a new scan"
        batchId={scan.batchId}
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
        error={actionError}
        secondaryAction={{
          label: actionPending ? "Retrying…" : "Retry this scan",
          onClick: retry,
          disabled: actionPending,
        }}
        batchId={scan.batchId}
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
          {scan.batchId ? <BatchLink batchId={scan.batchId} /> : null}
        </div>
        <StatusBadge status={scan.status} />
      </header>

      {scan.status === "unresolved" ? (
        <aside className="scan-tip scan-tip--result">
          <Icon name="info" size={20} />
          <div>
            <strong>No confident match was found</strong>
            <p>
              Enter the album details yourself below, or{" "}
              <button
                className="text-button"
                disabled={actionPending}
                onClick={retry}
                type="button"
              >
                {actionPending ? "retrying…" : "retry this scan"}
              </button>
              .
            </p>
            {actionError ? (
              <p className="form-error" role="alert">
                {actionError}
              </p>
            ) : null}
          </div>
        </aside>
      ) : null}

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
                  aria-pressed={selectedCandidateId === candidate.id}
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
                    {selectedCandidateId === candidate.id ? (
                      <span>
                        Selected
                        <br />
                      </span>
                    ) : null}
                    {Math.round(candidate.confidence * 100)}%
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="empty-candidate-copy">
              The image did not produce a reliable candidate. You can still
              enter the artist and album title yourself below.
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
            <button
              className="text-button"
              disabled={catalogPending || !draft.artist || !draft.title}
              onClick={searchCatalog}
              type="button"
            >
              {catalogPending ? "Searching…" : "Search MusicBrainz"}
            </button>
          </div>
          <p className="field-help">
            Check the artist and album title, then choose where to save. All
            other details are optional.
          </p>
          <p className="field-help" role="status">
            {catalogPending
              ? "Searching the catalog…"
              : catalogSearched
                ? catalogResults.length
                  ? `${catalogResults.length} catalog releases found. Check the edition before selecting one.`
                  : "No catalog releases found. You can edit the artist or title and search again, or save the details below."
                : ""}
          </p>
          {catalogError ? (
            <p className="form-error" role="alert">
              {catalogError}
            </p>
          ) : null}
          {catalogResults.length ? (
            <div className="candidate-list" aria-label="Catalog releases">
              {catalogResults.map((candidate) => (
                <button
                  className={`candidate-card candidate-card--catalog${
                    catalogReference?.releaseId ===
                    candidate.reference.releaseId
                      ? " is-selected"
                      : ""
                  }`}
                  key={candidate.reference.releaseId}
                  aria-pressed={
                    catalogReference?.releaseId ===
                    candidate.reference.releaseId
                  }
                  onClick={() => selectCatalogRelease(candidate)}
                  type="button"
                >
                  <span>
                    <strong>{candidate.title}</strong>
                    <small>
                      {[
                        candidate.artist,
                        candidate.releaseDate,
                        candidate.country,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </span>
                  <span className="candidate-card__confidence">
                    {candidate.score}%
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="review-fields">
            <label className="field field--wide">
              <span>Artist</span>
              <input
                ref={artistInput}
                onChange={(event) => editDraft({ artist: event.target.value })}
                required
                value={draft.artist}
              />
            </label>
            <label className="field field--wide">
              <span>Album title</span>
              <input
                onChange={(event) => editDraft({ title: event.target.value })}
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
                  editDraft({ releaseYear: event.target.value })
                }
                type="number"
                value={draft.releaseYear}
              />
            </label>
            <label className="field">
              <span>Label</span>
              <input
                onChange={(event) => editDraft({ label: event.target.value })}
                value={draft.label}
              />
            </label>
            <label className="field">
              <span>Catalog number</span>
              <input
                onChange={(event) =>
                  editDraft({ catalogNumber: event.target.value })
                }
                value={draft.catalogNumber}
              />
            </label>
            <label className="field">
              <span>Barcode</span>
              <input
                inputMode="numeric"
                onChange={(event) => editDraft({ barcode: event.target.value })}
                value={draft.barcode}
              />
            </label>
            <label className="field">
              <span>Release date</span>
              <input
                onChange={(event) =>
                  editDraft({ releaseDate: event.target.value })
                }
                placeholder="YYYY, YYYY-MM, or YYYY-MM-DD"
                value={draft.releaseDate}
              />
            </label>
            <label className="field">
              <span>Country</span>
              <input
                onChange={(event) => editDraft({ country: event.target.value })}
                value={draft.country}
              />
            </label>
            <label className="field">
              <span>Format</span>
              <input
                onChange={(event) => editDraft({ format: event.target.value })}
                value={draft.format}
              />
            </label>
            <label className="field">
              <span>Packaging</span>
              <input
                onChange={(event) =>
                  editDraft({ packaging: event.target.value })
                }
                value={draft.packaging}
              />
            </label>
            <label className="field">
              <span>Release status</span>
              <input
                onChange={(event) =>
                  editDraft({ releaseStatus: event.target.value })
                }
                value={draft.releaseStatus}
              />
            </label>
          </div>

          <fieldset className="list-choice">
            <legend>Save to</legend>
            <label className={draft.list === "collection" ? "is-selected" : ""}>
              <input
                checked={draft.list === "collection"}
                name="list"
                onChange={() => editDraft({ list: "collection" }, true)}
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
                onChange={() => editDraft({ list: "wishlist" }, true)}
                type="radio"
              />
              <Icon name="heart" size={20} />
              <span>
                <strong>Wishlist</strong>
                <small>I want to find a copy</small>
              </span>
            </label>
          </fieldset>

          {draft.list === "collection" ? (
            <details className="optional-details">
              <summary>Copy details (optional)</summary>
              <div className="review-fields">
                <label className="field">
                  <span>Media condition</span>
                  <ConditionSelect
                    onChange={(value) =>
                      editDraft({ mediaCondition: value }, true)
                    }
                    value={draft.mediaCondition}
                  />
                </label>
                <label className="field">
                  <span>Sleeve condition</span>
                  <ConditionSelect
                    onChange={(value) =>
                      editDraft({ sleeveCondition: value }, true)
                    }
                    value={draft.sleeveCondition}
                  />
                </label>
                <label className="field">
                  <span>Storage location</span>
                  <input
                    onChange={(event) =>
                      editDraft({ location: event.target.value }, true)
                    }
                    value={draft.location}
                  />
                </label>
                <label className="field">
                  <span>Acquired on</span>
                  <input
                    onChange={(event) =>
                      editDraft({ acquiredAt: event.target.value }, true)
                    }
                    type="date"
                    value={draft.acquiredAt}
                  />
                </label>
                <label className="field field--wide">
                  <span>Copy notes</span>
                  <textarea
                    maxLength={2_000}
                    onChange={(event) =>
                      editDraft({ copyNotes: event.target.value }, true)
                    }
                    rows={2}
                    value={draft.copyNotes}
                  />
                </label>
              </div>
            </details>
          ) : null}

          <label className="field field--wide">
            <span>Notes (optional)</span>
            <textarea
              maxLength={2_000}
              onChange={(event) =>
                editDraft({ notes: event.target.value }, true)
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

function ConditionSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select onChange={(event) => onChange(event.target.value)} value={value}>
      <option value="">Not graded</option>
      <option value="mint">Mint</option>
      <option value="near_mint">Near Mint</option>
      <option value="very_good_plus">Very Good Plus</option>
      <option value="very_good">Very Good</option>
      <option value="good_plus">Good Plus</option>
      <option value="good">Good</option>
      <option value="fair">Fair</option>
      <option value="poor">Poor</option>
    </select>
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

type SecondaryAction = {
  label: string;
  onClick: () => void;
  disabled?: boolean;
};

function LoadingState({
  title,
  message = "Fetching the latest status…",
  error,
  secondaryAction,
  batchId,
}: {
  title: string;
  message?: string;
  error?: string | null;
  secondaryAction?: SecondaryAction;
  batchId?: string | null;
}) {
  return (
    <main className="content-page scan-result-page">
      <section className="scan-state-card" aria-live="polite">
        <span className="scan-spinner" />
        <p className="section-kicker">Scan in progress</p>
        <h1>{title}</h1>
        <p>{message}</p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {secondaryAction ? (
          <button
            className="text-button"
            disabled={secondaryAction.disabled}
            onClick={secondaryAction.onClick}
            type="button"
          >
            {secondaryAction.label}
          </button>
        ) : null}
        {batchId ? <BatchLink batchId={batchId} /> : null}
      </section>
    </main>
  );
}

function MessageState({
  title,
  message,
  action,
  error,
  secondaryAction,
  batchId,
}: {
  title: string;
  message: string;
  action: string;
  error?: string | null;
  secondaryAction?: SecondaryAction;
  batchId?: string | null;
}) {
  return (
    <main className="content-page scan-result-page">
      <section className="scan-state-card">
        <span className="upload-card__icon">
          <Icon name="info" size={26} />
        </span>
        <h1>{title}</h1>
        <p>{message}</p>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <Link className="primary-button" href="/scan">
            {action}
          </Link>
          {secondaryAction ? (
            <button
              className="secondary-button"
              disabled={secondaryAction.disabled}
              onClick={secondaryAction.onClick}
              type="button"
            >
              {secondaryAction.label}
            </button>
          ) : null}
        </div>
        {batchId ? <BatchLink batchId={batchId} /> : null}
      </section>
    </main>
  );
}

function BatchLink({ batchId }: { batchId: string }) {
  return (
    <Link className="text-button" href={`/scans/batch/${batchId}`}>
      View batch progress
    </Link>
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
    releaseDate: candidate.releaseYear?.toString() ?? "",
    country: "",
    format: "",
    packaging: "",
    releaseStatus: "",
    list: "collection",
    notes: "",
    mediaCondition: "",
    sleeveCondition: "",
    location: "",
    copyNotes: "",
    acquiredAt: "",
  };
}

function optional(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
