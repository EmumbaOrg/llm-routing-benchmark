import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { Task } from "./types.js";

const PINNED_TASKS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "pinned-tasks.json");

interface PinnedTasksFile {
  dataset: string;
  split: string;
  field: string;
  seed: number;
  sample_size: number;
  ground_truth_validated: boolean;
  tasks: Array<{ task_id: string; instruct_prompt: string } & Record<string, unknown>>;
}

/**
 * Loads the frozen ~20-25 task BigCodeBench set from data/pinned-tasks.json (produced by
 * scripts/select-pinned-tasks.ts) so every arm/run uses the identical tasks. Falls back to a
 * couple of hardcoded placeholder tasks if that file hasn't been generated yet, so the
 * runner/logging plumbing still works before pinning is done.
 */
export function loadPinnedTasks(): Task[] {
  if (!existsSync(PINNED_TASKS_PATH)) {
    return stubTasks();
  }
  const file = JSON.parse(readFileSync(PINNED_TASKS_PATH, "utf8")) as PinnedTasksFile;
  if (!file.ground_truth_validated) {
    console.warn(
      "warning: pinned tasks have NOT been ground-truth validated (canonical_solution vs test was " +
        "never run) — some tasks may have broken ground truth. Run scripts/validate-ground-truth.ts.",
    );
  }
  return file.tasks.map((row) => ({
    task_id: row.task_id,
    source: "bigcodebench",
    prompt: row.instruct_prompt,
    row,
  }));
}

function stubTasks(): Task[] {
  console.warn(`warning: ${PINNED_TASKS_PATH} not found — using 2 hardcoded placeholder tasks. Run:
  npx tsx scripts/select-pinned-tasks.ts`);
  return [
    {
      task_id: "stub-bigcodebench-0",
      source: "bigcodebench",
      prompt: "Write a Python function `is_even(n: int) -> bool` that returns True if n is even.",
      row: {},
    },
    {
      task_id: "stub-bigcodebench-1",
      source: "bigcodebench",
      prompt: "Write a Python function `reverse_words(s: str) -> str` that reverses word order in s.",
      row: {},
    },
  ];
}
