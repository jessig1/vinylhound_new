import {
  detectCover,
  type DetectorFrame,
  type DetectorResult,
} from "./cover-detector";
import { createDetectorTrace } from "./detector-diagnostics";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<DetectorFrame>) => void;
  postMessage: (result: DetectorResult) => void;
};
scope.onmessage = ({ data }) => {
  const trace = data.diagnostics ? createDetectorTrace() : undefined;
  const started = performance.now();
  const result = detectCover(data, trace);
  if (trace) trace.processingMs = performance.now() - started;
  scope.postMessage({
    id: data.id,
    time: data.time,
    ...result,
    ...(trace ? { diagnostics: trace } : {}),
  });
};
