import { cp, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Next's standalone output intentionally excludes public static assets. The
// production container copies them separately; mirror that assembly here so
// the isolated Playwright server hydrates client components.
const distDir = process.env.NEXT_DIST_DIR ?? ".next";
const source = join(distDir, "static");
const destination = join(
  distDir,
  "standalone",
  "apps",
  "web",
  distDir,
  "static",
);

await stat(source);
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true, force: true });
