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
  reason: "searching" | "multiple" | "blurry" | "ready";
};
export type DetectorFrame = {
  id: number;
  time: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
};
export type DetectorResult = Detection & { id: number; time: number };

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
export function detectCover({
  width,
  height,
  pixels,
}: DetectorFrame): Detection {
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
  const edges = new Uint8Array(length);
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
      if (Math.abs(gx) + Math.abs(gy) >= 100) edges[i] = 1;
    }
  }
  const queue = new Int32Array(length);
  const candidates: CoverCandidate[] = [];
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
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && edges[next]) {
            edges[next] = 0;
            queue[tail++] = next;
          }
        }
    }
    if (points.length < 80) continue;
    const corners = quadrilateral(points);
    if (!corners) continue;
    const fraction = area(corners) / length;
    if (fraction < 0.14 || fraction > 0.82) continue;
    if (
      corners.some(
        (p) => p.x < 3 || p.y < 3 || p.x >= width - 3 || p.y >= height - 3,
      )
    )
      continue;
    const sides = corners.map((p, i) =>
      Math.hypot(p.x - corners[(i + 1) % 4].x, p.y - corners[(i + 1) % 4].y),
    );
    if (
      Math.min(...sides) < 60 ||
      Math.max(...sides) / Math.min(...sides) > 1.45
    )
      continue;
    if (
      corners.some((p, i) => {
        const a = corners[(i + 3) % 4],
          b = corners[(i + 1) % 4];
        const cosine =
          ((a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) /
          (sides[(i + 3) % 4] * sides[i]);
        return Math.abs(cosine) > 0.55;
      })
    )
      continue;
    const center = project(corners, 0.5, 0.5);
    if (
      center.x < width * 0.2 ||
      center.x > width * 0.8 ||
      center.y < height * 0.2 ||
      center.y > height * 0.8
    )
      continue;
    // Require supported edges along all four sides, not just a convex outline.
    const sideSupport = corners.map((p, i) => {
      const b = corners[(i + 1) % 4];
      let supported = 0;
      for (let t = 1; t < 40; t++) {
        const x = Math.round(p.x + ((b.x - p.x) * t) / 40),
          y = Math.round(p.y + ((b.y - p.y) * t) / 40);
        const at = y * width + x;
        if (
          Math.abs(gray[at - 2] - gray[at + 2]) +
            Math.abs(gray[at - width * 2] - gray[at + width * 2]) >=
          25
        )
          supported++;
      }
      return supported / 39;
    });
    if (Math.min(...sideSupport) < 0.65) continue;
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
    const deviation = Math.max(
      20,
      Math.sqrt(
        fingerprint.reduce((sum, n) => sum + (n - mean) ** 2, 0) /
          fingerprint.length,
      ),
    );
    candidates.push({
      corners: corners.map((p) => ({
        x: p.x / width,
        y: p.y / height,
      })) as Corners,
      fingerprint: fingerprint.map((n) => (n - mean) / deviation),
      quality: sharpness / 256,
    });
  }
  // Nested artwork edges describe the same presentation. Disjoint targets are
  // ambiguous and must never create two records from one frame.
  candidates.sort((a, b) => area(b.corners) - area(a.corners));
  const candidate = candidates[0];
  if (!candidate) return { candidate: null, reason: "searching" };
  const center = project(candidate.corners, 0.5, 0.5);
  if (
    candidates.slice(1).some((other) => {
      const p = project(other.corners, 0.5, 0.5);
      return Math.hypot(p.x - center.x, p.y - center.y) > 0.25;
    })
  )
    return { candidate: null, reason: "multiple" };
  return { candidate, reason: candidate.quality < 2 ? "blurry" : "ready" };
}
