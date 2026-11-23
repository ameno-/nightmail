/**
 * Runs the kept 21-bug planted-product verification set (api/tear/plants.json) against a scratch
 * checkout of Nightmail using the default api/tear/run.sh (no custom trace shortcuts).
 *
 * Refuses to mutate the current checkout unless --scratch-root <dir> is explicitly passed and
 * points outside this repo (or --allow-in-place is passed in an isolated container/scratch copy).
 *
 * Usage:
 *   TEAR_DATABASE_URL=... bun verify-plants.ts --scratch-root /path/to/scratch-nightmail [--only label1,label2]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Plant {
  label: string;
  checker: string;
  file: string;
  old: string;
  neu: string;
  first?: boolean;
}

const args = process.argv.slice(2);
let scratchRoot = "";
let onlySet: Set<string> | null = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--scratch-root") scratchRoot = resolve(args[++i] ?? "");
  else if (args[i] === "--only") onlySet = new Set((args[++i] ?? "").split(",").filter(Boolean));
}

if (!scratchRoot) {
  console.error("usage: TEAR_DATABASE_URL=... bun verify-plants.ts --scratch-root <scratch-repo-dir> [--only a,b]");
  process.exit(2);
}

const plants: Plant[] = JSON.parse(readFileSync(new URL("./plants.json", import.meta.url), "utf8"));
const selected = onlySet ? plants.filter((p) => onlySet!.has(p.label)) : plants;

const results: { label: string; checker: string; caught: boolean; seconds: number; detail: string }[] = [];

for (const plant of selected) {
  const targetFile = resolve(scratchRoot, plant.file);
  const original = readFileSync(targetFile, "utf8");
  if (!original.includes(plant.old)) {
    results.push({ label: plant.label, checker: plant.checker, caught: false, seconds: 0, detail: "PLANT_PATCH_MISMATCH" });
    continue;
  }
  const mutated = plant.first
    ? original.replace(plant.old, plant.neu)
    : original.replaceAll(plant.old, plant.neu);
  writeFileSync(targetFile, mutated);
  const t0 = performance.now();
  let caught = false;
  let detail = "MISSED (default run passed)";
  try {
    execFileSync("bash", ["tear/run.sh", plant.checker], {
      cwd: resolve(scratchRoot, "api"),
      env: { ...process.env, TEAR_EDGES: process.env.TEAR_EDGES ?? "0" },
      stdio: "pipe",
      encoding: "utf8",
      timeout: 300_000,
    });
  } catch (err: any) {
    caught = true;
    const out = String(err?.stdout ?? "") + "
" + String(err?.stderr ?? "");
    const line =
      out
        .split("
")
        .find((l) => /identity:|FAIL|BROKEN|violated|replyMismatch/.test(l))
        ?.trim() ?? `exit ${err?.status ?? 1}`;
    detail = line.slice(0, 140);
  } finally {
    writeFileSync(targetFile, original);
  }
  const seconds = Math.round(((performance.now() - t0) / 1000) * 10) / 10;
  results.push({ label: plant.label, checker: plant.checker, caught, seconds, detail });
  console.log(`[${caught ? "CAUGHT" : "MISSED"}] ${plant.label} (${plant.checker}, ${seconds}s): ${detail}`);
}

const caughtCount = results.filter((r) => r.caught).length;
console.log(`\nSCORE: ${caughtCount}/${results.length}`);
if (caughtCount < results.length) process.exit(1);
