"use client";

import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";
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

type Phase =
  "ready" | "hashing" | "preparing" | "uploading" | "validating" | "submitting";

type SelectedImage = {
  clientId: string;
  file: File;
  preview: string;
};

type SessionRecord = {
  clientId: string;
  images: SelectedImage[];
};

type PreparedImage = SelectedImage & {
  mimeType: ImageMimeType;
  checksumSha256: string;
};

type CaptureSessionWorkflow = {
  batchKey: string;
  batchId?: string;
  records: Record<
    string,
    {
      scanKey: string;
      submitKey: string;
      images: Record<string, { uploadKey: string; completeKey: string }>;
    }
  >;
};

/**
 * A capture session is deliberately a client-side draft. Files cannot survive a
 * browser restart, but submitted scans and their batch membership do. Later
 * P3.1 work adds persisted queue state and recovery messaging around this seam.
 */
export function CaptureSession() {
  const router = useRouter();
  const recordsRef = useRef<SessionRecord[]>([]);
  const workflow = useRef<CaptureSessionWorkflow | null>(null);
  const [records, setRecords] = useState<SessionRecord[]>([]);
  const [phase, setPhase] = useState<Phase>("ready");
  const [activeRecord, setActiveRecord] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "ready";

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  useEffect(
    () => () => {
      for (const record of recordsRef.current) {
        for (const image of record.images) URL.revokeObjectURL(image.preview);
      }
    },
    [],
  );

  function addIndependentRecords(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length || busy) return;
    if (records.length + files.length > MAX_SCANS_PER_BATCH) {
      setError(
        `A capture session can include up to ${MAX_SCANS_PER_BATCH} records.`,
      );
      return;
    }

    setRecords((current) => [
      ...current,
      ...files.map((file) => ({
        clientId: crypto.randomUUID(),
        images: [createSelectedImage(file)],
      })),
    ]);
    setError(null);
  }

  function removeRecord(recordId: string) {
    const record = records.find((item) => item.clientId === recordId);
    if (record) {
      for (const image of record.images) URL.revokeObjectURL(image.preview);
    }
    setRecords((current) =>
      current.filter((record) => record.clientId !== recordId),
    );
    setUploadProgress({});
    setError(null);
  }

  async function startSession() {
    if (!records.length || busy) return;
    setError(null);
    setUploadProgress({});
    setPhase("hashing");
    try {
      const keys =
        workflow.current ??
        (workflow.current = {
          batchKey: `capture-session-${crypto.randomUUID()}`,
          records: {},
        });
      const preparedRecords = await Promise.all(
        records.map(async (record) => ({
          ...record,
          images: await Promise.all(record.images.map(prepareImage)),
        })),
      );

      setPhase("preparing");
      const batchId =
        keys.batchId ??
        CreateBatchResponseSchema.parse(
          await requestJson("/api/v1/batches", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": keys.batchKey,
            },
            body: JSON.stringify({}),
          }),
        ).batchId;
      keys.batchId = batchId;

      // Each record is created independently against the already-created batch.
      // This uses the existing incremental batch membership contract rather than
      // treating the selected files as one composite scan.
      for (const [index, record] of preparedRecords.entries()) {
        setActiveRecord(index + 1);
        await uploadRecord(
          record,
          batchId,
          recordWorkflowKeys(keys, record),
          (imageId, progress) => {
            setUploadProgress((current) => ({
              ...current,
              [imageId]: progress,
            }));
          },
          setPhase,
        );
      }
      router.push(`/scans/batch/${batchId}`);
    } catch (caught) {
      setPhase("ready");
      setActiveRecord(0);
      setError(
        caught instanceof Error
          ? caught.message
          : "The capture session could not be started. Please try again.",
      );
    }
  }

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

      <section className="upload-card capture-session" aria-busy={busy}>
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
          <label className={`primary-button${busy ? " is-disabled" : ""}`}>
            <Icon name="upload" size={18} /> Upload photos
            <input
              accept="image/jpeg,image/png,image/webp,image/gif"
              aria-label="Upload photos"
              disabled={busy}
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
                className={`status ${busy ? "status--review" : "status--success"}`}
              >
                <Icon name={busy ? "clock" : "check"} size={14} />
                {busy
                  ? phaseLabel(phase, activeRecord, records.length)
                  : `${records.length} ${records.length === 1 ? "record" : "records"} ready`}
              </span>
              <h2>Your session</h2>
              <p>
                Starting this session creates one batch and adds each record to
                it independently. You can review any completed record later.
              </p>
            </div>
            <div className="capture-session__records">
              {records.map((record, recordIndex) => (
                <article
                  className="capture-session__record"
                  key={record.clientId}
                >
                  <header>
                    <strong>Record {recordIndex + 1}</strong>
                    <span>Cover photo</span>
                  </header>
                  <div className="view-grid">
                    {record.images.map((image) => (
                      <div className="view-card" key={image.clientId}>
                        <img
                          alt={`Preview of ${image.file.name || "record photo"}`}
                          src={image.preview}
                        />
                        <div className="view-card__body">
                          <small title={image.file.name}>
                            {image.file.name || "Record photo"}
                          </small>
                          {uploadProgress[image.clientId] !== undefined ? (
                            <div
                              aria-label={`Upload progress for ${image.file.name || "record photo"}`}
                              aria-valuemax={100}
                              aria-valuemin={0}
                              aria-valuenow={uploadProgress[image.clientId]}
                              className="upload-progress"
                              role="progressbar"
                            >
                              <span
                                style={{
                                  width: `${uploadProgress[image.clientId]}%`,
                                }}
                              />
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                  <button
                    aria-label={`Remove record ${recordIndex + 1}`}
                    className="text-button capture-session__remove"
                    disabled={busy}
                    onClick={() => removeRecord(record.clientId)}
                    type="button"
                  >
                    Remove record
                  </button>
                </article>
              ))}
            </div>
            <div className="button-row multi-view-upload__actions">
              <button
                className="primary-button"
                disabled={busy}
                onClick={startSession}
                type="button"
              >
                <Icon name="sparkle" size={18} />
                {busy
                  ? phaseLabel(phase, activeRecord, records.length)
                  : "Start capture session"}
              </button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p className="form-error" role="alert">
            {error}
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

function createSelectedImage(file: File): SelectedImage {
  return {
    clientId: crypto.randomUUID(),
    file,
    preview: URL.createObjectURL(file),
  };
}

function phaseLabel(phase: Phase, activeRecord: number, recordCount: number) {
  const suffix = activeRecord ? ` ${activeRecord} of ${recordCount}` : "";
  switch (phase) {
    case "hashing":
      return "Checking images…";
    case "preparing":
      return `Preparing record${suffix}…`;
    case "uploading":
      return `Uploading record${suffix}…`;
    case "validating":
      return `Validating record${suffix}…`;
    case "submitting":
      return `Starting record${suffix}…`;
    default:
      return "Ready to scan";
  }
}

async function uploadRecord(
  record: SessionRecord & { images: PreparedImage[] },
  batchId: string,
  keys: CaptureSessionWorkflow["records"][string],
  onProgress: (imageId: string, progress: number) => void,
  setPhase: (phase: Phase) => void,
) {
  setPhase("preparing");
  const scan = CreateScanResponseSchema.parse(
    await requestJson("/api/v1/scans", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": keys.scanKey,
      },
      body: JSON.stringify({ source: "batch_upload", batchId }),
    }),
  );
  validateAgainstScanLimits(record.images, scan.limits);

  for (const image of record.images) {
    const imageKeys = keys.images[image.clientId];
    if (!imageKeys)
      throw new Error("The capture session could not be resumed.");
    setPhase("preparing");
    const signedUpload = SignedUploadSchema.parse(
      await requestJson(`/api/v1/scans/${scan.scanId}/uploads`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": imageKeys.uploadKey,
        },
        body: JSON.stringify({
          filename: image.file.name || "record-photo",
          viewType: "front",
          mimeType: image.mimeType,
          sizeBytes: image.file.size,
          checksumSha256: image.checksumSha256,
        }),
      }),
    );
    setPhase("uploading");
    await uploadFile(signedUpload, image.file, (progress) =>
      onProgress(image.clientId, progress),
    );
    setPhase("validating");
    CompleteImageUploadResponseSchema.parse(
      await requestJson(
        `/api/v1/scans/${scan.scanId}/uploads/${signedUpload.imageId}/complete`,
        {
          method: "POST",
          headers: { "idempotency-key": imageKeys.completeKey },
        },
      ),
    );
  }
  setPhase("submitting");
  SubmitScanResponseSchema.parse(
    await requestJson(`/api/v1/scans/${scan.scanId}/submit`, {
      method: "POST",
      headers: { "idempotency-key": keys.submitKey },
    }),
  );
}

function recordWorkflowKeys(
  workflow: CaptureSessionWorkflow,
  record: SessionRecord,
): CaptureSessionWorkflow["records"][string] {
  const existing = workflow.records[record.clientId];
  if (existing) return existing;
  const keys = {
    scanKey: `scan-${crypto.randomUUID()}`,
    submitKey: `submit-${crypto.randomUUID()}`,
    images: Object.fromEntries(
      record.images.map((image) => [
        image.clientId,
        {
          uploadKey: `upload-${crypto.randomUUID()}`,
          completeKey: `complete-${crypto.randomUUID()}`,
        },
      ]),
    ),
  };
  workflow.records[record.clientId] = keys;
  return keys;
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
  images: readonly PreparedImage[],
  limits: {
    acceptedMimeTypes: readonly ImageMimeType[];
    maxImages: number;
    maxImageSizeBytes: number;
  },
) {
  if (images.length > limits.maxImages) {
    throw new Error(`One record can include up to ${limits.maxImages} views.`);
  }
  for (const image of images) {
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
    request.send(file);
  });
}
