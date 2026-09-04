// One-off ground-truth check (not part of the benchmark runtime): for each pinned task, runs its
// own `canonical_solution` against its own `test` suite and records whether BigCodeBench's own
// reference answer actually passes. This is the one place in this project that shells out to
// Python — unavoidable, since validating a Python solution against a Python unittest suite means
// executing Python. The ongoing Pi/OpenRouter benchmark runtime stays pure TS; this is a curation
// step, run manually, same as scripts/select-pinned-tasks.ts.
//
// Grading itself lives in src/bigcodebench-grader.ts (shared with real grading in grading.ts) —
// this script just feeds it `canonical_solution` instead of a model's solution and writes a
// report. See that module's docstring for the venv/reproducibility details.
//
// Run with: npx tsx scripts/validate-ground-truth.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { capturePythonEnv, gradeBigCodeBench, venvReady, VENV_PYTHON, VENV_SETUP_HINT } from "../src/bigcodebench-grader.js";
import type { GradeResult } from "../src/types.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_TASKS_PATH = join(PROJECT_ROOT, "data", "pinned-tasks.json");
const REPORT_PATH = join(PROJECT_ROOT, "data", "ground-truth-report.json");

interface PinnedTask {
  task_id: string;
  code_prompt: string;
  canonical_solution: string;
  test: string;
  [key: string]: unknown;
}

interface PinnedTasksFile {
  ground_truth_validated: boolean;
  tasks: PinnedTask[];
  [key: string]: unknown;
}

interface ValidationResult extends GradeResult {
  task_id: string;
}

function main(): void {
  if (!venvReady()) {
    throw new Error(VENV_SETUP_HINT);
  }
  const pythonEnv = capturePythonEnv();

  const file = JSON.parse(readFileSync(PINNED_TASKS_PATH, "utf8")) as PinnedTasksFile;
  console.log(`Validating ground truth for ${file.tasks.length} pinned tasks against their own test suites...`);
  console.log(`Using ${VENV_PYTHON} (python ${pythonEnv.python_version}):`, pythonEnv.packages);

  const results: ValidationResult[] = file.tasks.map((task) => {
    const result = gradeBigCodeBench(task.code_prompt, task.canonical_solution, task.test);
    console.log(`  ${result.outcome === "pass" ? "PASS" : result.outcome.toUpperCase()}  ${task.task_id}`);
    return { task_id: task.task_id, ...result };
  });

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\nSummary:", counts);

  writeFileSync(
    REPORT_PATH,
    JSON.stringify({ validated_at: new Date().toISOString(), python_env: pythonEnv, counts, results }, null, 2) + "\n",
    "utf8",
  );
  console.log(`Wrote ${REPORT_PATH}`);

  const badTaskIds = results.filter((r) => r.outcome !== "pass").map((r) => r.task_id);
  if (badTaskIds.length > 0) {
    console.log(
      `\n${badTaskIds.length} task(s) failed their OWN ground truth: ${badTaskIds.join(", ")}\n` +
        "Not modifying data/pinned-tasks.json automatically — see the report and decide whether to " +
        "drop/replace these before treating the pin as final.",
    );
  } else {
    console.log("\nAll pinned tasks pass their own ground truth.");
  }
}

main();
