// Shared types for the Phase 1 (Pi + OpenRouter direct) structure.

/** A single benchmark task. `row` carries the source dataset's other fields (BigCodeBench's
 * `code_prompt`/`test`/`entry_point`/etc.) that grading.ts needs — mirrors
 * clustering-based-llm-router's Task.row design intentionally. */
export interface Task {
  task_id: string;
  source: string;
  prompt: string;
  row: Record<string, unknown>;
}

/** One experimental arm: a concrete provider/model target, no routing logic behind it yet.
 * `harness` picks which subprocess actually runs the task — "pi" (the default, spawns `pi` per
 * runner.ts's runPiOnTask) or "copilot" (spawns the `copilot` CLI directly per copilot-runner.ts,
 * since GitHub Copilot is a self-contained agent, not something Pi routes to). Required rather
 * than defaulted so every arm states it explicitly. */
export interface Arm {
  name: string;
  provider: string;
  model: string;
  description: string;
  harness: "pi" | "copilot";
}

/** One row per Pi LLM invocation. `router_latency_ms`/`router_cost` are real only for the
 * notdiamond arm (see router-selection.ts) and stay 0 for every other arm. */
export interface CallLogRecord {
  run_id: string;
  task_id: string;
  arm: string;
  call_index: number;
  selected_model: string;
  router_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_call_latency_ms: number;
  tool_calls: number;
  error: string | null;
  model_cost: number;
  router_cost: number;
  cost_source: "pi_reported" | "frozen_table" | "openrouter_pricing_table" | "copilot_usage_file" | "unknown";
}

/** Mirrors clustering-based-llm-router's Outcome taxonomy (grading/base.py) — "pass"/"fail"/
 * "error_no_solution" are real signal; the "error_*" others mean OUR harness couldn't even judge
 * the attempt (missing dependency, timeout, no result sentinel), not a wrong answer, so they
 * should be excluded from error-rate math rather than counted as failures. */
export type GradeOutcome = "pass" | "fail" | "error_missing_dep" | "error_timeout" | "error_harness" | "error_no_solution";

export interface GradeResult {
  outcome: GradeOutcome;
  detail: string;
}

/** One row per (task, arm) attempt — the rollup of that attempt's CallLogRecords. */
export interface TaskResult {
  run_id: string;
  task_id: string;
  arm: string;
  calls: number;
  total_tool_calls: number;
  total_cost_usd: number;
  wall_clock_ms: number;
  grade: GradeResult;
}

/**
 * The full text behind a TaskResult's terse outcome — what the model actually returned, what got
 * extracted and graded, and why it passed/failed. Kept in its own log (not folded into
 * TaskResult/CallLogRecord) since raw responses/solutions are multi-line free text, not the kind
 * of thing you want bloating a metrics file you're scanning or joining into a CSV.
 */
export interface TaskDetail {
  run_id: string;
  task_id: string;
  arm: string;
  raw_response: string | null; // Pi's full final-message text, before code-block extraction
  solution: string | null; // what was actually graded (extracted code, or null if none produced)
  outcome: GradeOutcome;
  detail: string; // grade.detail — e.g. "PASS", "FAIL 3 failures, 0 errors", an IndentationError, etc.
}
