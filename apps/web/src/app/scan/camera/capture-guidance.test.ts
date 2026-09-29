import { expect, it } from "vitest";
import { CaptureGuidance, captureGuidance } from "./capture-guidance";

it("waits for a persistent issue before changing instructions", () => {
  const guidance = new CaptureGuidance();
  expect(guidance.inspect("clipped", false, 0)).toBe("searching");
  expect(guidance.inspect("clipped", false, 450)).toBe("clipped");
  expect(guidance.inspect("ready", false, 600)).toBe("clipped");
  expect(guidance.inspect("clipped", false, 750)).toBe("clipped");
  expect(captureGuidance("clipped")).toContain("all four corners");
});

it("offers recovery after searching without timing out into capture", () => {
  const guidance = new CaptureGuidance();
  guidance.inspect("searching", false, 0);
  guidance.inspect("searching", false, 3000);
  expect(guidance.inspect("searching", false, 3450)).toBe("searching_help");
  expect(captureGuidance("searching_help")).toContain("capture manually");
});

it("combines motion feedback with frame quality without overriding a failed frame check", () => {
  const guidance = new CaptureGuidance();
  guidance.inspect("ready", true, 0);
  expect(guidance.inspect("ready", true, 450)).toBe("moving");
  guidance.inspect("too_small", false, 600);
  expect(guidance.inspect("too_small", false, 1050)).toBe("too_small");
});
