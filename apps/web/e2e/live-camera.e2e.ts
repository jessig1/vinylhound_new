import { expect, test, type Page } from "@playwright/test";

type LiveCameraHarness = {
  frame: number;
  getUserMediaCalls: number;
  stoppedTracks: number;
  states: string[];
};

async function installLiveCameraStub(page: Page) {
  await page.addInitScript(() => {
    const harness = {
      frame: 0,
      getUserMediaCalls: 0,
      stoppedTracks: 0,
      states: [] as string[],
    };
    Object.defineProperty(window, "liveCameraHarness", {
      configurable: true,
      value: harness,
    });

    const observer = new MutationObserver(() => {
      const state = document.querySelector(".live-camera__state")?.textContent;
      if (state && harness.states.at(-1) !== state) harness.states.push(state);
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
    });

    Object.defineProperties(HTMLMediaElement.prototype, {
      readyState: { configurable: true, get: () => 4 },
      videoWidth: { configurable: true, get: () => 512 },
      videoHeight: { configurable: true, get: () => 512 },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value: async () => undefined,
    });
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get: () => null,
      set: () => undefined,
    });

    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () =>
        ({
          drawImage: () => undefined,
          getImageData: () =>
            ({
              data: new Uint8ClampedArray(96 * 96 * 4).fill(harness.frame),
            }) as ImageData,
        }) as unknown as CanvasRenderingContext2D,
    });
    HTMLCanvasElement.prototype.toBlob = (callback) =>
      callback(
        new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }),
      );

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          harness.getUserMediaCalls += 1;
          const track = {
            addEventListener: () => undefined,
            stop: () => {
              harness.stoppedTracks += 1;
            },
          };
          return {
            addEventListener: () => undefined,
            getTracks: () => [track],
            getVideoTracks: () => [track],
          } as unknown as MediaStream;
        },
      },
    });
  });
}

declare global {
  interface Window {
    liveCameraHarness: LiveCameraHarness;
  }
}

test("live camera captures once while held, rearms after change, and resumes after a pause", async ({
  page,
}) => {
  await installLiveCameraStub(page);
  await page.goto("/scan");

  await page.getByRole("button", { name: "Use live camera" }).click();
  await expect(page.getByText("1 record in this session")).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.locator(".live-camera__state")).toHaveText("Waiting");

  // A steady cover remains disarmed, so the sampler cannot add another record.
  await page.waitForTimeout(1_000);
  await expect(page.getByText("1 record in this session")).toBeVisible();

  // A materially different frame must pass through rearmed before a new steady
  // cover can be captured.
  await page.evaluate(() => {
    window.liveCameraHarness.frame = 255;
  });
  await expect(page.getByText("2 records in this session")).toBeVisible({
    timeout: 5_000,
  });
  const states = await page.evaluate(() => window.liveCameraHarness.states);
  expect(states).toContain("Re-armed");

  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    page.getByText("Live camera paused while the app was in the background."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume live camera" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.liveCameraHarness.stoppedTracks))
    .toBeGreaterThan(0);

  await page.getByRole("button", { name: "Resume live camera" }).click();
  await expect(
    page.getByRole("button", { name: "Stop live camera" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.liveCameraHarness.getUserMediaCalls))
    .toBe(2);
});

test("live-camera permission denial preserves the file-upload fallback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => {
          throw new DOMException("Denied", "NotAllowedError");
        },
      },
    });
  });
  await page.goto("/scan");

  await page.getByRole("button", { name: "Use live camera" }).click();
  await expect(page.locator(".form-error")).toContainText(
    "couldn't open the camera",
  );
  await expect(page.getByLabel("Upload photos")).toBeEnabled();
});
