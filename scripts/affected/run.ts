#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { readdirSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBaseRef, listChangedFiles } from "./changed-files.ts";
import { buildWorkspaceGraph, type Workspace } from "./workspace-graph.ts";
import { selectAffected } from "./select-affected.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");

type Mode = "test" | "build";

function parseArgs(argv: string[]): {
  mode: Mode;
  base?: string;
  dryRun: boolean;
} {
  let mode: Mode | undefined;
  let base: string | undefined;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--mode") mode = argv[++i] as Mode;
    else if (arg === "--base") base = argv[++i];
    else if (arg === "--dry-run") dryRun = true;
  }

  if (mode !== "test" && mode !== "build") {
    throw new Error(
      "Usage: run.ts --mode <test|build> [--base <ref>] [--dry-run]",
    );
  }

  return { mode, base, dryRun };
}

function hasTestFiles(absDir: string): boolean {
  const stack = [absDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === ".next"
        ) {
          continue;
        }
        stack.push(join(dir, entry.name));
      } else if (entry.name.endsWith(".test.ts")) {
        return true;
      }
    }
  }
  return false;
}

function runFull(mode: Mode): never {
  const command = mode === "test" ? ["run", "test"] : ["run", "build"];
  console.log(`[affected] full fallback: npm ${command.join(" ")}`);
  execFileSync("npm", command, { cwd: REPO_ROOT, stdio: "inherit" });
  process.exit(0);
}

function main(): void {
  const { mode, base, dryRun } = parseArgs(process.argv.slice(2));

  const baseRef = resolveBaseRef(REPO_ROOT, base);
  if (!baseRef) {
    console.log(
      "[affected] no base ref could be resolved; falling back to a full check.",
    );
    if (dryRun) return;
    runFull(mode);
    return;
  }

  const changedFiles = listChangedFiles(REPO_ROOT, baseRef);
  const graph = buildWorkspaceGraph(REPO_ROOT);
  const selection = selectAffected(changedFiles, graph);

  console.log(
    `[affected] base=${baseRef} changed=${changedFiles.length} file(s)`,
  );
  console.log(`[affected] ${selection.reason}`);

  if (selection.fallbackFull) {
    if (dryRun) return;
    runFull(mode);
    return;
  }

  if (selection.affectedWorkspaces.length === 0) {
    console.log("[affected] nothing affected; skipping.");
    return;
  }

  console.log(
    `[affected] affected: ${selection.affectedWorkspaces.join(", ")}`,
  );
  if (dryRun) return;

  const affectedWorkspaces = selection.affectedWorkspaces
    .map((name) => graph.byName.get(name))
    .filter((w): w is Workspace => Boolean(w));

  if (mode === "test") {
    const testDirs = affectedWorkspaces
      .map((w) => join(REPO_ROOT, w.dir))
      .filter(hasTestFiles)
      .map((absDir) =>
        absDir.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"),
      );

    if (testDirs.length === 0) {
      console.log("[affected] no affected workspace has unit tests; skipping.");
      return;
    }

    execFileSync(
      "node",
      ["node_modules/vitest/vitest.mjs", "run", ...testDirs],
      { cwd: REPO_ROOT, stdio: "inherit" },
    );
    return;
  }

  const buildable = affectedWorkspaces.filter((w) => w.hasBuildScript);
  if (buildable.length === 0) {
    console.log(
      "[affected] no affected workspace has a build script; skipping.",
    );
    return;
  }

  const args = ["run", "build"];
  for (const workspace of buildable) args.push("--workspace", workspace.name);
  args.push("--if-present");
  execFileSync("npm", args, { cwd: REPO_ROOT, stdio: "inherit" });
}

main();
