"use client";

import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  CompleteImageUploadResponseSchema,
  CreateBatchResponseSchema,
  CreateScanResponseSchema,
  detectImageMimeType,
  IMAGE_SNIFF_BYTE_LENGTH,
  type ImageMimeType,
  MAX_SCANS_PER_BATCH,
  SignedUploadSchema,
  SubmitScanResponseSchema,
} from "@vinylhound/contracts";

import { Icon } from "../ui";

const UPLOAD_CONCURRENCY = 3;
const CAPTURE_SESSION_STORAGE_KEY = "vinylhound.captureSession.v1";

type ProcessingStage =
  "hashing" | "preparing" | "uploading" | "validating" | "submitting";

type RecordStatus =
  "idle" | "needs-recapture" | "queued" | "processing" | "failed";

type SelectedImage = { file: File; preview: string };

type PreparedImage = SelectedImage & {
  mimeType: ImageMimeType;
  checksumSha256: string;
};

type SessionRecord = {
  clientId: string;
  fileName: string;
  image: SelectedImage | null;
  scanKey: string;
  submitKey: string;
  uploadKey: string;
  completeKey: string;
  scanId: string | null;
  imageId: string | null;
  imageCompleted: boolean;
  status: RecordStatus;
  stage: ProcessingStage | null;
  error: string | null;
};

type PersistedRecord = {
  clientId: string;
  fileName: string;
  scanKey: string;
  submitKey: string;
  uploadKey: string;
  completeKey: string;
  scanId: string | null;
  imageId: string | null;
  imageCompleted: boolean;
};

type PersistedSession = {
  batchKey: string;
  batchId: string | null;
  records: PersistedRecord[];
};

/**
 * A capture session's selected files are a client-side draft: the browser
 * loses them on refresh. What survives in `localStorage` is the queue's
 * bookkeeping — batch/scan identity and idempotency keys — so a resumed
 * record can skip straight to whichever step it actually reached rather than
 * starting over. A record whose image never finished uploading has no bytes
 * on the server either, so it comes back as "needs recapture" rather than
 * silently retrying with nothing to send.
 */
export function CaptureSession() {
  const router = useRouter();
  const recordsRef = useRef<SessionRecord[]>([]);
  const batchKeyRef = useRef(`capture-session-${crypto.randomUUID()}`);
  const queueRef = useRef<string[]>([]);
  const activeCountRef = useRef(0);
  const abortControllers = useRef<Record<string, AbortController>>({});
  // Tracks how many records in this session have not yet been submitted.
  // React's setState updater form does not run synchronously here (these
  // calls happen inside awaited async work, outside any React event
  // handler), so a value captured from inside an updater cannot be trusted
  // immediately after calling setRecords. This ref is the reliable source
  // for "was that the last one" when deciding whether to auto-navigate.
  const pendingCountRef = useRef(0);

  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [rehydrated, setRehydrated] = useState(false);
  const [sessionRunning, setSessionRunning] = useState(false);
  const [submittedCount, setSubmittedCount] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>(
    {},
  );
  const [globalError, setGlobalError] = useState<string | null>(null);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  useEffect(
    () => () => {
      for (const record of recordsRef.current) {
        if (record.image) URL.revokeObjectURL(record.image.preview);
      }
    },
    [],
  );

  useEffect(() => {
    const persisted = loadPersistedSession();
    if (!persisted || persisted.records.length === 0) return;
    batchKeyRef.current = persisted.batchKey;
    pendingCountRef.current = persisted.records.length;
    setBatchId(persisted.batchId);
    setRecords(
      persisted.records.map((record) => ({
        ...record,
        image: null,
        status: record.imageCompleted ? "idle" : "needs-recapture",
        stage: null,
        error: null,
      })),
    );
    setRehydrated(true);
  }, []);

  useEffect(() => {
    if (!batchId) return;
    persistSession({
      batchKey: batchKeyRef.current,
      batchId,
      records: records.map(
        ({
          clientId,
          fileName,
          scanKey,
          submitKey,
          uploadKey,
          completeKey,
          scanId,
          imageId,
          imageCompleted,
        }) => ({
          clientId,
          fileName,
          scanKey,
          submitKey,
          uploadKey,
          completeKey,
          scanId,
          imageId,
          imageCompleted,
        }),
      ),
    });
  }, [records, batchId]);

  function addIndependentRecords(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length || sessionRunning) return;
    if (records.length + submittedCount + files.length > MAX_SCANS_PER_BATCH) {
      setGlobalError(
        `A capture session can include up to ${MAX_SCANS_PER_BATCH} records.`,
      );
      return;
    }
    pendingCountRef.current += files.length;
    setRecords((current) => [...current, ...files.map(createIdleRecord)]);
    setGlobalError(null);
  }

  function attachRecapture(
    clientId: string,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const image: SelectedImage = { file, preview: URL.createObjectURL(file) };
    const staleScanId = recordsRef.current.find(
      (record) => record.clientId === clientId,
    )?.scanId;
    setRecords((current) =>
      current.map((record) =>
        record.clientId === clientId
          ? {
              ...record,
              image,
              fileName: file.name || record.fileName,
              status: "idle",
              error: null,
              // A prior attempt may have already registered an image against
              // this scan (or even just reserved it) before it was
              // interrupted. Reusing that scan would either replay its
              // /uploads idempotency key against different image bytes (a
              // conflict) or leave that stale, never-completed image
              // registration attached to the scan, which permanently blocks
              // submission server-side. A reattached photo instead starts a
              // whole new scan under fresh keys; the stale one is canceled
              // best-effort below.
              scanId: null,
              imageId: null,
              imageCompleted: false,
              scanKey: `scan-${crypto.randomUUID()}`,
              submitKey: `submit-${crypto.randomUUID()}`,
              uploadKey: `upload-${crypto.randomUUID()}`,
              completeKey: `complete-${crypto.randomUUID()}`,
            }
          : record,
      ),
    );
    if (staleScanId) {
      requestJson(`/api/v1/scans/${staleScanId}/cancel`, {
        method: "POST",
        headers: { "idempotency-key": `cancel-${clientId}` },
      }).catch(() => {
        // Best-effort: the record already moved on to a new scan.
      });
    }
  }

  async function removeRecord(clientId: string) {
    const record = recordsRef.current.find(
      (item) => item.clientId === clientId,
    );
    if (!record) return;
    queueRef.current = queueRef.current.filter((id) => id !== clientId);
    abortControllers.current[clientId]?.abort();
    delete abortControllers.current[clientId];
    if (record.image) URL.revokeObjectURL(record.image.preview);
    pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
    setRecords((current) =>
      current.filter((item) => item.clientId !== clientId),
    );
    setUploadProgress((current) => dropProgress(current, clientId));
    if (record.scanId) {
      try {
        await requestJson(`/api/v1/scans/${record.scanId}/cancel`, {
          method: "POST",
          headers: { "idempotency-key": `cancel-${record.clientId}` },
        });
      } catch {
        // Best-effort: the record is already gone from this session locally.
      }
    }
  }

  function retryRecord(clientId: string) {
    setRecords((current) =>
      current.map((record) =>
        record.clientId === clientId
          ? { ...record, status: "idle", error: null }
          : record,
      ),
    );
    if (batchId) enqueueRecords([clientId], batchId);
  }

  async function discardSession() {
    const toCancel = recordsRef.current.filter((record) => record.scanId);
    for (const record of recordsRef.current) {
      if (record.image) URL.revokeObjectURL(record.image.preview);
    }
    queueRef.current = [];
    pendingCountRef.current = 0;
    setRecords([]);
    setRehydrated(false);
    setUploadProgress({});
    persistSession(null);
    batchKeyRef.current = `capture-session-${crypto.randomUUID()}`;
    setBatchId(null);
    await Promise.allSettled(
      toCancel.map((record) =>
        requestJson(`/api/v1/scans/${record.scanId}/cancel`, {
          method: "POST",
          headers: { "idempotency-key": `cancel-${record.clientId}` },
        }).catch(() => {}),
      ),
    );
  }

  async function startSession() {
    if (sessionRunning) return;
    setGlobalError(null);
    try {
      let targetBatchId = batchId;
      if (!targetBatchId) {
        const created = CreateBatchResponseSchema.parse(
          await requestJson("/api/v1/batches", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": batchKeyRef.current,
            },
            body: JSON.stringify({}),
          }),
        );
        targetBatchId = created.batchId;
        setBatchId(targetBatchId);
      }
      const idleIds = recordsRef.current
        .filter((record) => record.status === "idle")
        .map((record) => record.clientId);
      enqueueRecords(idleIds, targetBatchId);
    } catch (caught) {
      setGlobalError(
        caught instanceof Error
          ? caught.message
          : "The capture session could not be started. Please try again.",
      );
    }
  }

  function enqueueRecords(clientIds: string[], targetBatchId: string) {
    const eligible = clientIds.filter((id) => !queueRef.current.includes(id));
    if (!eligible.length) return;
    setRecords((current) =>
      current.map((record) =>
        eligible.includes(record.clientId)
          ? { ...record, status: "queued" }
          : record,
      ),
    );
    queueRef.current.push(...eligible);
    pump(targetBatchId);
  }

  function pump(targetBatchId: string) {
    while (
      activeCountRef.current < UPLOAD_CONCURRENCY &&
      queueRef.current.length > 0
    ) {
      const clientId = queueRef.current.shift();
      if (!clientId) break;
      activeCountRef.current += 1;
      setSessionRunning(true);
      void processRecord(clientId, targetBatchId).finally(() => {
        activeCountRef.current -= 1;
        if (activeCountRef.current === 0 && queueRef.current.length === 0) {
          setSessionRunning(false);
        }
        pump(targetBatchId);
      });
    }
  }

  async function processRecord(clientId: string, targetBatchId: string) {
    const controller = new AbortController();
    abortControllers.current[clientId] = controller;
    try {
      const record = recordsRef.current.find(
        (item) => item.clientId === clientId,
      );
      if (!record) return;
      if (!record.image) {
        throw new Error("This record needs a photo before it can be uploaded.");
      }

      updateRecord(clientId, (item) => ({
        ...item,
        status: "processing",
        stage: "hashing",
      }));
      const prepared = await prepareImage(record.image);

      let scanId = record.scanId;
      if (!scanId) {
        updateRecord(clientId, (item) => ({ ...item, stage: "preparing" }));
        const scan = CreateScanResponseSchema.parse(
          await requestJson("/api/v1/scans", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": record.scanKey,
            },
            body: JSON.stringify({
              source: "batch_upload",
              batchId: targetBatchId,
            }),
            signal: controller.signal,
          }),
        );
        validateAgainstScanLimits(prepared, scan.limits);
        scanId = scan.scanId;
        updateRecord(clientId, (item) => ({ ...item, scanId }));
      }

      if (!record.imageCompleted) {
        updateRecord(clientId, (item) => ({ ...item, stage: "preparing" }));
        const signedUpload = SignedUploadSchema.parse(
          await requestJson(`/api/v1/scans/${scanId}/uploads`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": record.uploadKey,
            },
            body: JSON.stringify({
              filename: prepared.file.name || "record-photo",
              viewType: "front",
              mimeType: prepared.mimeType,
              sizeBytes: prepared.file.size,
              checksumSha256: prepared.checksumSha256,
            }),
            signal: controller.signal,
          }),
        );
        updateRecord(clientId, (item) => ({ ...item, stage: "uploading" }));
        await uploadFile(
          signedUpload,
          prepared.file,
          (progress) =>
            setUploadProgress((current) => ({
              ...current,
              [clientId]: progress,
            })),
          controller.signal,
        );
        updateRecord(clientId, (item) => ({ ...item, stage: "validating" }));
        CompleteImageUploadResponseSchema.parse(
          await requestJson(
            `/api/v1/scans/${scanId}/uploads/${signedUpload.imageId}/complete`,
            {
              method: "POST",
              headers: { "idempotency-key": record.completeKey },
              signal: controller.signal,
            },
          ),
        );
        updateRecord(clientId, (item) => ({
          ...item,
          imageId: signedUpload.imageId,
          imageCompleted: true,
        }));
      }

      updateRecord(clientId, (item) => ({ ...item, stage: "submitting" }));
      SubmitScanResponseSchema.parse(
        await requestJson(`/api/v1/scans/${scanId}/submit`, {
          method: "POST",
          headers: { "idempotency-key": record.submitKey },
          signal: controller.signal,
        }),
      );

      if (record.image) URL.revokeObjectURL(record.image.preview);
      pendingCountRef.current = Math.max(0, pendingCountRef.current - 1);
      setRecords((current) =>
        current.filter((item) => item.clientId !== clientId),
      );
      setSubmittedCount((count) => count + 1);
      setUploadProgress((current) => dropProgress(current, clientId));
      if (pendingCountRef.current === 0) {
        persistSession(null);
        router.push(`/scans/batch/${targetBatchId}`);
      }
    } catch (caught) {
      if (controller.signal.aborted) return;
      updateRecord(clientId, (item) => ({
        ...item,
        status: "failed",
        stage: null,
        error:
          caught instanceof Error
            ? caught.message
            : "This record could not be uploaded.",
      }));
    } finally {
      delete abortControllers.current[clientId];
    }
  }

  function updateRecord(
    clientId: string,
    updater: (record: SessionRecord) => SessionRecord,
  ) {
    setRecords((current) =>
      current.map((record) =>
        record.clientId === clientId ? updater(record) : record,
      ),
    );
  }

  const needsRecaptureCount = records.filter(
    (record) => record.status === "needs-recapture",
  ).length;
  const canStart = records.some((record) => record.status === "idle");

  return (
    <main className="content-page scan-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">Capture session</p>
          <h1>Keep scanning as you browse.</h1>
          <p>
            Upload one cover photo per record. Every selected photo becomes an
            independently reviewable record in this session.
          </p>
        </div>
      </header>

      {rehydrated && records.length > 0 ? (
        <div className="capture-session__resume-banner" role="status">
          <p>
            We restored {records.length}{" "}
            {records.length === 1 ? "record" : "records"} from your last
            session.
            {needsRecaptureCount > 0
              ? ` ${needsRecaptureCount} ${needsRecaptureCount === 1 ? "needs" : "need"} a photo reattached before it can continue.`
              : ""}
          </p>
          <div className="button-row">
            <button
              className="text-button"
              onClick={discardSession}
              type="button"
            >
              Discard session
            </button>
          </div>
        </div>
      ) : null}

      {submittedCount > 0 && batchId ? (
        <p className="capture-session__review-link" role="status">
          {submittedCount} {submittedCount === 1 ? "record" : "records"}{" "}
          submitted so far.{" "}
          <Link href={`/scans/batch/${batchId}`}>Review them now</Link> — the
          rest will keep going here.
        </p>
      ) : null}

      <section
        className="upload-card capture-session"
        aria-busy={sessionRunning}
      >
        <div className="capture-session__intro">
          <span className="upload-card__icon">
            <Icon name="upload" size={28} />
          </span>
          <h2>{records.length ? "Add another record" : "Start a session"}</h2>
          <p>
            Select one or more front-cover photos. Each photo is handled as its
            own record, so you can review results separately.
          </p>
        </div>

        <div className="capture-session__actions button-row">
          <label
            className={`primary-button${sessionRunning ? " is-disabled" : ""}`}
          >
            <Icon name="upload" size={18} /> Upload photos
            <input
              accept="image/jpeg,image/png,image/webp,image/gif"
              aria-label="Upload photos"
              disabled={sessionRunning}
              multiple
              onChange={addIndependentRecords}
              type="file"
            />
          </label>
        </div>

        {records.length ? (
          <div className="capture-session__queue">
            <div className="multi-view-upload__heading">
              <span
                className={`status ${sessionRunning ? "status--review" : "status--success"}`}
              >
                <Icon name={sessionRunning ? "clock" : "check"} size={14} />
                {sessionRunning
                  ? "Uploading your session…"
                  : `${records.length} ${records.length === 1 ? "record" : "records"} in this session`}
              </span>
              <h2>Your session</h2>
              <p>
                Starting this session creates one batch and adds each record to
                it independently. You can review any completed record later.
              </p>
            </div>
            <div className="capture-session__records">
              {records.map((record, recordIndex) => (
                <RecordCard
                  key={record.clientId}
                  onAttach={(event) => attachRecapture(record.clientId, event)}
                  onRemove={() => removeRecord(record.clientId)}
                  onRetry={() => retryRecord(record.clientId)}
                  progress={uploadProgress[record.clientId]}
                  record={record}
                  recordIndex={recordIndex}
                />
              ))}
            </div>
            <div className="button-row multi-view-upload__actions">
              <button
                className="primary-button"
                disabled={sessionRunning || !canStart}
                onClick={startSession}
                type="button"
              >
                <Icon name="sparkle" size={18} />
                {sessionRunning
                  ? "Uploading…"
                  : batchId
                    ? "Resume session"
                    : "Start capture session"}
              </button>
            </div>
          </div>
        ) : null}

        {globalError ? (
          <p className="form-error" role="alert">
            {globalError}
          </p>
        ) : null}
        <small>
          JPEG, PNG, WebP, or GIF · Up to 10 MB each · {MAX_SCANS_PER_BATCH}{" "}
          records per session
        </small>
      </section>

      <aside className="scan-tip">
        <Icon name="info" size={20} />
        <div>
          <strong>For the best match</strong>
          <p>
            Use a clear, unobstructed front cover. A cover identifies a release
            concept, not a specific pressing.
          </p>
        </div>
      </aside>
    </main>
  );
}

function RecordCard({
  record,
  recordIndex,
  progress,
  onRemove,
  onRetry,
  onAttach,
}: {
  record: SessionRecord;
  recordIndex: number;
  progress: number | undefined;
  onRemove: () => void;
  onRetry: () => void;
  onAttach: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const removable =
    record.status === "idle" || record.status === "needs-recapture";

  return (
    <article className="capture-session__record" data-status={record.status}>
      <header>
        <strong>Record {recordIndex + 1}</strong>
        <span className={`status ${recordStatusTone(record.status)}`}>
          {recordStatusLabel(record)}
        </span>
      </header>

      {record.status === "needs-recapture" ? (
        <div className="capture-session__recapture">
          <p>
            This device lost the photo for &ldquo;{record.fileName}&rdquo;.
            Attach it again to continue.
          </p>
          <div className="button-row">
            <label className="secondary-button">
              <Icon name="camera" size={16} /> Attach photo
              <input
                accept="image/jpeg,image/png,image/webp,image/gif"
                aria-label={`Attach a photo for record ${recordIndex + 1}`}
                onChange={onAttach}
                type="file"
              />
            </label>
          </div>
        </div>
      ) : record.image ? (
        <div className="view-grid">
          <div className="view-card">
            <img
              alt={`Preview of ${record.fileName}`}
              src={record.image.preview}
            />
            <div className="view-card__body">
              <small title={record.fileName}>{record.fileName}</small>
              {progress !== undefined ? (
                <div
                  aria-label={`Upload progress for ${record.fileName}`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={progress}
                  className="upload-progress"
                  role="progressbar"
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {record.error ? (
        <p className="form-error" role="alert">
          {record.error}
        </p>
      ) : null}

      <div className="button-row">
        {record.status === "failed" ? (
          <button className="text-button" onClick={onRetry} type="button">
            Retry
          </button>
        ) : null}
        <button
          aria-label={
            removable
              ? `Remove record ${recordIndex + 1}`
              : `Cancel record ${recordIndex + 1}`
          }
          className="text-button capture-session__remove"
          onClick={onRemove}
          type="button"
        >
          {removable ? "Remove record" : "Cancel"}
        </button>
      </div>
    </article>
  );
}

function dropProgress(
  current: Record<string, number>,
  clientId: string,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(current).filter(([id]) => id !== clientId),
  );
}

function createIdleRecord(file: File): SessionRecord {
  return {
    clientId: crypto.randomUUID(),
    fileName: file.name || "Record photo",
    image: { file, preview: URL.createObjectURL(file) },
    scanKey: `scan-${crypto.randomUUID()}`,
    submitKey: `submit-${crypto.randomUUID()}`,
    uploadKey: `upload-${crypto.randomUUID()}`,
    completeKey: `complete-${crypto.randomUUID()}`,
    scanId: null,
    imageId: null,
    imageCompleted: false,
    status: "idle",
    stage: null,
    error: null,
  };
}

function recordStatusLabel(record: SessionRecord) {
  switch (record.status) {
    case "idle":
      return "Ready";
    case "needs-recapture":
      return "Needs recapture";
    case "queued":
      return "Queued";
    case "processing":
      return stageLabel(record.stage);
    case "failed":
      return "Failed";
  }
}

function recordStatusTone(status: RecordStatus) {
  if (status === "failed") return "status--error";
  if (status === "needs-recapture") return "status--review";
  if (status === "idle") return "status--success";
  return "status--review";
}

function stageLabel(stage: ProcessingStage | null) {
  switch (stage) {
    case "hashing":
      return "Checking image…";
    case "preparing":
      return "Preparing…";
    case "uploading":
      return "Uploading…";
    case "validating":
      return "Validating…";
    case "submitting":
      return "Starting…";
    default:
      return "Processing…";
  }
}

async function prepareImage(image: SelectedImage): Promise<PreparedImage> {
  const detected = detectImageMimeType(
    new Uint8Array(
      await image.file.slice(0, IMAGE_SNIFF_BYTE_LENGTH).arrayBuffer(),
    ),
  );
  if (detected.kind !== "supported") {
    throw new Error(
      detected.kind === "heif_like"
        ? `${image.file.name}: HEIC/HEIF is not supported yet. Export or convert it to JPEG and try again.`
        : `${image.file.name}: that file is not a JPEG, PNG, WebP, or GIF image.`,
    );
  }
  return {
    ...image,
    mimeType: detected.mimeType,
    checksumSha256: await sha256(image.file),
  };
}

function validateAgainstScanLimits(
  image: PreparedImage,
  limits: {
    acceptedMimeTypes: readonly ImageMimeType[];
    maxImageSizeBytes: number;
  },
) {
  if (!limits.acceptedMimeTypes.includes(image.mimeType)) {
    throw new Error(
      `${image.file.name}: choose a JPEG, PNG, WebP, or GIF image.`,
    );
  }
  if (image.file.size > limits.maxImageSizeBytes) {
    throw new Error(
      `${image.file.name}: that image is larger than the 10 MB limit.`,
    );
  }
}

async function sha256(file: File) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function requestJson(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const body = (await response.json()) as { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(
      body.error?.message ?? "The request could not be completed.",
    );
  }
  return body;
}

function uploadFile(
  signedUpload: {
    method: "PUT";
    url: string;
    requiredHeaders: Record<string, string>;
  },
  file: File,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(signedUpload.method, signedUpload.url);
    for (const [name, value] of Object.entries(signedUpload.requiredHeaders)) {
      request.setRequestHeader(name, value);
    }
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        reject(new Error("The image upload was rejected. Please try again."));
      }
    });
    request.addEventListener("error", () =>
      reject(new Error("The image upload was interrupted. Please try again.")),
    );
    request.addEventListener("abort", () =>
      reject(new Error("The image upload was canceled.")),
    );
    signal.addEventListener("abort", () => request.abort());
    if (signal.aborted) {
      request.abort();
      return;
    }
    request.send(file);
  });
}

function loadPersistedSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(CAPTURE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistSession(session: PersistedSession | null) {
  try {
    if (!session) {
      localStorage.removeItem(CAPTURE_SESSION_STORAGE_KEY);
      return;
    }
    localStorage.setItem(CAPTURE_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Best-effort: a full or blocked store should not break the session.
  }
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<PersistedSession>;
  return (
    typeof session.batchKey === "string" &&
    (session.batchId === null || typeof session.batchId === "string") &&
    Array.isArray(session.records) &&
    session.records.every(isPersistedRecord)
  );
}

function isPersistedRecord(value: unknown): value is PersistedRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedRecord>;
  return (
    typeof record.clientId === "string" &&
    typeof record.fileName === "string" &&
    typeof record.scanKey === "string" &&
    typeof record.submitKey === "string" &&
    typeof record.uploadKey === "string" &&
    typeof record.completeKey === "string" &&
    (record.scanId === null || typeof record.scanId === "string") &&
    (record.imageId === null || typeof record.imageId === "string") &&
    typeof record.imageCompleted === "boolean"
  );
}
