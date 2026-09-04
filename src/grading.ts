import { gradeBigCodeBench } from "./bigcodebench-grader.js";
import type { GradeResult, Task } from "./types.js";

/**
 * Real BigCodeBench grading — see bigcodebench-grader.ts for the exec/unittest mechanics. Every
 * pinned task is currently bigcodebench (see data/pinned-tasks.json); other sources aren't
 * gradeable yet.
 */
export async function grade(task: Task, solution: string | null): Promise<GradeResult> {
  if (solution === null) {
    return { outcome: "error_no_solution", detail: "no solution produced" };
  }
  if (task.source !== "bigcodebench") {
    return { outcome: "error_harness", detail: `no grader implemented for source "${task.source}"` };
  }

  const codePrompt = task.row.code_prompt;
  const test = task.row.test;
  if (typeof codePrompt !== "string" || typeof test !== "string") {
    return { outcome: "error_harness", detail: "task row missing code_prompt/test" };
  }

  return gradeBigCodeBench(codePrompt, solution, test);
}
