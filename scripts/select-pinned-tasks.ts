// One-off curation script (not part of the benchmark runtime) — fetches BigCodeBench-Instruct,
// picks a stratified sample, and freezes it to data/pinned-tasks.json so every arm/run this
// project ever does is measured against the identical task set.
//
// Does NOT validate ground truth (run canonical_solution against test) itself — that requires
// actually executing Python code, which conflicts with this project's "pure TS, no Python shell"
// scope for the ongoing benchmark runtime. Run scripts/validate-ground-truth.ts separately right
// after this (it's the one place in this project that shells out to Python, deliberately, as a
// one-off curation step) before treating the pinned set as final. Real BigCodeBench grading is
// still a stub (see src/grading.ts).
//
// Run with: npx tsx scripts/select-pinned-tasks.ts

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchAllBigCodeBenchRows, type BigCodeBenchRow } from "../src/bigcodebench.js";

const SAMPLE_SIZE = 24; // within the requested ~20-25 range
const SEED = 42; // matches clustering-based-llm-router's CORPUS_SAMPLE_SEED convention
const OUTPUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "pinned-tasks.json");

/** Deterministic PRNG (mulberry32) so the same seed always produces the same pin file. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function primaryLib(row: BigCodeBenchRow): string {
  return row.libs[0] ?? "none";
}

/**
 * Stratifies by primary library so the pinned set isn't dominated by whichever library happens to
 * be most common in BigCodeBench (proxy for task-domain diversity — there's no explicit domain
 * field on this dataset). Caps how many tasks share a primary library, starting at 3 and loosening
 * only if the pool can't otherwise reach sampleSize.
 */
function selectStratified(rows: BigCodeBenchRow[], sampleSize: number, seed: number): BigCodeBenchRow[] {
  const shuffled = seededShuffle(rows, mulberry32(seed));
  for (let cap = 3; cap <= sampleSize; cap++) {
    const counts = new Map<string, number>();
    const selected: BigCodeBenchRow[] = [];
    for (const row of shuffled) {
      const lib = primaryLib(row);
      const count = counts.get(lib) ?? 0;
      if (count >= cap) continue;
      selected.push(row);
      counts.set(lib, count + 1);
      if (selected.length === sampleSize) return selected;
    }
  }
  throw new Error(`Could not select ${sampleSize} tasks even without a per-library cap — pool too small?`);
}

function summarizeDistribution(rows: BigCodeBenchRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const lib = primaryLib(row);
    counts[lib] = (counts[lib] ?? 0) + 1;
  }
  return counts;
}

async function main(): Promise<void> {
  console.log("Fetching BigCodeBench-Instruct (bigcode/bigcodebench, split v0.1.4)...");
  const rows = await fetchAllBigCodeBenchRows();
  console.log(`Fetched ${rows.length} rows.`);

  const selected = selectStratified(rows, SAMPLE_SIZE, SEED);
  const distribution = summarizeDistribution(selected);
  console.log(`Selected ${selected.length} tasks. Primary-library distribution:`, distribution);

  const outputDir = dirname(OUTPUT_PATH);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const output = {
    dataset: "bigcode/bigcodebench",
    config: "default",
    split: "v0.1.4",
    field: "instruct_prompt",
    seed: SEED,
    sample_size: selected.length,
    selected_at: new Date().toISOString(),
    ground_truth_validated: false,
    tasks: selected,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
