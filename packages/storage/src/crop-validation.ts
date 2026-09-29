import type { CropProvenance } from "@vinylhound/contracts";
import { ImageValidationError } from "./image-validation.ts";

/** Checks the claimed source-space transform before a crop can become input. */
export function validateCropGeometry(
  crop: CropProvenance,
  source: { width: number; height: number },
) {
  if (
    crop.sourceWidth !== source.width ||
    crop.sourceHeight !== source.height
  ) {
    throw new ImageValidationError(
      "invalid_image",
      "The crop source dimensions do not match the uploaded photo.",
    );
  }
  const points = crop.corners;
  // Convex, consistently wound corners reject crossed or collapsed quads.
  const turns = points.map((point, i) => {
    const next = points[(i + 1) % 4]!;
    const after = points[(i + 2) % 4]!;
    return (
      (next.x - point.x) * (after.y - next.y) -
      (next.y - point.y) * (after.x - next.x)
    );
  });
  const signedArea =
    points.reduce((sum, point, i) => {
      const next = points[(i + 1) % 4]!;
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2;
  if (turns.some((turn) => turn <= 0.001) || signedArea < 0.08) {
    throw new ImageValidationError(
      "invalid_image",
      "The crop boundary is not a valid cover quadrilateral.",
    );
  }
  const now = Date.now();
  const captured = Date.parse(crop.capturedAt);
  if (!Number.isFinite(captured) || captured > now + 5 * 60_000) {
    throw new ImageValidationError(
      "invalid_image",
      "The capture time is invalid.",
    );
  }
}
