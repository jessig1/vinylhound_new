import type { Corners, Detection } from "./cover-detector";

// Bump when detection/preprocessing policy changes, even without a model change.
export const DETECTOR_VERSION = "geometry-rgb-v1";
export const CAPTURE_CONFIG_VERSION = "320px-150ms-hold600-v1";
export const MAX_COMPONENT_TRACES = 256;

export type ProposalTrace = {
  id: number;
  threshold: number;
  points: number;
  bounds: { x: number; y: number; width: number; height: number };
  corners: Corners | null;
  stage:
    | "component"
    | "quadrilateral"
    | "area"
    | "shape"
    | "framing"
    | "boundary"
    | "detail"
    | "ready";
  reason: string;
  signals: Detection["signals"] | null;
  detail: "not_evaluated" | "passed" | "failed";
};

export type DetectorTrace = {
  version: typeof DETECTOR_VERSION;
  processingMs: number;
  components: ProposalTrace[];
  /** All selectable/rejected proposals, even when early-component detail is capped. */
  proposals: ProposalTrace[];
  omittedComponents: number;
  rejectionCounts: Record<string, number>;
  selection: {
    policy: "largest-area-then-disjoint-veto";
    rankedIds: number[];
    selectedId: number | null;
    vetoIds: number[];
    reason: "no_proposal" | "largest_area" | "disjoint_veto";
  };
};

export function createDetectorTrace(): DetectorTrace {
  return {
    version: DETECTOR_VERSION,
    processingMs: 0,
    components: [],
    proposals: [],
    omittedComponents: 0,
    rejectionCounts: {},
    selection: {
      policy: "largest-area-then-disjoint-veto",
      rankedIds: [],
      selectedId: null,
      vetoIds: [],
      reason: "no_proposal",
    },
  };
}
