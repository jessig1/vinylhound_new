"use client";

import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  CreateScanResponseSchema,
  detectImageMimeType,
  IMAGE_SNIFF_BYTE_LENGTH,
  SignedUploadSchema,
  SubmitScanResponseSchema,
} from "@vinylhound/contracts";

import { Icon } from "../ui";

type Phase =
  "ready" | "hashing" | "preparing" | "uploading" | "validating" | "submitting";

type UploadWorkflow = {
  createKey: string;
  uploadKey: string;
  completeKey: string;
  submitKey: string;
};

export default function ScanPage() {
  const router = useRouter();
  const workflow = useRef<UploadWorkflow | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState<"camera" | "single_upload">(
    "single_upload",
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("ready");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const busy = phase !== "ready";

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  function selectFile(
    event: ChangeEvent<HTMLInputElement>,
    nextSource: "camera" | "single_upload",
  ) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    if (preview) URL.revokeObjectURL(preview);
    setFile(selected);
    setSource(nextSource);
    setPreview(URL.createObjectURL(selected));
    setPhase("ready");
    setUploadProgress(0);
    setError(null);
    workflow.current = null;
  }

  async function identifyAlbum() {
    if (!file || busy) return;
    setError(null);
    const keys =
      workflow.current ??
      (workflow.current = {
        createKey: `scan-${crypto.randomUUID()}`,
        uploadKey: `upload-${crypto.randomUUID()}`,
        completeKey: `complete-${crypto.randomUUID()}`,
        submitKey: `submit-${crypto.randomUUID()}`,
      });

    try {
      setPhase("hashing");
      // File.type comes from the filename extension, so derive the declared
      // MIME type from the file's magic bytes instead; a misnamed file would
      // otherwise fail server-side validation after a full upload.
      const detected = detectImageMimeType(
        new Uint8Array(
          await file.slice(0, IMAGE_SNIFF_BYTE_LENGTH).arrayBuffer(),
        ),
      );
      if (detected.kind !== "supported") {
        throw new Error(
          detected.kind === "heif_like"
            ? "This photo is in HEIC/HEIF format, which is not supported yet. Export or convert it to JPEG and try again."
            : "That file is not a JPEG, PNG, WebP, or GIF image.",
        );
      }
      const checksumSha256 = await sha256(file);

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
      if (
        !scan.limits.acceptedMimeTypes.some(
          (type) => type === detected.mimeType,
        )
      ) {
        throw new Error("Choose a JPEG, PNG, WebP, or GIF image.");
      }
      if (file.size > scan.limits.maxImageSizeBytes) {
        throw new Error("That image is larger than the 10 MB limit.");
      }

      const signedUpload = SignedUploadSchema.parse(
        await requestJson(`/api/v1/scans/${scan.scanId}/uploads`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": keys.uploadKey,
          },
          body: JSON.stringify({
            filename: file.name || "cover-photo",
            mimeType: detected.mimeType,
            sizeBytes: file.size,
            checksumSha256,
          }),
        }),
      );

      setPhase("uploading");
      await uploadFile(signedUpload, file, setUploadProgress);

      setPhase("validating");
      await requestJson(
        `/api/v1/scans/${scan.scanId}/uploads/${signedUpload.imageId}/complete`,
        {
          method: "POST",
          headers: { "idempotency-key": keys.completeKey },
        },
      );

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
      setError(
        caught instanceof Error
          ? caught.message
          : "The scan could not be started. Please try again.",
      );
    }
  }

  return (
    <main className="content-page scan-page">
      <header className="page-heading">
        <div>
          <p className="section-kicker">New scan</p>
          <h1>Let&apos;s identify that record.</h1>
          <p>Start with a clear, straight-on photo of the front cover.</p>
        </div>
      </header>

      <section className="upload-card" aria-busy={busy}>
        {preview && file ? (
          <div className="upload-preview">
            <img alt={`Preview of ${file.name}`} src={preview} />
            <div>
              <span className="status status--success">
                <Icon name="check" size={14} /> {phaseLabel(phase)}
              </span>
              <h2>{file.name || "Cover photo"}</h2>
              <p>
                The result is a candidate for you to review. A cover match does
                not prove a particular pressing.
              </p>
              {phase === "uploading" ? (
                <div className="upload-progress" aria-label="Upload progress">
                  <span style={{ width: `${uploadProgress}%` }} />
                </div>
              ) : null}
              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="button-row">
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={identifyAlbum}
                  type="button"
                >
                  <Icon name="sparkle" size={18} />
                  {busy ? phaseLabel(phase) : "Identify album"}
                </button>
                <label
                  className={`secondary-button${busy ? " is-disabled" : ""}`}
                >
                  Choose another
                  <input
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    disabled={busy}
                    onChange={(event) => selectFile(event, "single_upload")}
                    type="file"
                  />
                </label>
              </div>
            </div>
          </div>
        ) : (
          <>
            <span className="upload-card__icon">
              <Icon name="camera" size={28} />
            </span>
            <h2>Add a cover photo</h2>
            <p>Use your camera or select an image from this device.</p>
            <div className="button-row">
              <label className="primary-button">
                <Icon name="camera" size={18} /> Take a photo
                <input
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  capture="environment"
                  onChange={(event) => selectFile(event, "camera")}
                  type="file"
                />
              </label>
              <label className="secondary-button">
                <Icon name="upload" size={18} /> Upload image
                <input
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={(event) => selectFile(event, "single_upload")}
                  type="file"
                />
              </label>
            </div>
            <small>JPEG, PNG, WebP, or GIF · Up to 10 MB</small>
          </>
        )}
      </section>

      <aside className="scan-tip">
        <Icon name="info" size={20} />
        <div>
          <strong>For the best match</strong>
          <p>
            Avoid glare, keep all four corners visible, and include the spine or
            label when the edition matters.
          </p>
        </div>
      </aside>
    </main>
  );
}

function phaseLabel(phase: Phase) {
  switch (phase) {
    case "hashing":
      return "Checking image…";
    case "preparing":
      return "Preparing upload…";
    case "uploading":
      return "Uploading…";
    case "validating":
      return "Validating image…";
    case "submitting":
      return "Starting scan…";
    default:
      return "Ready to scan";
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
