import { expect, test, type Page } from "@playwright/test";

type LiveCameraHarness = {
  frame: number;
  getUserMediaCalls: number;
  stoppedTracks: number;
  delayEncoding: boolean;
  submissions: number;
};
declare global {
  interface Window {
    liveCameraHarness: LiveCameraHarness;
  }
}

async function installLiveCameraStub(
  page: Page,
  workerUnavailable = false,
  timerFallback = false,
) {
  await page.addInitScript(
    ({ workerUnavailable, timerFallback }) => {
      const harness = {
        frame: 0,
        getUserMediaCalls: 0,
        stoppedTracks: 0,
        delayEncoding: false,
        submissions: 0,
      };
      Object.defineProperty(window, "liveCameraHarness", { value: harness });
      if (workerUnavailable)
        Object.defineProperty(window, "Worker", { value: undefined });
      Object.defineProperties(HTMLMediaElement.prototype, {
        readyState: { configurable: true, get: () => 4 },
        play: { configurable: true, value: async () => undefined },
        srcObject: {
          configurable: true,
          get: () => null,
          set: () => undefined,
        },
      });
      Object.defineProperties(HTMLVideoElement.prototype, {
        videoWidth: { configurable: true, get: () => 512 },
        videoHeight: { configurable: true, get: () => 512 },
        requestVideoFrameCallback: {
          configurable: true,
          value: (callback: (now: number) => void) =>
            setTimeout(() => callback(performance.now()), 30),
        },
        cancelVideoFrameCallback: {
          configurable: true,
          value: (id: number) => clearTimeout(id),
        },
      });
      if (timerFallback)
        Object.defineProperty(
          HTMLVideoElement.prototype,
          "requestVideoFrameCallback",
          { value: undefined },
        );
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (
        this: CanvasRenderingContext2D,
        ...args: Parameters<typeof draw>
      ) {
        if (!(args[0] instanceof HTMLVideoElement))
          return draw.apply(this, args);
        const { width, height } = this.canvas;
        const data = this.createImageData(width, height);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const inside =
              harness.frame > 0 &&
              x >= width / 4 &&
              x <= (width * 3) / 4 &&
              y >= height / 4 &&
              y <= (height * 3) / 4;
            const art =
              harness.frame === 1
                ? (x * 13 + y * 7) % 60
                : (x * 7 + y * 13) % 60;
            const coarse = (harness.frame === 1 ? x : y) < width / 2 ? 50 : 0;
            const value = inside ? 110 + art + coarse : 15;
            const i = (y * width + x) * 4;
            data.data[i] = data.data[i + 1] = data.data[i + 2] = value;
            data.data[i + 3] = 255;
          }
        this.putImageData(data, 0, 0);
      } as typeof draw;
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        toBlob.call(
          this,
          (blob) => {
            if (harness.delayEncoding) setTimeout(() => callback(blob), 800);
            else callback(blob);
          },
          type,
          quality,
        );
      };
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            harness.getUserMediaCalls++;
            const track = {
              addEventListener: () => undefined,
              stop: () => harness.stoppedTracks++,
            };
            return {
              addEventListener: () => undefined,
              getTracks: () => [track],
              getVideoTracks: () => [track],
            };
          },
        },
      });
    },
    { workerUnavailable, timerFallback },
  );
  page.on("response", (response) => {
    if (
      /\/api\/v1\/scans\/[^/]+\/submit$/.test(response.url()) &&
      response.ok()
    ) {
      void page
        .evaluate(() => window.liveCameraHarness.submissions++)
        .catch(() => {});
    }
  });
}

async function changeFrame(page: Page, frame: number) {
  await page.evaluate((frame) => {
    window.liveCameraHarness.frame = frame;
  }, frame);
}
async function background(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test("candidate capture ignores empty scenes, submits once while held, and accepts a replacement", async ({
  page,
}) => {
  await installLiveCameraStub(page);
  await page.goto("/scan");
  await page.getByRole("button", { name: "Use live camera" }).click();
  await page.waitForTimeout(1200);
  await expect(page.locator(".live-camera__state")).toHaveText(
    "Looking for a cover",
  );
  expect(await page.evaluate(() => window.liveCameraHarness.submissions)).toBe(
    0,
  );
  const croppedCompletion = page.waitForResponse(
    (response) =>
      /\/api\/v1\/scans\/[^/]+\/uploads\/[^/]+\/complete$/.test(
        response.url(),
      ) && response.status() === 200,
  );
  await changeFrame(page, 1);
  expect((await (await croppedCompletion).json()).analysisSource).toBe("crop");
  await expect
    .poll(() => page.evaluate(() => window.liveCameraHarness.submissions))
    .toBe(1);
  await expect(page.locator(".live-camera__state")).toHaveText(
    "Waiting for a new cover",
  );
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.liveCameraHarness.submissions)).toBe(
    1,
  );
  expect(new URL(page.url()).pathname).toBe("/scan");
  await changeFrame(page, 2);
  await expect
    .poll(() => page.evaluate(() => window.liveCameraHarness.submissions))
    .toBe(2);
  await background(page);
  await expect(
    page.getByText(
      "Live capture paused when this page went to the background.",
      { exact: false },
    ),
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

test("removal never captures the background and permits the same artwork again", async ({
  page,
}) => {
  await installLiveCameraStub(page, false, true);
  await page.goto("/scan");
  await page.getByRole("button", { name: "Use live camera" }).click();
  await changeFrame(page, 1);
  await expect
    .poll(() => page.evaluate(() => window.liveCameraHarness.submissions))
    .toBe(1);
  await changeFrame(page, 0);
  await expect(page.locator(".live-camera__state")).toHaveText(
    "Looking for a cover",
  );
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.liveCameraHarness.submissions)).toBe(
    1,
  );
  await changeFrame(page, 1);
  await expect
    .poll(() => page.evaluate(() => window.liveCameraHarness.submissions))
    .toBe(2);
  await page.getByRole("button", { name: "Finish scanning" }).click();
  await page.waitForURL(/\/scans\/batch\/[0-9a-f-]{36}/);
});

test("worker-unavailable browsers keep an explicit manual camera and upload fallback", async ({
  page,
}) => {
  await installLiveCameraStub(page, true);
  await page.goto("/scan");
  await page.getByRole("button", { name: "Use live camera" }).click();
  await changeFrame(page, 1);
  await page.waitForTimeout(900);
  expect(await page.evaluate(() => window.liveCameraHarness.submissions)).toBe(
    0,
  );
  const sourceCompletion = page.waitForResponse(
    (response) =>
      /\/api\/v1\/scans\/[^/]+\/uploads\/[^/]+\/complete$/.test(
        response.url(),
      ) && response.status() === 200,
  );
  await page
    .getByRole("button", { name: "Capture photo", exact: true })
    .click();
  expect((await (await sourceCompletion).json()).analysisSource).toBe("source");
  await expect
    .poll(() => page.evaluate(() => window.liveCameraHarness.submissions))
    .toBe(1);
  await page.getByRole("button", { name: "Scan another copy" }).click();
  await expect
    .poll(() => page.evaluate(() => window.liveCameraHarness.submissions))
    .toBe(2);
  await expect(page.getByLabel("Upload photos")).toBeEnabled();
});

test("pausing during encoding discards the old camera photo", async ({
  page,
}) => {
  await installLiveCameraStub(page);
  await page.goto("/scan");
  await page.getByRole("button", { name: "Use live camera" }).click();
  await page.evaluate(() => {
    window.liveCameraHarness.delayEncoding = true;
    window.liveCameraHarness.frame = 1;
  });
  await expect(page.locator(".live-camera__state")).toHaveText("Captured");
  await background(page);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.liveCameraHarness.submissions)).toBe(
    0,
  );
  await expect(page.locator(".capture-session__record")).toHaveCount(0);
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

test("an authoritative quota rejection pauses capture and leaves the record retryable", async ({
  page,
}) => {
  await installLiveCameraStub(page);
  let quotaBlocked = false;
  await page.route("**/api/v1/quota", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: quotaBlocked
        ? { ...body, admissible: false, blockedBy: "daily_analysis_limit" }
        : body,
    });
  });
  await page.route(/\/api\/v1\/scans\/[^/]+\/submit$/, async (route) => {
    quotaBlocked = true;
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "quota_exceeded", message: "Daily scan limit reached" },
      }),
    });
  });
  await page.goto("/scan");
  await page.getByRole("button", { name: "Use live camera" }).click();
  await changeFrame(page, 1);
  await expect(
    page.getByText("Live capture is paused until scan capacity is available.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.locator('.capture-session__record[data-status="failed"]'),
  ).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Retry" })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Resume live camera" }),
  ).toBeDisabled();
});

test("a finished camera upload remains reviewable after refresh", async ({
  page,
}) => {
  await installLiveCameraStub(page);
  await page.goto("/scan");
  await page.getByRole("button", { name: "Use live camera" }).click();
  await changeFrame(page, 1);
  await expect
    .poll(() => page.evaluate(() => window.liveCameraHarness.submissions))
    .toBe(1);
  await expect(page.locator(".capture-session__record")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByText("1 record submitted so far.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Review them now" }),
  ).toBeVisible();
});
