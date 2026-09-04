// Shared types for the Phase 1 (Pi + OpenRouter direct) structure.
// See `Probe Spec_ Router Evaluation.md` §13/§14 for the field lists these mirror.

/** A single benchmark task. `row` carries the source dataset's other fields (e.g. BigCodeBench's
 * `code_prompt`/`test`/`entry_point`) unused by Phase 1's stub grading but needed once real
 * grading exists — mirrors clustering-based-llm-router's Task.row design intentionally. */
export interface Task {
  task_id: string;
  source: string;
  prompt: string;
  row: Record<string, unknown>;
}

/** One experimental arm: a concrete Pi provider/model target, no routing logic behind it yet. */
export interface Arm {
  name: string;
  provider: string;
  model: string;
  description: string;
}

/**
 * One row per Pi LLM invocation (spec §13's "one log record for every Pi LLM invocation").
 * Field names match the spec's table verbatim where it names one, so the two stay easy to
 * cross-reference. `router_latency_ms`/`router_cost` stay 0 until a selector-only arm
 * (Not Diamond / Avengers Pro) exists — no schema change needed when that lands.
 */
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
  cost_source: "pi_reported" | "frozen_table" | "unknown";
}

/** Grading is stubbed this phase — never fabricate a real outcome. See grading.ts. */
export type GradeOutcome = "not_graded_stub";

export interface GradeResult {
  outcome: GradeOutcome;
  detail?: string;
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
