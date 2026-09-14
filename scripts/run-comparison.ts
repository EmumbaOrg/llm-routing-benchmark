// Runs a configurable set of arms, in order, against the pinned task set, then compiles a single
// per-task comparison report merging all runs' logs — requested vs. actually selected model, cost,
// latency, outcome, per arm, per task.
//
// Incremental by --run-id: an arm whose results already exist on disk for this --run-id is loaded
// from its existing JSONL files instead of re-run (zero cost) — so adding a new arm to a
// comparison doesn't require re-running arms already benchmarked. The full comparison CSV is
// always rebuilt fresh from whatever's on disk (cheap re-derivation, not incremental editing).
//
// Run with: npx tsx scripts/run-comparison.ts [--limit <n>] [--run-id <id>] [--arms <labels>]
// --arms defaults to "direct,openrouter-auto,openrouter-pareto-code".
// No --limit = full 24 pinned tasks per (freshly-run) arm, real cost for each arm actually run.

import "dotenv/config";

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { existsSync } from "node:fs";

import { ARMS, resolveArmByLabel } from "../src/arms.js";
import { runBenchmark, printSummary } from "../src/runner.js";
import { callLogPath, hasTaskResults, readTaskResults } from "../src/log.js";
import { loadPinnedTasks } from "../src/tasks.js";
import { buildComparisonReport, writeComparisonCsv, type ComparisonRun } from "../src/report.js";

const ARTIFACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts");
const DEFAULT_ARMS = ["direct", "openrouter-auto", "openrouter-pareto-code"];
const VALID_LABELS = ["direct", ...Object.keys(ARMS)];

function parseArgs(argv: string[]): { limit: number | undefined; compareId: string; labels: string[] } {
  let limit: number | undefined;
  let compareId = new Date().toISOString().replace(/[:.]/g, "-");
  let armsFlag: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") limit = Number(argv[++i]);
    else if (argv[i] === "--run-id") compareId = argv[++i] ?? compareId;
    else if (argv[i] === "--arms") armsFlag = argv[++i];
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer.");
  }

  const labels = armsFlag
    ? armsFlag.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ARMS;
  if (labels.length === 0) {
    throw new Error("--arms must name at least one arm.");
  }
  const unknown = labels.filter((l) => !VALID_LABELS.includes(l));
  if (unknown.length > 0) {
    throw new Error(`Unknown arm(s) in --arms: ${unknown.join(", ")}. Valid: ${VALID_LABELS.join(", ")}`);
  }
  const duplicates = labels.filter((l, i) => labels.indexOf(l) !== i);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate arm(s) in --arms: ${[...new Set(duplicates)].join(", ")}`);
  }

  return { limit, compareId, labels };
}

/** Throws if a cached arm's task-id set doesn't match what this invocation's --limit actually
 * expects — comparability across arms depends on every arm in the same --run-id having covered the
 * identical task subset, and a silent mismatch would produce a misleadingly-inconsistent report. */
function assertTaskSetMatches(label: string, runId: string, cached: { task_id: string }[], expected: Set<string>): void {
  const cachedIds = new Set(cached.map((r) => r.task_id));
  const missing = [...expected].filter((id) => !cachedIds.has(id));
  const unexpected = [...cachedIds].filter((id) => !expected.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Cached results for arm "${label}" (run_id "${runId}") don't match this invocation's task set ` +
        `(expected ${expected.size} tasks, cached has ${cachedIds.size}) — likely a different --limit ` +
        `was used originally. Missing: [${missing.join(", ")}]. Unexpected: [${unexpected.join(", ")}]. ` +
        `Re-run with the original --limit, or use a fresh --run-id to start a clean comparison.`,
    );
  }
}

async function main(): Promise<void> {
  const { limit, compareId, labels } = parseArgs(process.argv.slice(2));

  const baselineProvider = process.env.BASELINE_PROVIDER;
  const baselineModel = process.env.BASELINE_MODEL;
  if (labels.includes("direct") && (!baselineProvider || !baselineModel)) {
    throw new Error(
      "BASELINE_PROVIDER and BASELINE_MODEL must both be set (in .env) — \"direct\" is in --arms.",
    );
  }

  const allTasks = loadPinnedTasks();
  const expectedTasks = limit !== undefined ? allTasks.slice(0, limit) : allTasks;
  const expectedTaskIds = new Set(expectedTasks.map((t) => t.task_id));

  const runs: ComparisonRun[] = [];

  console.log(`Comparison run: ${compareId} (${expectedTasks.length} task(s) per arm, ${labels.length} arm(s): ${labels.join(", ")})\n`);

  for (const label of labels) {
    const arm = resolveArmByLabel(label, baselineProvider && baselineModel ? { provider: baselineProvider, model: baselineModel } : undefined);
    const armRunId = `${compareId}-${label}`;

    if (hasTaskResults(armRunId)) {
      const results = readTaskResults(armRunId);
      assertTaskSetMatches(label, armRunId, results, expectedTaskIds);
      if (!existsSync(callLogPath(armRunId))) {
        console.warn(
          `warning: ${callLogPath(armRunId)} is missing for cached arm "${label}" — the report will ` +
            `show a null selected_model for it.`,
        );
      }
      console.log(`\n### ${label} (cached — ${results.length} task(s), no re-run) ###`);
      printSummary(armRunId, arm, results);
      runs.push({ label, arm, runId: armRunId, results });
    } else {
      console.log(`\n### ${label} ###`);
      const results = await runBenchmark(arm, armRunId, limit);
      printSummary(armRunId, arm, results);
      runs.push({ label, arm, runId: armRunId, results });
    }
  }

  const rows = buildComparisonReport(runs);
  const reportPath = join(ARTIFACTS_DIR, `comparison-report-${compareId}.csv`);
  writeComparisonCsv(rows, reportPath);

  console.log(`\nWrote per-task comparison report: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
