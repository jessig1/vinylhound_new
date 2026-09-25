import { scaffoldManifest } from "./scaffold.ts";

const usage = `
VinylHound private evaluation manifest scaffolder

Adds one blank case per new image found under --image-root to a private
manifest.json, without touching any existing case. Safe to rerun as more
photos are added; never overwrites labeled or verified data.

Usage:
  npm run eval:scaffold -- --manifest <path> --image-root <dir> [options]

Required:
  --manifest <path>      Private manifest.json path (created if missing)
  --image-root <dir>     Directory containing consented album images

Options:
  --dataset-id <id>      Dataset id used only when creating a new manifest
  --help                 Show this help
`.trim();

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.info(usage);
    return;
  }

  let manifestPath: string | undefined;
  let imageRoot: string | undefined;
  let datasetId: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const takeValue = () => {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      return value;
    };
    switch (argument) {
      case "--manifest":
        manifestPath = takeValue();
        break;
      case "--image-root":
        imageRoot = takeValue();
        break;
      case "--dataset-id":
        datasetId = takeValue();
        break;
      default:
        throw new Error(`Unknown argument: ${argument}\n\n${usage}`);
    }
  }

  if (!manifestPath) throw new Error(`--manifest is required.\n\n${usage}`);
  if (!imageRoot) throw new Error(`--image-root is required.\n\n${usage}`);

  const result = await scaffoldManifest({ manifestPath, imageRoot, datasetId });

  console.info(`Manifest: ${result.manifestPath}`);
  console.info(`Total cases: ${result.manifest.cases.length}`);
  if (result.addedCaseIds.length > 0) {
    console.info(
      `Added ${result.addedCaseIds.length} new case(s): ${result.addedCaseIds.join(", ")}`,
    );
  } else {
    console.info(
      "No new images found; manifest unchanged aside from imageRoot.",
    );
  }
  console.info(
    `${result.unlabeledCaseIds.length} case(s) still need labeling (split, viewType, ` +
      `verified ground truth, and consent): ${result.unlabeledCaseIds.join(", ") || "none"}`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Scaffold failed.");
  process.exitCode = 1;
});
