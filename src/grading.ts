import type { GradeResult, Task } from "./types.js";

/**
 * STUB. Real grading (BigCodeBench pass/fail, sandboxed test execution) is deferred — this phase
 * is structure and logging only, pure TypeScript, no Python/Docker subprocess. Never fabricate a
 * pass/fail here; `not_graded_stub` is the only outcome until real grading is implemented.
 */
export async function grade(task: Task, solution: string | null): Promise<GradeResult> {
  return {
    outcome: "not_graded_stub",
    detail: solution === null ? "no solution produced" : "grading not implemented yet",
  };
}
