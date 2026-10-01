import { afterEach, expect, it, vi } from "vitest";
import { CoverCamera, type CameraPhoto } from "./cover-camera";
import type {
  CoverCandidate,
  DetectorFrame,
  DetectorResult,
} from "./cover-detector";
import { CaptureDiagnostics } from "./capture-diagnostics";

const target: CoverCandidate = {
  corners: [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ],
  fingerprint: [0, 1],
  quality: 10,
};

function harness() {
  let callback: ((time: number) => void) | null = null;
  const snapshots: Array<{ width: number; height: number; token: number }> = [];
  const encodings: Array<() => void> = [];
  const photos: CameraPhoto[] = [];
  const error = vi.fn();
  const video = {
    readyState: 4,
    videoWidth: 100,
    videoHeight: 100,
    token: 1,
    requestVideoFrameCallback: (next: (time: number) => void) => {
      callback = next;
      return 1;
    },
    cancelVideoFrameCallback: () => {
      callback = null;
    },
  };
  const worker = {
    onmessage: vi.fn<(event: MessageEvent<DetectorResult>) => void>(),
    onerror: () => {},
    postMessage: vi.fn<(frame: DetectorFrame) => void>(),
    terminate: vi.fn(),
  };
  vi.stubGlobal("Worker", function () {
    return worker;
  });
  vi.stubGlobal("document", {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        token: 0,
        getContext: () => ({
          drawImage: (source: typeof video) => {
            canvas.token = source.token;
            if (source === video) snapshots.push(canvas);
          },
          getImageData: () => ({
            data: new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(
              canvas.token,
            ),
          }),
          createImageData: (w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4),
          }),
          putImageData: (data: { data: Uint8ClampedArray }) => {
            canvas.token = data.data[0];
          },
        }),
        toBlob: (resolve: (blob: Blob) => void) => {
          const token = canvas.token;
          encodings.push(() =>
            resolve(new Blob([String(token)], { type: "image/jpeg" })),
          );
        },
      };
      return canvas;
    },
  });
  const camera = new CoverCamera(
    video as unknown as HTMLVideoElement,
    () => {},
    (photo) => photos.push(photo),
    error,
    () => true,
  );
  camera.start();
  const tick = (time: number) => callback?.(time);
  const respond = (quality = 10, absent = false) => {
    const frame = worker.postMessage.mock.calls.at(-1)![0];
    worker.onmessage({
      data: {
        id: frame.id,
        time: frame.time,
        candidate: absent ? null : { ...target, quality },
        reason: absent ? "searching" : "ready",
      },
    } as MessageEvent<DetectorResult>);
  };
  return {
    camera,
    worker,
    tick,
    respond,
    video,
    photos,
    error,
    snapshots,
    encodings,
  };
}

afterEach(() => vi.unstubAllGlobals());

it("keeps worker jobs serial and releases snapshots during a long empty session", () => {
  const h = harness();
  h.tick(0);
  h.tick(150);
  expect(h.worker.postMessage).toHaveBeenCalledTimes(1);
  expect(h.worker.postMessage.mock.calls[0][0].diagnostics).toBeUndefined();
  h.respond(0, true);
  for (let time = 300; time < 10_000; time += 150) {
    h.tick(time);
    h.respond(0, true);
  }
  expect(h.snapshots.every((frame) => frame.width === 0)).toBe(true);
  expect(h.photos).toHaveLength(0);
  h.camera.stop();
  expect(h.worker.terminate).toHaveBeenCalledOnce();
});

it("encodes the best source and matching crop rather than the newest frame", async () => {
  const h = harness();
  for (let time = 0; time <= 600; time += 150) {
    h.video.token = time === 150 ? 7 : 1;
    h.tick(time);
    h.respond(time === 150 ? 30 : 10);
    expect(
      h.snapshots.filter((frame) => frame.width > 0).length,
    ).toBeLessThanOrEqual(2);
  }
  h.encodings.forEach((resolve) => resolve());
  await vi.waitFor(() => expect(h.photos).toHaveLength(1));
  expect(await h.photos[0].file.text()).toBe("7");
  expect(await h.photos[0].preview.text()).toBe("7");
  expect(h.photos[0].cropped).toBe(true);
  h.camera.stop();
});

it("discards encoded originals and crops when stopped before encoding returns", async () => {
  const h = harness();
  for (let time = 0; time <= 600; time += 150) {
    h.tick(time);
    h.respond();
  }
  h.camera.stop();
  h.encodings.forEach((resolve) => resolve());
  await Promise.resolve();
  await Promise.resolve();
  expect(h.photos).toHaveLength(0);
  expect(h.error).not.toHaveBeenCalled();
});

it.each(["stop", "manual", "failure"] as const)(
  "stops diagnostic recording on %s and releases sampled sources",
  async (action) => {
    const h = harness();
    const recorder = new CaptureDiagnostics(true, "camera-fixture");
    h.camera.setDiagnostics(recorder);
    h.tick(0);
    h.tick(150);
    expect(h.worker.postMessage.mock.calls[0][0].diagnostics).toBe(true);
    if (action === "stop") h.camera.stop();
    if (action === "failure") h.worker.onerror();
    if (action === "manual") {
      const pending = h.camera.manual();
      h.encodings.forEach((resolve) => resolve());
      await pending;
      h.camera.stop();
    }
    expect(recorder.active).toBe(false);
    expect(recorder.summary().reason).toBe(
      action === "failure"
        ? "worker_or_camera_failure"
        : action === "manual"
          ? "manual_capture"
          : "camera_stop",
    );
    expect(h.snapshots.every((s) => s.width === 0)).toBe(true);
    expect(recorder.manifest().events).toContainEqual(
      expect.objectContaining({
        type: "skipped_input",
        payload: { time: 150, reason: "worker_busy" },
      }),
    );
    recorder.discard();
  },
);

it("links automatic capture and visible feedback to the frozen best frame", async () => {
  const h = harness();
  const recorder = new CaptureDiagnostics(false, "camera-fixture");
  h.camera.setDiagnostics(recorder);
  for (let time = 0; time <= 600; time += 150) {
    h.tick(time);
    h.respond(time === 150 ? 30 : 10);
  }
  h.encodings.forEach((resolve) => resolve());
  await vi.waitFor(() => expect(h.photos).toHaveLength(1));
  h.camera.stop();
  const events = recorder.manifest().events;
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "capture_delivered",
      payload: { frameId: 2 },
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "decision",
      payload: expect.objectContaining({
        id: 5,
        tracker: expect.objectContaining({ captureFrameId: 2 }),
        feedback: expect.objectContaining({ phase: "capturing" }),
      }),
    }),
  );
});
