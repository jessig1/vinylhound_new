// Non-billable synthetic browser check. Uses the existing Playwright/esbuild install.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cameraPath = "apps/web/src/app/scan/camera/";
const bundle = async (options) =>
  (
    await build({
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: "esm",
      tsconfigRaw: {},
      ...options,
    })
  ).outputFiles[0].text;
const worker = await bundle({
  entryPoints: [cameraPath + "cover-detector.worker.ts"],
});
const client = await bundle({
  stdin: {
    resolveDir: root,
    contents: `
import { CoverCamera } from "./${cameraPath}cover-camera.ts";
import { CaptureDiagnostics } from "./${cameraPath}capture-diagnostics.ts";
import { detectCover } from "./${cameraPath}cover-detector.ts";
import { createDetectorTrace } from "./${cameraPath}detector-diagnostics.ts";
window.run = async () => {
  const canvas = document.querySelector("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const pixels = context.createImageData(320, 240);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
    const inside = x >= 80 && x <= 240 && y >= 40 && y <= 200;
    const value = inside ? 150 + (x * 13 + y * 7) % 50 : 15;
    const at = (y * 320 + x) * 4;
    pixels.data.set([value, value, value, 255], at);
  }
  context.putImageData(pixels, 0, 0);
  const input = { id: 1, time: 0, width: 320, height: 240, pixels: pixels.data };
  for (let i = 0; i < 30; i++) detectCover(input);
  const times = { off: [], trace: [], raw: [] };
  for (let i = 0; i < 100; i++) for (const mode of i % 2 ? ["off", "trace", "raw"] : ["raw", "trace", "off"]) {
    const recorder = mode === "off" ? null : new CaptureDiagnostics(mode === "raw", "synthetic-benchmark");
    const started = performance.now();
    const trace = recorder ? createDetectorTrace() : undefined;
    recorder?.frame(input, {cameraWidth:320,cameraHeight:240,sourceWidth:320,sourceHeight:240,capturedAt:new Date().toISOString(),mediaTime:null,presentedFrames:null});
    const result = detectCover(input, trace);
    recorder?.event("decision", {id:1, reason:result.reason, detector:trace});
    times[mode].push(performance.now() - started);
    recorder?.discard();
  }
  const timing = Object.fromEntries(Object.entries(times).map(([mode, values]) => {
    values.sort((a,b) => a-b);
    return [mode, {count:values.length,p50Ms:values[49],p95Ms:values[94]}];
  }));
  const video = document.querySelector("video");
  const stream = canvas.captureStream(30);
  video.srcObject = stream;
  await video.play();
  const painting = setInterval(() => context.putImageData(pixels, 0, 0), 30);
  const recorder = new CaptureDiagnostics(true, "synthetic-browser");
  const feedback = [];
  let photos = 0, error = false;
  const camera = new CoverCamera(video, value => feedback.push(value), () => photos++, () => error = true, () => true);
  camera.setDiagnostics(recorder);
  camera.start();
  try {
    const deadline = performance.now() + 6000;
    while (!photos && !error && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    camera.stop();
    const exported = await recorder.rawBlob().arrayBuffer();
    const size = new DataView(exported).getUint32(0, true);
    const manifest = JSON.parse(new TextDecoder().decode(exported.slice(4, 4 + size)));
    const replay = manifest.rawFrames.map(frame => {
      const event = manifest.events.find(e => e.type === "decision" && e.payload.id === frame.id);
      const data = new Uint8ClampedArray(exported.slice(4 + size + frame.offset, 4 + size + frame.offset + frame.length));
      return !event || detectCover({id:frame.id,time:event.payload.time,width:frame.width,height:frame.height,pixels:data}).reason === event.payload.reason;
    });
    for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
      const value = x <= 150 && y >= 40 && y <= 190 ? 150 + (x * 13 + y * 7) % 50 : 15;
      pixels.data.set([value,value,value,255], (y * 320 + x) * 4);
    }
    context.putImageData(pixels, 0, 0);
    const rejected = new CaptureDiagnostics(true, "synthetic-clipped");
    const rejectedFeedback = [];
    let rejectedPhotos = 0;
    const second = new CoverCamera(video, value => rejectedFeedback.push(value), () => rejectedPhotos++, () => error = true, () => true);
    second.setDiagnostics(rejected);
    second.start();
    let rejection;
    try {
      await new Promise(resolve => setTimeout(resolve, 1100));
      second.stop();
      const rejectedTrace = rejected.manifest();
      const decision = rejectedTrace.events.find(event => event.type === "decision" && event.payload.reason === "clipped")?.payload;
      const selected = decision?.detector.components.find(component => component.id === decision.detector.selection.selectedId);
      rejection = {photos:rejectedPhotos,frameRecorded:rejectedTrace.rawFrames.some(frame => frame.id === decision?.id),stage:selected?.stage,detail:selected?.detail,feedback:rejectedFeedback.some(value => value.reason === "clipped")};
    } finally { second.stop(); rejected.discard(); }
    return {timing,photos,error,rejection,replayMatches:replay.every(Boolean),summary:manifest.summary,
      decisions:manifest.events.filter(e => e.type === "decision").length,
      capture:manifest.events.find(e => e.type === "capture_delivered")?.payload,
      inputs:manifest.rawFrames.map(frame => frame.id),
      readyFeedback:feedback.some(value => value.phase === "capturing")};
  } finally { camera.stop(); recorder.discard(); clearInterval(painting); stream.getTracks().forEach(track => track.stop()); }
};`,
  },
});
const server = createServer((request, response) => {
  const body =
    request.url === "/client.js"
      ? client
      : request.url === "/cover-detector.worker.ts"
        ? worker
        : '<canvas width="320" height="240"></canvas><video muted playsinline></video><script type="module" src="/client.js"></script>';
  response.setHeader(
    "content-type",
    request.url === "/" ? "text/html" : "text/javascript",
  );
  response.end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => typeof globalThis.run === "function");
  const result = await page.evaluate(() => globalThis.run());
  assert.equal(result.error, false);
  assert.equal(result.photos, 1);
  assert.equal(result.replayMatches, true);
  assert.equal(result.readyFeedback, true);
  assert.deepEqual(result.rejection, {
    photos: 0,
    frameRecorded: true,
    stage: "framing",
    detail: "not_evaluated",
    feedback: true,
  });
  assert.ok(result.decisions >= 5);
  assert.ok(result.inputs.includes(result.capture.frameId));
  console.log(
    JSON.stringify({ browser: await browser.version(), ...result }, null, 2),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
