import {
  detectCover,
  type DetectorFrame,
  type DetectorResult,
} from "./cover-detector";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<DetectorFrame>) => void;
  postMessage: (result: DetectorResult) => void;
};
scope.onmessage = ({ data }) => {
  scope.postMessage({ id: data.id, time: data.time, ...detectCover(data) });
};
