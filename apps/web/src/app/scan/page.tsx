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
  type ImageViewType,
  MAX_IMAGES_PER_SCAN,
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
  viewType: ImageViewType;
};

type UploadWorkflow = {
  createKey: string;
  submitKey: string;
  images: Record<
    string,
    {
      uploadKey: string;
      completeKey: string;
    }
  >;
};

type PreparedImage = SelectedImage & {
  mimeType: ImageMimeType;
  checksumSha256: string;
};

const viewOptions: Array<{ value: ImageViewType; label: string }> = [
  { value: "front", label: "Front cover" },
  { value: "back", label: "Back cover" },
  { value: "spine", label: "Spine" },
  { value: "label", label: "Record label" },
];

type CaptureMode = "single" | "batch";

export default function ScanPage() {
  const router = useRouter();
  const workflow = useRef<UploadWorkflow | null>(null);
  const imagesRef = useRef<SelectedImage[]>([]);
  const [mode, setMode] = useState<CaptureMode>("single");
  const [images, setImages] = useState<SelectedImage[]>([]);
  const [source, setSource] = useState<"camera" | "single_upload">(
    "single_upload",
  );
  const [phase, setPhase] = useState<Phase>("ready");
  const [activeImage, setActiveImage] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "ready";
  const maxImages =
    mode === "batch" ? MAX_SCANS_PER_BATCH : MAX_IMAGES_PER_SCAN;

  function switchMode(nextMode: CaptureMode) {
    if (nextMode === mode || busy) return;
    for (const image of images) URL.revokeObjectURL(image.preview);
    setImages([]);
    setMode(nextMode);
    setError(null);
    setUploadProgress({});
    workflow.current = null;
  }

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(
    () => () => {
      for (const image of imagesRef.current) URL.revokeObjectURL(image.preview);
    },
    [],
  );

  function addFiles(
    event: ChangeEvent<HTMLInputElement>,
    nextSource: "camera" | "single_upload",
  ) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selected.length) return;
    if (images.length + selected.length > maxImages) {
      setError(
        mode === "batch"
          ? `One batch can include up to ${maxImages} records.`
          : `One record can include up to ${maxImages} views.`,
      );
      return;
    }

    const added = selected.map((file, index) => ({
      clientId: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
      viewType:
        mode === "batch" ? "front" : suggestedView(images.length + index),
    }));
    setImages([...images, ...added]);
    if (images.length === 0) setSource(nextSource);
    setPhase("ready");
    setUploadProgress({});
    setError(null);
    workflow.current = null;
  }

  function updateView(clientId: string, viewType: ImageViewType) {
    setImages((current) =>
      current.map((image) =>
        image.clientId === clientId ? { ...image, viewType } : image,
      ),
    );
    setUploadProgress({});
    setError(null);
    workflow.current = null;
  }

  function removeImage(clientId: string) {
    const removed = images.find((image) => image.clientId === clientId);
    if (removed) URL.revokeObjectURL(removed.preview);
    setImages((current) =>
      current.filter((image) => image.clientId !== clientId),
    );
    setUploadProgress({});
    setError(null);
    workflow.current = null;
  }

  async function identifyAlbum() {
    if (!images.length || busy) return;
    setError(null);
    setUploadProgress({});
    const keys =
      workflow.current ??
      (workflow.current = {
        createKey: `scan-${crypto.randomUUID()}`,
        submitKey: `submit-${crypto.randomUUID()}`,
        images: Object.fromEntries(
          images.map((image) => [
            image.clientId,
            {
              uploadKey: `upload-${crypto.randomUUID()}`,
              completeKey: `complete-${crypto.randomUUID()}`,
            },
          ]),
        ),
      });

    try {
      setPhase("hashing");
      const prepared = await Promise.all(images.map(prepareImage));

      setPhase("preparing");
      const scan = CreateScanResponseSchema.parse(
        await requestJson("/api/v1/scans", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": keys.createKey,
          },
          body: JSON.stringify({ source }),
        }),
      );
      validateAgainstScanLimits(prepared, scan.limits);

      for (const [index, image] of prepared.entries()) {
        const imageKeys = keys.images[image.clientId];
        if (!imageKeys) throw new Error("The upload could not be resumed.");
        setActiveImage(index + 1);
        setPhase("preparing");
        const signedUpload = SignedUploadSchema.parse(
          await requestJson(`/api/v1/scans/${scan.scanId}/uploads`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": imageKeys.uploadKey,
            },
            body: JSON.stringify({
              filename: image.file.name || `${image.viewType}-photo`,
              viewType: image.viewType,
              mimeType: image.mimeType,
              sizeBytes: image.file.size,
              checksumSha256: image.checksumSha256,
            }),
          }),
        );

        setPhase("uploading");
        await uploadFile(signedUpload, image.file, (progress) => {
          setUploadProgress((current) => ({
            ...current,
            [image.clientId]: progress,
          }));
        });

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
      router.push(`/scans/${scan.scanId}`);
    } catch (caught) {
      setPhase("ready");
      setActiveImage(0);
      setError(
        caught instanceof Error
          ? caught.message
          : "The scan could not be started. Please try again.",
      );
    }
  }

  async function identifyBatch() {
    if (!images.length || busy) return;
    setError(null);
    setUploadProgress({});
    setPhase("hashing");
    try {
      const prepared = await Promise.all(images.map(prepareImage));

      setPhase("preparing");
      const batch = CreateBatchResponseSchema.parse(
        await requestJson("/api/v1/batches", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `batch-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({}),
        }),
      );

      let completed = 0;
      const results = await Promise.allSettled(
        prepared.map(async (image) => {
          await uploadOneImageScan(image, batch.batchId);
          completed += 1;
          setActiveImage(completed);
        }),
      );

      const failedCount = results.filter(
        (result) => result.status === "rejected",
      ).length;
      const query = failedCount > 0 ? `?failed=${failedCount}` : "";
      router.push(`/scans/batch/${batch.batchId}${query}`);
    } catch (caught) {
      setPhase("ready");
      setActiveImage(0);
      setError(
        caught instanceof Error
          ? caught.message
          : "The batch could not be started. Please try again.",
      );
    }
  }

  const identify = mode === "batch" ? identifyBatch : identifyAlbum;

  return (
    <main className="content-page scan-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">New scan</p>
          <h1>Let&apos;s identify that record.</h1>
          <p>
            Add one clear front cover, or combine several views of the same
            physical record for a stronger match.
          </p>
        </div>
      </header>

      <div className="capture-mode-toggle" role="group" aria-label="Scan mode">
        <button
          className={mode === "single" ? "is-active" : ""}
          aria-pressed={mode === "single"}
          disabled={busy}
          onClick={() => switchMode("single")}
          type="button"
        >
          One record
        </button>
        <button
          className={mode === "batch" ? "is-active" : ""}
          aria-pressed={mode === "batch"}
          disabled={busy}
          onClick={() => switchMode("batch")}
          type="button"
        >
          Multiple records
        </button>
      </div>

      <section className="upload-card" aria-busy={busy}>
        {images.length ? (
          <div className="multi-view-upload">
            <div className="multi-view-upload__heading">
              <span className="status status--success">
                <Icon name="check" size={14} />
                {phaseLabel(phase, activeImage, images.length)}
              </span>
              <h2>
                {mode === "batch"
                  ? `${images.length} ${images.length === 1 ? "record" : "records"} in this batch`
                  : `${images.length} ${images.length === 1 ? "view" : "views"} of one record`}
              </h2>
              <p>
                {mode === "batch"
                  ? "Each photo becomes its own scan. Track and retry them independently from the batch page."
                  : "Label each photo so the model can combine cover and edition evidence correctly."}
              </p>
            </div>

            <div className="view-grid">
              {images.map((image) => (
                <article className="view-card" key={image.clientId}>
                  <img
                    alt={`Preview of ${image.file.name}`}
                    src={image.preview}
                  />
                  <div className="view-card__body">
                    {mode === "single" ? (
                      <label>
                        <span>Photo type</span>
                        <select
                          disabled={busy}
                          onChange={(event) =>
                            updateView(
                              image.clientId,
                              event.target.value as ImageViewType,
                            )
                          }
                          value={image.viewType}
                        >
                          {viewOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <small title={image.file.name}>
                      {image.file.name || "Record photo"}
                    </small>
                    {uploadProgress[image.clientId] !== undefined ? (
                      <div
                        className="upload-progress"
                        aria-label={`Upload progress for ${image.file.name}`}
                      >
                        <span
                          style={{
                            width: `${uploadProgress[image.clientId]}%`,
                          }}
                        />
                      </div>
                    ) : null}
                    <button
                      className="text-button view-card__remove"
                      disabled={busy}
                      onClick={() => removeImage(image.clientId)}
                      type="button"
                    >
                      Remove
                    </button>
                  </div>
                </article>
              ))}
            </div>

            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}

            <div className="button-row multi-view-upload__actions">
              <button
                className="primary-button"
                disabled={busy}
                onClick={identify}
                type="button"
              >
                <Icon name="sparkle" size={18} />
                {busy
                  ? phaseLabel(phase, activeImage, images.length)
                  : mode === "batch"
                    ? "Identify all records"
                    : "Identify album"}
              </button>
              <label
                className={`secondary-button${busy ? " is-disabled" : ""}`}
              >
                <Icon name="upload" size={18} />{" "}
                {mode === "batch" ? "Add records" : "Add views"}
                <input
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  disabled={busy}
                  multiple
                  onChange={(event) => addFiles(event, "single_upload")}
                  type="file"
                />
              </label>
              <label
                className={`secondary-button${busy ? " is-disabled" : ""}`}
              >
                <Icon name="camera" size={18} /> Add photo
                <input
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  capture="environment"
                  disabled={busy}
                  multiple={mode === "batch"}
                  onChange={(event) => addFiles(event, "camera")}
                  type="file"
                />
              </label>
            </div>
          </div>
        ) : (
          <>
            <span className="upload-card__icon">
              <Icon name="camera" size={28} />
            </span>
            <h2>
              {mode === "batch" ? "Add several records" : "Add record photos"}
            </h2>
            <p>
              {mode === "batch"
                ? "Choose one front-cover photo per record. Each becomes its own scan, tracked together as a batch."
                : "Start with the front cover. You can then add the back, spine, or record label to the same scan."}
            </p>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="button-row">
              <label className="primary-button">
                <Icon name="camera" size={18} /> Take a photo
                <input
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  capture="environment"
                  multiple={mode === "batch"}
                  onChange={(event) => addFiles(event, "camera")}
                  type="file"
                />
              </label>
              <label className="secondary-button">
                <Icon name="upload" size={18} />{" "}
                {mode === "batch" ? "Upload photos" : "Upload images"}
                <input
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  onChange={(event) => addFiles(event, "single_upload")}
                  type="file"
                />
              </label>
            </div>
            <small>
              JPEG, PNG, WebP, or GIF · Up to 10 MB each ·{" "}
              {mode === "batch"
                ? `${MAX_SCANS_PER_BATCH} records maximum`
                : `${MAX_IMAGES_PER_SCAN} views maximum`}
            </small>
          </>
        )}
      </section>

      <aside className="scan-tip">
        <Icon name="info" size={20} />
        <div>
          <strong>For the best match</strong>
          <p>
            {mode === "batch"
              ? "Each photo in a batch is treated as a different physical record. To combine several views of the same record, switch to “One record” instead."
              : "Avoid glare, keep details in focus, and only group photos of the same physical record. A front cover identifies the album; back, spine, and label views can support edition details."}
          </p>
        </div>
      </aside>
    </main>
  );
}

function suggestedView(index: number): ImageViewType {
  return (["front", "back", "spine", "label"] as const)[index] ?? "label";
}

function phaseLabel(phase: Phase, activeImage: number, imageCount: number) {
  const suffix = activeImage ? ` ${activeImage} of ${imageCount}` : "";
  switch (phase) {
    case "hashing":
      return "Checking images…";
    case "preparing":
      return `Preparing view${suffix}…`;
    case "uploading":
      return `Uploading view${suffix}…`;
    case "validating":
      return `Validating view${suffix}…`;
    case "submitting":
      return "Starting scan…";
    default:
      return "Ready to scan";
  }
}

async function uploadOneImageScan(image: PreparedImage, batchId: string) {
  const scan = CreateScanResponseSchema.parse(
    await requestJson("/api/v1/scans", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `scan-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ source: "batch_upload", batchId }),
    }),
  );
  validateAgainstScanLimits([image], scan.limits);

  const signedUpload = SignedUploadSchema.parse(
    await requestJson(`/api/v1/scans/${scan.scanId}/uploads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `upload-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        filename: image.file.name || `${image.viewType}-photo`,
        viewType: image.viewType,
        mimeType: image.mimeType,
        sizeBytes: image.file.size,
        checksumSha256: image.checksumSha256,
      }),
    }),
  );

  await uploadFile(signedUpload, image.file, () => {});

  CompleteImageUploadResponseSchema.parse(
    await requestJson(
      `/api/v1/scans/${scan.scanId}/uploads/${signedUpload.imageId}/complete`,
      {
        method: "POST",
        headers: { "idempotency-key": `complete-${crypto.randomUUID()}` },
      },
    ),
  );

  SubmitScanResponseSchema.parse(
    await requestJson(`/api/v1/scans/${scan.scanId}/submit`, {
      method: "POST",
      headers: { "idempotency-key": `submit-${crypto.randomUUID()}` },
    }),
  );

  return scan.scanId;
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
  const body = (await response.json()) as {
    error?: { message?: string };
  };
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
      else
        reject(new Error("The image upload was rejected. Please try again."));
    });
    request.addEventListener("error", () =>
      reject(new Error("The image upload was interrupted. Please try again.")),
    );
    request.send(file);
  });
}
