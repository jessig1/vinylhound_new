// Explicit local export only; never upload private camera recordings.
import { readFile, realpath, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../apps/web/package.json", import.meta.url),
);
const sharp = require("sharp");
const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error(
    "Usage: node scripts/capture/inspect-recording.mjs <capture-frames.vhc> <new-private-directory-outside-repo>",
  );
const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
// Resolve the parent first so a junction cannot turn an outside path into a repo write.
const destination = path.join(
  await realpath(path.dirname(path.resolve(output))),
  path.basename(output),
);
const relative = path.relative(root, destination);
if (
  !relative ||
  (!relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative))
)
  throw new Error("Save private frames outside the repository");
if ((await stat(input)).size > 20 * 1024 * 1024)
  throw new Error("Recording exceeds D01 bounds");
const bytes = await readFile(input);
if (bytes.length < 4) throw new Error("Missing recording header");
const size = bytes.readUInt32LE(0);
if (size > 3 * 1024 * 1024 || size + 4 > bytes.length)
  throw new Error("Invalid metadata length");
const manifest = JSON.parse(bytes.subarray(4, 4 + size).toString("utf8"));
if (
  manifest.format !== "vinylhound-capture-diagnostics-v1" ||
  !Array.isArray(manifest.rawFrames) ||
  manifest.rawFrames.length > 1500
)
  throw new Error("Unsupported recording");
let offset = 0;
const ids = new Set();
for (const frame of manifest.rawFrames) {
  if (
    ![frame.id, frame.width, frame.height, frame.offset, frame.length].every(
      Number.isSafeInteger,
    ) ||
    frame.id < 1 ||
    ids.has(frame.id) ||
    frame.width < 1 ||
    frame.height < 1 ||
    frame.width > 320 ||
    frame.height > 320 ||
    frame.offset !== offset ||
    frame.length !== frame.width * frame.height * 4
  )
    throw new Error("Invalid frame metadata");
  ids.add(frame.id);
  offset += frame.length;
}
if (size + 4 + offset !== bytes.length)
  throw new Error("Truncated or trailing raw data");
await mkdir(destination); // Refuse an existing directory rather than overwriting evidence.
await writeFile(
  path.join(destination, "manifest.json"),
  JSON.stringify(manifest, null, 2),
  { flag: "wx" },
);
for (const frame of manifest.rawFrames) {
  const pixels = bytes.subarray(
    4 + size + frame.offset,
    4 + size + frame.offset + frame.length,
  );
  await sharp(pixels, {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })
    .png()
    .toFile(path.join(destination, `frame-${frame.id}.png`));
}
console.log(
  `Extracted ${manifest.rawFrames.length} unannotated frames and manifest to the private directory.`,
);
