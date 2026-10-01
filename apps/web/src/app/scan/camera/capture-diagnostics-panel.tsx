"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { CoverCamera } from "./cover-camera";
import { CaptureDiagnostics } from "./capture-diagnostics";

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Rendered only in development; opt-in state is never persisted. */
export function CaptureDiagnosticsPanel({
  camera,
}: {
  camera: RefObject<CoverCamera | null>;
}) {
  const recorder = useRef<CaptureDiagnostics | null>(null);
  const [raw, setRaw] = useState(false);
  const [revision, setRevision] = useState("");
  const [status, setStatus] = useState<ReturnType<
    CaptureDiagnostics["summary"]
  > | null>(null);
  const [decision, setDecision] = useState("");
  const [cameraAvailable, setCameraAvailable] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setCameraAvailable(camera.current !== null);
      const current = recorder.current;
      if (!current) return;
      setStatus(current.summary());
      setDecision(current.latestDecision);
    }, 500);
    return () => {
      clearInterval(timer);
      recorder.current?.discard();
    };
  }, [camera]);

  function start() {
    if (!camera.current || !revision.trim()) return;
    recorder.current?.discard();
    const next = new CaptureDiagnostics(raw, revision.trim());
    recorder.current = next;
    camera.current.setDiagnostics(next);
    setStatus(next.summary());
    setDecision("");
  }

  return (
    <details>
      <summary>Local capture diagnostics (development)</summary>
      <p>
        Record up to 15 seconds, 16 MiB of raw detector inputs and 2 MiB of
        numeric traces. No diagnostic data is uploaded. Normal accepted captures
        still enter the scan queue. Save exports outside this repository; they
        may contain private surroundings.
      </p>
      <label>
        Running app revision (git commit, plus dirty if modified)
        <input
          value={revision}
          maxLength={100}
          onChange={(e) => setRevision(e.target.value)}
          disabled={status?.active}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={raw}
          disabled={status?.active}
          onChange={(e) => setRaw(e.target.checked)}
        />
        Include private raw frames (unannotated RGBA at detector resolution, up
        to 320px)
      </label>
      <div className="button-row">
        <button
          type="button"
          className="secondary-button"
          onClick={start}
          disabled={status?.active || !revision.trim() || !cameraAvailable}
        >
          Start diagnostic recording
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!status?.active}
          onClick={() => {
            recorder.current?.stop("user_stop");
            setStatus(recorder.current?.summary() ?? null);
          }}
        >
          Stop diagnostic recording
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!status || status.active}
          onClick={() => {
            if (recorder.current)
              download(recorder.current.traceBlob(), "capture-trace.json");
          }}
        >
          Export numeric trace
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!status?.rawFrames || status.active}
          onClick={() => {
            if (recorder.current)
              download(recorder.current.rawBlob(), "capture-frames.vhc");
          }}
        >
          Export private raw frames
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!status}
          onClick={() => {
            recorder.current?.discard();
            recorder.current = null;
            setStatus(null);
            setDecision("");
          }}
        >
          Discard diagnostics
        </button>
      </div>
      <p>
        Start the live camera with automatic capture enabled before recording.
      </p>
      {status ? (
        <p role="status">
          {status.active ? "Recording" : `Stopped: ${status.reason}`};{" "}
          {status.events} events; {status.rawFrames} raw frames;{" "}
          {status.rawBytes} raw bytes; {status.droppedRawFrames} dropped raw
          frames; {status.droppedEvents} dropped events.
        </p>
      ) : null}
      {decision ? (
        <pre
          aria-label="Latest diagnostic decision"
          style={{
            whiteSpace: "pre-wrap",
            maxHeight: "20rem",
            overflow: "auto",
          }}
        >
          {decision}
        </pre>
      ) : null}
    </details>
  );
}
