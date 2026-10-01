import {
  MAX_COMPONENT_TRACES,
  type DetectorTrace,
  type ProposalTrace,
} from "./detector-diagnostics";

export type Point = { x: number; y: number };
/** Clockwise, starting at the top-left; normalized to the source frame. */
export type Corners = [Point, Point, Point, Point];
export type CoverCandidate = {
  corners: Corners;
  fingerprint: number[];
  quality: number;
};
export type Detection = {
  candidate: CoverCandidate | null;
  reason:
    | "searching"
    | "multiple"
    | "blurry"
    | "ready"
    | "too_small"
    | "clipped"
    | "off_center"
    | "tilted"
    | "weak_boundary"
    | "low_light";
  /** A tentative outline is feedback only; it cannot trigger a capture. */
  outline?: Corners;
  checks?: { boundary: boolean; framing: boolean; detail: boolean };
  signals?: {
    coverage: number;
    edgeSupport: number;
    sharpness: number | null;
    contrast: number | null;
    luminance: number | null;
  };
};
export type DetectorFrame = {
  id: number;
  time: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  diagnostics?: boolean;
};
export type DetectorResult = Detection & {
  id: number;
  time: number;
  diagnostics?: DetectorTrace;
};

function cross(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function area(points: Point[]) {
  return (
    Math.abs(
      points.reduce((sum, a, i) => {
        const b = points[(i + 1) % points.length];
        return sum + a.x * b.y - a.y * b.x;
      }, 0),
    ) / 2
  );
}

function hull(points: Point[]) {
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (ordered: Point[]) => {
    const result: Point[] = [];
    for (const p of ordered) {
      while (
        result.length >= 2 &&
        cross(result.at(-2)!, result.at(-1)!, p) <= 0
      )
        result.pop();
      result.push(p);
    }
    return result.slice(0, -1);
  };
  return [...half(points), ...half([...points].reverse())];
}

function quadrilateral(points: Point[]): Corners | null {
  const polygon = hull(points);
  const hullArea = area(polygon);
  while (polygon.length > 4) {
    let smallest = Infinity;
    let remove = 0;
    for (let i = 0; i < polygon.length; i++) {
      const loss = Math.abs(
        cross(
          polygon[(i + polygon.length - 1) % polygon.length],
          polygon[i],
          polygon[(i + 1) % polygon.length],
        ),
      );
      if (loss < smallest) {
        smallest = loss;
        remove = i;
      }
    }
    polygon.splice(remove, 1);
  }
  if (polygon.length !== 4 || area(polygon) < hullArea * 0.9) return null;
  const start = polygon.reduce(
    (best, p, i) => (p.x + p.y < polygon[best].x + polygon[best].y ? i : best),
    0,
  );
  return [...polygon.slice(start), ...polygon.slice(0, start)] as Corners;
}

/** Perspective mapping from a unit square into a convex quadrilateral. */
export function project(corners: Corners, u: number, v: number): Point {
  const [a, b, c, d] = corners;
  const dx1 = b.x - c.x,
    dx2 = d.x - c.x,
    dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y,
    dy2 = d.y - c.y,
    dy3 = a.y - b.y + c.y - d.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  const g =
    Math.abs(denominator) < 1e-9 ? 0 : (dx3 * dy2 - dx2 * dy3) / denominator;
  const h =
    Math.abs(denominator) < 1e-9 ? 0 : (dx1 * dy3 - dx3 * dy1) / denominator;
  const divisor = g * u + h * v + 1;
  return {
    x: ((b.x - a.x + g * b.x) * u + (d.x - a.x + h * d.x) * v + a.x) / divisor,
    y: ((b.y - a.y + g * b.y) * u + (d.y - a.y + h * d.y) * v + a.y) / divisor,
  };
}

/**
 * Experimental geometry baseline, not an album classifier. Closed, roughly
 * square edges can also belong to a book or monitor. Kept behind a release
 * flag until P5.2's private negative/real-device evaluation selects a detector.
 * Fixed 320px input bounds work and memory; no remote preview-frame calls.
 */
function inspectEdges({ width, height, pixels }: DetectorFrame) {
  if (
    width < 32 ||
    height < 32 ||
    width > 320 ||
    height > 320 ||
    pixels.length !== width * height * 4
  ) {
    throw new Error("Invalid detector frame");
  }
  const length = width * height;
  const gray = new Float32Array(length);
  const strength = new Float32Array(length);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < length; i++)
    gray[i] =
      pixels[i * 4] * 0.299 +
      pixels[i * 4 + 1] * 0.587 +
      pixels[i * 4 + 2] * 0.114;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] +
        gray[i - width + 1] -
        2 * gray[i - 1] +
        2 * gray[i + 1] -
        gray[i + width - 1] +
        gray[i + width + 1];
      const gy =
        -gray[i - width - 1] -
        2 * gray[i - width] -
        gray[i - width + 1] +
        gray[i + width - 1] +
        2 * gray[i + width] +
        gray[i + width + 1];
      // Luminance alone loses edges between similarly bright colors. Combine
      // it with RGB gradients, retaining the original image for crop scoring.
      let gradient = Math.abs(gx) + Math.abs(gy);
      for (let channel = 0; channel < 3; channel++) {
        const at = i * 4 + channel;
        const row = width * 4;
        const cx =
          -pixels[at - row - 4] +
          pixels[at - row + 4] -
          2 * pixels[at - 4] +
          2 * pixels[at + 4] -
          pixels[at + row - 4] +
          pixels[at + row + 4];
        const cy =
          -pixels[at - row - 4] -
          2 * pixels[at - row] -
          pixels[at - row + 4] +
          pixels[at + row - 4] +
          2 * pixels[at + row] +
          pixels[at + row + 4];
        gradient = Math.max(gradient, Math.abs(cx) + Math.abs(cy));
      }
      strength[i] = gradient;
      histogram[Math.min(255, Math.floor(gradient / 8))]++;
    }
  }
  // Two bounded passes: strong boundaries, then a scene-adapted weak-edge
  // pass. Neither bypasses geometry, four-side support, or temporal checks.
  let cumulative = 0,
    percentile = 0;
  for (; percentile < 255; percentile++) {
    cumulative += histogram[percentile];
    if (cumulative >= (width - 2) * (height - 2) * 0.75) break;
  }
  const adaptive = Math.max(32, Math.min(80, percentile * 8 * 0.7));
  return { gray, strength, adaptive };
}

export function detectCover(
  frame: DetectorFrame,
  trace?: DetectorTrace,
): Detection {
  const { width, height } = frame;
  const { gray, strength, adaptive } = inspectEdges(frame);
  const length = width * height;
  const queue = new Int32Array(length);
  const proposals: Array<Detection & { outline: Corners }> = [];
  const proposalIds = new Map<Detection, number>();
  let componentId = 0;
  for (const threshold of [100, adaptive]) {
    const edges = Uint8Array.from(strength, (value) =>
      value >= threshold ? 1 : 0,
    );
    for (let seed = 0; seed < length; seed++) {
      if (!edges[seed]) continue;
      let tail = 1;
      queue[0] = seed;
      edges[seed] = 0;
      const points: Point[] = [];
      for (let head = 0; head < tail; head++) {
        const index = queue[head],
          x = index % width,
          y = Math.floor(index / width);
        // Outer components remain useful without collecting every interior edge.
        points.push({ x, y });
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx,
              ny = y + dy,
              next = ny * width + nx;
            if (
              nx >= 0 &&
              nx < width &&
              ny >= 0 &&
              ny < height &&
              edges[next]
            ) {
              edges[next] = 0;
              queue[tail++] = next;
            }
          }
      }
      const id = ++componentId;
      const record = (
        stage: ProposalTrace["stage"],
        reason: string,
        corners: Corners | null = null,
        detection?: Detection,
      ) => {
        if (!trace) return;
        trace.rejectionCounts[reason] =
          (trace.rejectionCounts[reason] ?? 0) + 1;
        if (trace.components.length >= MAX_COMPONENT_TRACES) {
          trace.omittedComponents++;
          if (!detection) return;
        }
        let left = width,
          top = height,
          right = 0,
          bottom = 0;
        for (const p of points) {
          left = Math.min(left, p.x);
          top = Math.min(top, p.y);
          right = Math.max(right, p.x);
          bottom = Math.max(bottom, p.y);
        }
        const entry: ProposalTrace = {
          id,
          threshold,
          points: points.length,
          bounds: {
            x: left / width,
            y: top / height,
            width: (right - left) / width,
            height: (bottom - top) / height,
          },
          corners:
            (corners?.map((p) => ({ x: p.x / width, y: p.y / height })) as
              Corners | undefined) ?? null,
          stage,
          reason,
          signals: detection?.signals ?? null,
          detail:
            detection?.signals?.sharpness == null
              ? "not_evaluated"
              : detection.checks?.detail
                ? "passed"
                : "failed",
        };
        if (trace.components.length < MAX_COMPONENT_TRACES) trace.components.push(entry);
        // Each proposal consumes >=40 component pixels in one of two <=320px
        // passes: at most 5,120, independently of recording duration.
        if (detection) trace.proposals.push(entry);
      };
      if (points.length < 40) {
        record("component", "too_few_points");
        continue;
      }
      const corners = quadrilateral(points);
      if (!corners) {
        record("quadrilateral", "not_quadrilateral");
        continue;
      }
      const fraction = area(corners) / length;
      if (fraction < 0.025 || fraction > 0.95) {
        record("area", "area_out_of_range", corners);
        continue;
      }
      const clipped =
        fraction > 0.82 ||
        corners.some(
          (p) => p.x < 3 || p.y < 3 || p.x >= width - 3 || p.y >= height - 3,
        );
      const sides = corners.map((p, i) =>
        Math.hypot(p.x - corners[(i + 1) % 4].x, p.y - corners[(i + 1) % 4].y),
      );
      if (
        Math.min(...sides) < 25 ||
        Math.max(...sides) / Math.min(...sides) > 1.65
      ) {
        record("shape", "side_length_or_ratio", corners);
        continue;
      }
      const tilted = corners.some((p, i) => {
        const a = corners[(i + 3) % 4],
          b = corners[(i + 1) % 4];
        const cosine =
          ((a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) /
          (sides[(i + 3) % 4] * sides[i]);
        return Math.abs(cosine) > 0.55;
      });
      const center = project(corners, 0.5, 0.5);
      const offCenter =
        center.x < width * 0.2 ||
        center.x > width * 0.8 ||
        center.y < height * 0.2 ||
        center.y > height * 0.8;
      // Require supported edges along all four sides, not just a convex outline.
      const sideSupport = corners.map((p, i) => {
        const b = corners[(i + 1) % 4];
        let supported = 0;
        for (let t = 1; t < 40; t++) {
          const x = Math.round(p.x + ((b.x - p.x) * t) / 40),
            y = Math.round(p.y + ((b.y - p.y) * t) / 40);
          const at = y * width + x;
          // A 3x3 neighborhood tolerates contour approximation error. Use the
          // same color-aware evidence as boundary discovery, on every side.
          let local = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx,
                ny = y + dy;
              if (nx >= 0 && nx < width && ny >= 0 && ny < height)
                local = Math.max(local, strength[at + dy * width + dx]);
            }
          if (local >= threshold) supported++;
        }
        return supported / 39;
      });
      const edgeSupport = Math.min(...sideSupport);
      const outline = corners.map((p) => ({
        x: p.x / width,
        y: p.y / height,
      })) as Corners;
      const framing =
        !clipped &&
        !offCenter &&
        !tilted &&
        fraction >= 0.14 &&
        Math.min(...sides) >= 60;
      const boundary = !clipped && edgeSupport >= 0.65;
      const reason = clipped
        ? "clipped"
        : !framing && (fraction < 0.14 || Math.min(...sides) < 60)
          ? "too_small"
          : offCenter
            ? "off_center"
            : tilted
              ? "tilted"
              : !boundary
                ? "weak_boundary"
                : null;
      if (reason) {
        proposals.push({
          candidate: null,
          outline,
          reason,
          checks: { boundary, framing, detail: false },
          signals: {
            coverage: fraction,
            edgeSupport,
            sharpness: null,
            contrast: null,
            luminance: null,
          },
        });
        const proposal = proposals.at(-1)!;
        if (trace) proposalIds.set(proposal, id);
        record(
          reason === "weak_boundary" ? "boundary" : "framing",
          reason,
          corners,
          proposal,
        );
        continue;
      }
      const fingerprint: number[] = [];
      let sharpness = 0;
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const p = project(corners, (x + 0.5) / 16, (y + 0.5) / 16);
          const i = Math.round(p.y) * width + Math.round(p.x);
          // Average within each crop cell so tiny motion does not change the
          // fingerprint solely by sampling a different typography/noise pixel.
          let cell = 0;
          for (let sy = 0; sy < 3; sy++)
            for (let sx = 0; sx < 3; sx++) {
              const sample = project(
                corners,
                (x + (sx + 0.5) / 3) / 16,
                (y + (sy + 0.5) / 3) / 16,
              );
              cell += gray[Math.round(sample.y) * width + Math.round(sample.x)];
            }
          fingerprint.push(cell / 9);
          sharpness += Math.abs(
            4 * gray[i] -
              gray[i - 1] -
              gray[i + 1] -
              gray[i - width] -
              gray[i + width],
          );
        }
      const mean =
        fingerprint.reduce((sum, n) => sum + n, 0) / fingerprint.length;
      const deviation = Math.sqrt(
        fingerprint.reduce((sum, n) => sum + (n - mean) ** 2, 0) /
          fingerprint.length,
      );
      const candidate: CoverCandidate = {
        corners: outline,
        fingerprint: fingerprint.map(
          (n) => (n - mean) / Math.max(20, deviation),
        ),
        quality: sharpness / 256,
      };
      proposals.push({
        candidate,
        outline,
        reason:
          candidate.quality < 2
            ? mean < 40
              ? "low_light"
              : "blurry"
            : "ready",
        checks: { boundary, framing, detail: candidate.quality >= 2 },
        signals: {
          coverage: fraction,
          edgeSupport,
          sharpness: candidate.quality,
          contrast: deviation,
          luminance: mean,
        },
      });
      const proposal = proposals.at(-1)!;
      if (trace) proposalIds.set(proposal, id);
      record(
        proposal.reason === "ready" ? "ready" : "detail",
        proposal.reason,
        corners,
        proposal,
      );
    }
  }
  // Nested artwork edges describe the same presentation. Disjoint targets are
  // ambiguous and must never create two records from one frame.
  proposals.sort((a, b) => area(b.outline) - area(a.outline));
  const selected = proposals[0];
  if (trace) {
    trace.selection.rankedIds = proposals.map((p) => proposalIds.get(p)!);
    trace.selection.selectedId = selected ? proposalIds.get(selected)! : null;
    trace.selection.reason = selected ? "largest_area" : "no_proposal";
  }
  if (!selected) return { candidate: null, reason: "searching" };
  const center = project(selected.outline, 0.5, 0.5);
  const vetoes = proposals.slice(1).filter((other) => {
    const p = project(other.outline, 0.5, 0.5);
    return (
      area(other.outline) >= 0.1 &&
      Math.hypot(p.x - center.x, p.y - center.y) > 0.25
    );
  });
  if (vetoes.length) {
    if (trace) {
      trace.selection.vetoIds = vetoes.map((p) => proposalIds.get(p)!);
      trace.selection.reason = "disjoint_veto";
    }
    return { candidate: null, reason: "multiple" };
  }
  // A larger incomplete boundary must block a tempting inner-artwork crop.
  return selected;
}
