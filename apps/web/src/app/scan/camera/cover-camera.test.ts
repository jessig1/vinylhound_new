import { afterEach, expect, it, vi } from "vitest";
import { CoverCamera, type CameraPhoto } from "./cover-camera";
import type {
  CoverCandidate,
  DetectorFrame,
  DetectorResult,
} from "./cover-detector";

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
