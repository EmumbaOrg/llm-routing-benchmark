import { writeFileSync } from "node:fs";

import { readCallLog } from "./log.js";
import type { Arm, TaskResult } from "./types.js";

export interface ComparisonRun {
  label: string;
  arm: Arm;
  runId: string;
  results: TaskResult[];
}

/**
 * One row per task_id (union across all runs), wide format — each run contributes a
 * `<label>_*` column group: requested_model, selected_model, routed, outcome, cost_usd,
 * latency_ms. `selected_model` comes from the run's CallLogRecord (readCallLog), not TaskResult —
 * that's the only place the ACTUAL served model lives (see call-logger.ts / pricing.ts fixes
 * earlier this session). Single-turn/no-tools tasks always produce exactly one call, so the
 * task_id join between TaskResult and CallLogRecord is 1:1.
 */
export function buildComparisonReport(runs: ComparisonRun[]): Record<string, unknown>[] {
  const taskIds = [...new Set(runs.flatMap((run) => run.results.map((r) => r.task_id)))].sort();

  return taskIds.map((taskId) => {
    const row: Record<string, unknown> = { task_id: taskId };

    for (const run of runs) {
      const taskResult = run.results.find((r) => r.task_id === taskId);
      const callLogRow = readCallLog(run.runId).find((r) => r.task_id === taskId);
      const prefix = run.label;

      row[`${prefix}_requested_model`] = run.arm.model;
      row[`${prefix}_selected_model`] = callLogRow?.selected_model ?? null;
      row[`${prefix}_routed`] = run.arm.name !== "direct";
      row[`${prefix}_outcome`] = taskResult?.grade.outcome ?? null;
      row[`${prefix}_cost_usd`] = taskResult?.total_cost_usd ?? null;
      row[`${prefix}_latency_ms`] = taskResult?.wall_clock_ms ?? null;
    }

    return row;
  });
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeComparisonCsv(rows: Record<string, unknown>[], path: string): void {
  if (rows.length === 0) {
    writeFileSync(path, "", "utf8");
    return;
  }
  const columns = Object.keys(rows[0]!);
  const lines = [
    columns.join(","),
    ...rows.map((row) => columns.map((col) => csvEscape(row[col])).join(",")),
  ];
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
}
