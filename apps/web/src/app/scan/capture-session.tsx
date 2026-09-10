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
  GetQuotaHeadroomResponseSchema,
  IMAGE_SNIFF_BYTE_LENGTH,
  type ImageMimeType,
  MAX_SCANS_PER_BATCH,
  type QuotaHeadroomReason,
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

type QuotaState =
  | { status: "unknown" }
  | { status: "ok" }
  | {
      status: "blocked";
      blockedBy: QuotaHeadroomReason | null;
      message: string;
    };

type LiveCameraState = "off" | "armed" | "captured" | "disarmed" | "rearmed";

const LIVE_CAPTURE_SAMPLE_MS = 250;
const LIVE_CAPTURE_STABLE_SAMPLES = 4;
const LIVE_CAPTURE_CHANGE_SAMPLES = 2;
const LIVE_CAPTURE_STABLE_DELTA = 7;
const LIVE_CAPTURE_CHANGE_DELTA = 18;

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
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const cameraCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cameraRequestRef = useRef(0);
  const cameraStateRef = useRef<LiveCameraState>("off");
  const priorCameraFrameRef = useRef<Uint8ClampedArray | null>(null);
  const capturedCameraFrameRef = useRef<Uint8ClampedArray | null>(null);
  const stableSamplesRef = useRef(0);
  const changedSamplesRef = useRef(0);
  const submittedCountRef = useRef(0);
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
  const [quota, setQuota] = useState<QuotaState>({ status: "unknown" });
  const [cameraState, setCameraState] = useState<LiveCameraState>("off");
  const [cameraError, setCameraError] = useState<string | null>(null);

  const refreshQuota = useRef(async () => {
    try {
      const headroom = GetQuotaHeadroomResponseSchema.parse(
        await requestJson("/api/v1/quota", { method: "GET" }),
      );
      setQuota(
        headroom.admissible
          ? { status: "ok" }
          : {
              status: "blocked",
              blockedBy: headroom.blockedBy,
              message: quotaBlockedMessage(headroom.blockedBy),
            },
      );
    } catch {
      // Best-effort UX signal only; a failed check must never block the
      // session, since submit/retry remain the real, authoritative gate.
      setQuota({ status: "unknown" });
    }
  }).current;

  useEffect(() => {
    void refreshQuota();
  }, [refreshQuota]);

  // Advisory headroom can free up on its own (an active scan finishes, a
  // day/budget window rolls over); poll for that instead of retrying the
  // blocked action itself, so a still-exhausted quota never turns into a
  // tight request loop.
  useEffect(() => {
    if (quota.status !== "blocked" || sessionRunning) return;
    const interval = setInterval(() => void refreshQuota(), 20_000);
    return () => clearInterval(interval);
  }, [quota.status, sessionRunning, refreshQuota]);

  useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  useEffect(() => {
    submittedCountRef.current = submittedCount;
  }, [submittedCount]);

  useEffect(
    () => () => {
      stopLiveCamera();
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

  function setLiveCameraState(next: LiveCameraState) {
    cameraStateRef.current = next;
    setCameraState(next);
  }

  function stopLiveCamera() {
    cameraRequestRef.current += 1;
    if (cameraTimerRef.current) {
      clearInterval(cameraTimerRef.current);
      cameraTimerRef.current = null;
    }
    for (const track of cameraStreamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    cameraStreamRef.current = null;
    priorCameraFrameRef.current = null;
    capturedCameraFrameRef.current = null;
    stableSamplesRef.current = 0;
    changedSamplesRef.current = 0;
    setLiveCameraState("off");
  }

  async function startLiveCamera() {
    if (sessionRunning || cameraStateRef.current !== "off") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError(
        "Live camera capture is not supported in this browser. You can still upload photos.",
      );
      return;
    }
    const requestId = ++cameraRequestRef.current;
    setCameraError(null);
    // Mount the viewfinder before permission resolves, so the stream can be
    // attached immediately after the user grants access.
    setLiveCameraState("armed");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      if (requestId !== cameraRequestRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      cameraStreamRef.current = stream;
      // A previously granted permission can resolve immediately. Give React a
      // frame to mount the viewfinder that was enabled just before the request.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (requestId !== cameraRequestRef.current) return;
      const video = cameraVideoRef.current;
      if (!video) {
        stopLiveCamera();
        return;
      }
      video.srcObject = stream;
      await video.play();
      if (requestId !== cameraRequestRef.current) return;
      cameraTimerRef.current = setInterval(
        inspectLiveCameraFrame,
        LIVE_CAPTURE_SAMPLE_MS,
      );
    } catch {
      if (requestId !== cameraRequestRef.current) return;
      stopLiveCamera();
      setCameraError(
        "We couldn't open the camera. Check permission, then try again or upload a photo instead.",
      );
    }
  }

  function inspectLiveCameraFrame() {
    const video = cameraVideoRef.current;
    const canvas = cameraCanvasRef.current;
    if (
      !video ||
      !canvas ||
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      !video.videoWidth ||
      !video.videoHeight
    ) {
      return;
    }
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    canvas.width = 96;
    canvas.height = 96;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const state = cameraStateRef.current;

    if (state === "disarmed") {
      const capturedFrame = capturedCameraFrameRef.current;
      if (
        capturedFrame &&
        cameraFrameDifference(frame, capturedFrame) >= LIVE_CAPTURE_CHANGE_DELTA
      ) {
        changedSamplesRef.current += 1;
        if (changedSamplesRef.current >= LIVE_CAPTURE_CHANGE_SAMPLES) {
          priorCameraFrameRef.current = frame;
          stableSamplesRef.current = 0;
          changedSamplesRef.current = 0;
          setLiveCameraState("rearmed");
          window.setTimeout(() => {
            if (cameraStateRef.current === "rearmed")
              setLiveCameraState("armed");
          }, LIVE_CAPTURE_SAMPLE_MS);
        }
      } else {
        changedSamplesRef.current = 0;
      }
      return;
    }
    if (state !== "armed") return;

    const priorFrame = priorCameraFrameRef.current;
    priorCameraFrameRef.current = frame;
    if (!priorFrame) return;
    if (cameraFrameDifference(frame, priorFrame) <= LIVE_CAPTURE_STABLE_DELTA) {
      stableSamplesRef.current += 1;
      if (stableSamplesRef.current >= LIVE_CAPTURE_STABLE_SAMPLES) {
        stableSamplesRef.current = 0;
        capturedCameraFrameRef.current = frame;
        setLiveCameraState("captured");
        void captureLiveCameraFrame();
      }
    } else {
      stableSamplesRef.current = 0;
    }
  }

  async function captureLiveCameraFrame() {
    const video = cameraVideoRef.current;
    const canvas = cameraCanvasRef.current;
    if (!video || !canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob || cameraStateRef.current !== "captured") return;
    if (
      recordsRef.current.length + submittedCountRef.current >=
      MAX_SCANS_PER_BATCH
    ) {
      setCameraError(
        `A capture session can include up to ${MAX_SCANS_PER_BATCH} records. Start or review this session before capturing more.`,
      );
      setLiveCameraState("disarmed");
      return;
    }
    const file = new File(
      [blob],
      `live-cover-${new Date().toISOString().replaceAll(":", "-")}.jpg`,
      { type: "image/jpeg" },
    );
    pendingCountRef.current += 1;
    setRecords((current) => [...current, createIdleRecord(file)]);
    setLiveCameraState("disarmed");
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
      if (
        caught instanceof ApiRequestError &&
        caught.code === "quota_exceeded"
      ) {
        // Advisory admission can pass and still lose the race to the
        // authoritative check at submit; refresh the banner rather than
        // silently retrying, so the user sees why and when it may clear.
        void refreshQuota();
      }
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

      {quota.status === "blocked" ? (
        <p className="capture-session__quota-banner" role="status">
          {quota.message}
        </p>
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
          {cameraState === "off" ? (
            <button
              className="secondary-button"
              disabled={sessionRunning}
              onClick={() => void startLiveCamera()}
              type="button"
            >
              <Icon name="camera" size={18} /> Use live camera
            </button>
          ) : (
            <button
              className="secondary-button"
              onClick={stopLiveCamera}
              type="button"
            >
              Stop live camera
            </button>
          )}
        </div>

        {cameraState !== "off" ? (
          <section className="live-camera" aria-label="Live camera capture">
            <div className="live-camera__viewfinder">
              <video autoPlay muted playsInline ref={cameraVideoRef} />
              <span
                className={`live-camera__state live-camera__state--${cameraState}`}
              >
                {liveCameraStateLabel(cameraState)}
              </span>
            </div>
            <p aria-live="polite">{liveCameraStateMessage(cameraState)}</p>
            <canvas
              aria-hidden="true"
              className="live-camera__canvas"
              ref={cameraCanvasRef}
            />
          </section>
        ) : null}

        {cameraError ? (
          <p className="form-error" role="alert">
            {cameraError}
          </p>
        ) : null}

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
                disabled={
                  sessionRunning || !canStart || quota.status === "blocked"
                }
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

function liveCameraStateLabel(state: LiveCameraState) {
  switch (state) {
    case "armed":
      return "Armed";
    case "captured":
      return "Captured";
    case "disarmed":
      return "Waiting for a new cover";
    case "rearmed":
      return "Rearmed";
    case "off":
      return "Off";
  }
}

function liveCameraStateMessage(state: LiveCameraState) {
  switch (state) {
    case "armed":
      return "Hold a front cover steady in the frame. It will be added once, then the camera waits for a change.";
    case "captured":
      return "Cover captured. Keep moving to the next cover before another capture.";
    case "disarmed":
      return "This cover is already captured. Move it out of frame or show a different cover to rearm.";
    case "rearmed":
      return "New framing detected. Ready for the next cover.";
    case "off":
      return "";
  }
}

function cameraFrameDifference(
  first: Uint8ClampedArray,
  second: Uint8ClampedArray,
) {
  const stride = 16;
  let total = 0;
  let samples = 0;
  for (let index = 0; index < first.length; index += stride) {
    total +=
      Math.abs(first[index] - second[index]) +
      Math.abs(first[index + 1] - second[index + 1]) +
      Math.abs(first[index + 2] - second[index + 2]);
    samples += 3;
  }
  return total / samples;
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

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function requestJson(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const body = (await response.json()) as {
    error?: { code?: string; message?: string };
  };
  if (!response.ok) {
    throw new ApiRequestError(
      body.error?.message ?? "The request could not be completed.",
      body.error?.code,
    );
  }
  return body;
}

function quotaBlockedMessage(reason: QuotaHeadroomReason | null) {
  switch (reason) {
    case "active_scan_limit":
      return "You already have the maximum number of scans in progress. New records will wait until one finishes.";
    case "daily_analysis_limit":
      return "You've reached today's scan limit. Capture will resume after it resets.";
    case "monthly_spend_limit":
      return "This would exceed your monthly analysis budget. Capture will resume after the budget period resets.";
    default:
      return "Capacity is limited right now. Please try again shortly.";
  }
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
