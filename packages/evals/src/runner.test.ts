import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AlbumIdentifier } from "@vinylhound/ai";

import { runEvaluation } from "./runner.ts";
import { evaluationManifest } from "./test-fixture.ts";

describe("runEvaluation", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("runs a provider through the production schema and checkpoints metrics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vinylhound-eval-"));
    temporaryDirectories.push(directory);
    const manifestPath = join(directory, "manifest.json");
    const outputPath = join(directory, "results", "run.json");
    await writeFile(
      join(directory, "cover.jpg"),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    );
    await writeFile(manifestPath, JSON.stringify(evaluationManifest()), "utf8");

    const result = await runEvaluation({
      manifestPath,
      outputPath,
      apiKey: "not-used-by-the-fake",
      models: ["fake-model"],
      imageDetails: ["high"],
      timeoutMs: 1_000,
      split: "holdout",
      repetitions: 1,
      createIdentifier: () => fakeIdentifier(),
    });

    expect(result).toMatchObject({
      status: "completed",
      configuration: { caseCount: 1, plannedAttempts: 1 },
      aggregates: [
        {
          model: "fake-model",
          attempts: 1,
          rank1AccuracyEndToEnd: 1,
          top3RecallEndToEnd: 1,
          schemaSuccessRate: 1,
        },
      ],
    });
    const checkpoint = JSON.parse(await readFile(outputPath, "utf8")) as {
      status: string;
      attempts: unknown[];
    };
    expect(checkpoint).toMatchObject({ status: "completed" });
    expect(checkpoint.attempts).toHaveLength(1);
  });

  it("runs and aggregates every model/detail matrix cell independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "vinylhound-eval-"));
    temporaryDirectories.push(directory);
    const manifestPath = join(directory, "manifest.json");
    const outputPath = join(directory, "results", "matrix.json");
    await writeFile(
      join(directory, "cover.jpg"),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    );
    await writeFile(manifestPath, JSON.stringify(evaluationManifest()), "utf8");

    const configuredCells: string[] = [];
    const result = await runEvaluation({
      manifestPath,
      outputPath,
      apiKey: "not-used-by-the-fake",
      models: ["gpt-5.6-terra", "gpt-5.6-sol"],
      imageDetails: ["high", "auto"],
      timeoutMs: 1_000,
      split: "holdout",
      repetitions: 1,
      createIdentifier: (model, imageDetail) => {
        configuredCells.push(`${model}/${imageDetail}`);
        return fakeIdentifier(model);
      },
    });

    expect(configuredCells).toEqual([
      "gpt-5.6-terra/high",
      "gpt-5.6-terra/auto",
      "gpt-5.6-sol/high",
      "gpt-5.6-sol/auto",
    ]);
    expect(result).toMatchObject({
      schemaVersion: 2,
      configuration: {
        imageDetails: ["high", "auto"],
        plannedAttempts: 4,
      },
    });
    expect(result.attempts).toHaveLength(4);
    expect(
      result.aggregates.map(({ model, imageDetail, attempts }) => ({
        model,
        imageDetail,
        attempts,
      })),
    ).toEqual([
      { model: "gpt-5.6-terra", imageDetail: "high", attempts: 1 },
      { model: "gpt-5.6-terra", imageDetail: "auto", attempts: 1 },
      { model: "gpt-5.6-sol", imageDetail: "high", attempts: 1 },
      { model: "gpt-5.6-sol", imageDetail: "auto", attempts: 1 },
    ]);
  });
});

function fakeIdentifier(model = "fake-model-2026-08-29"): AlbumIdentifier {
  return {
    async identify() {
      return {
        identification: {
          candidates: [
            {
              artist: "Miles Davis",
              title: "Kind of Blue",
              releaseYear: 1959,
              label: "Columbia",
              catalogNumber: null,
              barcode: null,
              confidence: 0.97,
              evidence: ["Visible text"],
              warnings: [],
            },
          ],
          observations: [],
          needsReviewReasons: [],
        },
        metadata: {
          provider: "openai",
          model,
          promptVersion: "album-identification.v1",
          providerResponseId: "resp_fake",
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        },
      };
    },
  };
}
