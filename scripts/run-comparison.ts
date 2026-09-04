// Runs baseline -> Auto -> Pareto Code, in that order, against the pinned task set, then compiles
// a single per-task comparison report merging all three runs' logs — requested vs. actually
// selected model, cost, latency, outcome, per arm, per task.
//
// Run with: npx tsx scripts/run-comparison.ts [--limit <n>] [--run-id <id>]
// No --limit = full 24 pinned tasks x 3 arms = 72 real Pi calls, real cost.

import "dotenv/config";

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getArm, buildDirectArm } from "../src/arms.js";
import { runBenchmark, printSummary } from "../src/runner.js";
import { buildComparisonReport, writeComparisonCsv, type ComparisonRun } from "../src/report.js";

const ARTIFACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts");

function parseArgs(argv: string[]): { limit: number | undefined; compareId: string } {
  let limit: number | undefined;
  let compareId = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") limit = Number(argv[++i]);
    else if (argv[i] === "--run-id") compareId = argv[++i] ?? compareId;
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer.");
  }
  return { limit, compareId };
}

async function main(): Promise<void> {
  const { limit, compareId } = parseArgs(process.argv.slice(2));

  const baselineProvider = process.env.BASELINE_PROVIDER;
  const baselineModel = process.env.BASELINE_MODEL;
  if (!baselineProvider || !baselineModel) {
    throw new Error(
      "BASELINE_PROVIDER and BASELINE_MODEL must both be set (in .env) — baseline is a required leg of the comparison.",
    );
  }

  const runs: ComparisonRun[] = [
    { label: "direct", arm: buildDirectArm(baselineProvider, baselineModel), runId: `${compareId}-direct`, results: [] },
    { label: "openrouter-auto", arm: getArm("openrouter-auto"), runId: `${compareId}-openrouter-auto`, results: [] },
    {
      label: "openrouter-pareto-code",
      arm: getArm("openrouter-pareto-code"),
      runId: `${compareId}-openrouter-pareto-code`,
      results: [],
    },
  ];

  console.log(`Comparison run: ${compareId} (${limit ?? 24} task(s) per arm, ${runs.length} arms, sequential)\n`);

  for (const run of runs) {
    console.log(`\n### ${run.label} ###`);
    run.results = await runBenchmark(run.arm, run.runId, limit);
    printSummary(run.runId, run.arm, run.results);
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
