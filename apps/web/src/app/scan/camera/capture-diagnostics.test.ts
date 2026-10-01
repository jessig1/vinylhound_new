import { afterEach, expect, it, vi } from "vitest";
import { CaptureDiagnostics } from "./capture-diagnostics";

const source = {
  cameraWidth: 640,
  cameraHeight: 480,
  sourceWidth: 640,
  sourceHeight: 480,
  capturedAt: "2026-09-30T00:00:00Z",
  mediaTime: 1,
  presentedFrames: 10,
};
const frame = {
  id: 1,
  time: 150,
  width: 2,
  height: 1,
  pixels: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]),
};
const limits = {
  durationMs: 1000,
  rawBytes: 16,
  traceBytes: 10_000,
  events: 10,
};

afterEach(() => vi.useRealTimers());

it("exports exact pre-transfer RGBA separately from numeric traces with replay offsets", async () => {
  const recorder = new CaptureDiagnostics(true, "fixture-revision", limits);
  const input = { ...frame, pixels: frame.pixels.slice() };
  recorder.frame(input, source);
  structuredClone(input.pixels, { transfer: [input.pixels.buffer] });
  recorder.frame({ ...frame, id: 2, time: 600 }, source);
  const binary = await recorder.rawBlob().arrayBuffer();
  const size = new DataView(binary).getUint32(0, true);
  const metadata = JSON.parse(
    new TextDecoder().decode(binary.slice(4, 4 + size)),
  );
  expect(metadata.rawFrames).toEqual([
    { id: 1, offset: 0, length: 8, width: 2, height: 1 },
    { id: 2, offset: 8, length: 8, width: 2, height: 1 },
  ]);
  expect(new Uint8Array(binary.slice(4 + size, 4 + size + 8))).toEqual(
    new Uint8Array(frame.pixels),
  );
  expect(metadata.events[1].payload.intervalMs).toBe(450);
  expect(metadata.events[0].payload.transform.crop).toBeNull();
  const trace = await recorder.traceBlob().text();
  expect(trace).not.toContain('"pixels":[');
  expect(trace).not.toContain('"fingerprint"');
  expect(JSON.parse(trace).appRevision).toBe("fixture-revision");
  recorder.discard();
  expect(recorder.summary().rawBytes).toBe(0);
});

it("caps bytes, reports omitted raw input, and leaves no queued writes", () => {
  const recorder = new CaptureDiagnostics(true, "fixture", limits);
  recorder.frame(frame, source);
  recorder.frame({ ...frame, id: 2 }, source);
  recorder.frame({ ...frame, id: 3 }, source);
  recorder.frame({ ...frame, id: 4 }, source);
  expect(recorder.summary()).toMatchObject({
    active: false,
    reason: "raw_byte_limit",
    rawBytes: 16,
    rawFrames: 2,
    droppedRawFrames: 1,
    queuedWrites: 0,
  });
  expect(recorder.manifest().events).toHaveLength(3);
});

it("stops without another frame callback and bounds numeric trace growth", () => {
  vi.useFakeTimers();
  const recorder = new CaptureDiagnostics(false, "fixture", limits);
  recorder.frame(frame, source);
  vi.advanceTimersByTime(1000);
  expect(recorder.summary()).toMatchObject({
    reason: "duration_limit",
    rawBytes: 0,
  });
  const bounded = new CaptureDiagnostics(false, "fixture", {
    ...limits,
    traceBytes: 100,
  });
  bounded.event("oversize", "x".repeat(200));
  expect(bounded.summary()).toMatchObject({
    reason: "trace_limit",
    events: 0,
    droppedEvents: 1,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("caps event count and preserves terminal reason after late callbacks", () => {
  const recorder = new CaptureDiagnostics(false, "fixture", {
    ...limits,
    events: 1,
  });
  recorder.event("first", {});
  recorder.event("second", {});
  recorder.stop("camera_stop");
  recorder.event("late", {});
  expect(recorder.summary()).toMatchObject({
    reason: "trace_limit",
    events: 1,
    droppedEvents: 1,
  });
});

it("does not export raw frames when their input metadata hits the trace limit", () => {
  const recorder = new CaptureDiagnostics(true, "fixture", {
    ...limits,
    traceBytes: 1,
  });
  recorder.frame(frame, source);
  expect(recorder.summary()).toMatchObject({
    reason: "trace_limit",
    rawFrames: 0,
    rawBytes: 0,
    droppedRawFrames: 1,
  });
});
