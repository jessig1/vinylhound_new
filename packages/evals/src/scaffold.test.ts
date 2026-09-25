import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scaffoldManifest } from "./scaffold.ts";
import { EvaluationManifestSchema } from "./manifest.ts";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vh-evals-scaffold-"));
  cleanupDirs.push(dir);
  return dir;
}

describe("scaffoldManifest", () => {
  it("creates a new manifest with one blank case per discovered image", async () => {
    const root = await tempDir();
    const imageRoot = join(root, "images");
    await mkdir(imageRoot, { recursive: true });
    await writeFile(join(imageRoot, "a.jpg"), "fake");
    await writeFile(join(imageRoot, "b.png"), "fake");
    await writeFile(join(imageRoot, "notes.txt"), "ignored");
    const manifestPath = join(root, "manifest.json");

    const result = await scaffoldManifest({ manifestPath, imageRoot });

    expect(result.addedCaseIds).toEqual(["vh-001", "vh-002"]);
    expect(result.manifest.cases.map((item) => item.image)).toEqual([
      "a.jpg",
      "b.png",
    ]);
    expect(result.unlabeledCaseIds).toEqual(["vh-001", "vh-002"]);
    for (const evaluationCase of result.manifest.cases) {
      expect(evaluationCase.groundTruth.maintainerVerified).toBe(false);
      expect(evaluationCase.consent.allowedForPrivateEvaluation).toBeNull();
    }

    const onDisk = EvaluationManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    expect(onDisk.cases).toHaveLength(2);
  });

  it("is idempotent and never overwrites labeled cases on rerun", async () => {
    const root = await tempDir();
    const imageRoot = join(root, "images");
    await mkdir(imageRoot, { recursive: true });
    await writeFile(join(imageRoot, "a.jpg"), "fake");
    const manifestPath = join(root, "manifest.json");

    const first = await scaffoldManifest({ manifestPath, imageRoot });
    expect(first.addedCaseIds).toEqual(["vh-001"]);

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.cases[0].groundTruth.artist = "Miles Davis";
    manifest.cases[0].groundTruth.title = "Kind of Blue";
    manifest.cases[0].groundTruth.expectedOutcome = "identify";
    manifest.cases[0].groundTruth.maintainerVerified = true;
    manifest.cases[0].consent.allowedForPrivateEvaluation = true;
    manifest.cases[0].split = "development";
    manifest.cases[0].viewType = "front";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const second = await scaffoldManifest({ manifestPath, imageRoot });

    expect(second.addedCaseIds).toEqual([]);
    expect(second.manifest.cases).toHaveLength(1);
    expect(second.manifest.cases[0].groundTruth.artist).toBe("Miles Davis");
    expect(second.unlabeledCaseIds).toEqual([]);
  });

  it("adds new cases with continued numbering alongside existing ones", async () => {
    const root = await tempDir();
    const imageRoot = join(root, "images");
    await mkdir(imageRoot, { recursive: true });
    await writeFile(join(imageRoot, "a.jpg"), "fake");
    const manifestPath = join(root, "manifest.json");
    await scaffoldManifest({ manifestPath, imageRoot });

    await writeFile(join(imageRoot, "b.jpg"), "fake");
    const second = await scaffoldManifest({ manifestPath, imageRoot });

    expect(second.addedCaseIds).toEqual(["vh-002"]);
    expect(second.manifest.cases.map((item) => item.caseId)).toEqual([
      "vh-001",
      "vh-002",
    ]);
  });

  it("discovers images in subdirectories with posix-style relative paths", async () => {
    const root = await tempDir();
    const imageRoot = join(root, "images");
    await mkdir(join(imageRoot, "session-1"), { recursive: true });
    await writeFile(join(imageRoot, "session-1", "front.jpg"), "fake");
    const manifestPath = join(root, "manifest.json");

    const result = await scaffoldManifest({ manifestPath, imageRoot });

    expect(result.manifest.cases[0].image).toBe("session-1/front.jpg");
  });

  it("throws when the image root has no supported images and no manifest exists", async () => {
    const root = await tempDir();
    const imageRoot = join(root, "images");
    await mkdir(imageRoot, { recursive: true });
    await writeFile(join(imageRoot, "notes.txt"), "ignored");
    const manifestPath = join(root, "manifest.json");

    await expect(scaffoldManifest({ manifestPath, imageRoot })).rejects.toThrow(
      "No supported images found",
    );
  });
});
