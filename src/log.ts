import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { CallLogRecord, TaskDetail, TaskResult } from "./types.js";

// Resolved relative to this module, not process.cwd() — the extension runs inside Pi's process,
// whose cwd may differ from wherever `runner.ts` was launched from, so both must agree on the
// same absolute artifacts/ directory regardless of caller cwd.
const ARTIFACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts");

function ensureArtifactsDir(): void {
  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }
}

function appendJsonLine(path: string, record: unknown): void {
  ensureArtifactsDir();
  appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
}

export function callLogPath(runId: string): string {
  return join(ARTIFACTS_DIR, `call-log-${runId}.jsonl`);
}

export function taskResultsPath(runId: string): string {
  return join(ARTIFACTS_DIR, `task-results-${runId}.jsonl`);
}

export function taskDetailPath(runId: string): string {
  return join(ARTIFACTS_DIR, `task-detail-${runId}.jsonl`);
}

/**
 * Logs are append-only and keyed purely by run_id — re-using a run_id across two separate
 * invocations silently merges both runs' rows into one file (confirmed real: a stale pre-fix run
 * and a later re-run under the identical --run-id both landed in the same call-log, doubling
 * `calls` and letting `.find()`-style lookups grab the wrong, stale row). Call this before a run
 * starts logging so a collision fails loudly instead of corrupting a file silently.
 */
export function assertRunIdIsFresh(runId: string): void {
  const existing = [callLogPath(runId), taskResultsPath(runId), taskDetailPath(runId)].filter((p) =>
    existsSync(p),
  );
  if (existing.length > 0) {
    throw new Error(
      `run_id "${runId}" was already used (${existing.join(", ")} exist) — pick a different --run-id ` +
        `(or omit it for a fresh timestamp) rather than appending to an existing run's logs.`,
    );
  }
}

export function appendCallLog(record: CallLogRecord): void {
  appendJsonLine(callLogPath(record.run_id), record);
}

export function appendTaskResult(result: TaskResult): void {
  appendJsonLine(taskResultsPath(result.run_id), result);
}

export function appendTaskDetail(detail: TaskDetail): void {
  appendJsonLine(taskDetailPath(detail.run_id), detail);
}

/** Reads back every CallLogRecord written so far for a run — the runner uses this to roll up
 * per-task totals from the extension's own log rows, rather than re-deriving usage/cost itself. */
export function readCallLog(runId: string): CallLogRecord[] {
  const path = callLogPath(runId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CallLogRecord);
}

/** Reads back every TaskResult written so far for a run — lets a caller (e.g.
 * scripts/run-comparison.ts) reuse a prior run's results without re-running it. */
export function readTaskResults(runId: string): TaskResult[] {
  const path = taskResultsPath(runId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TaskResult);
}

/** Whether a run already has persisted TaskResult rows — the cache-hit gate for incremental
 * comparison runs (see scripts/run-comparison.ts): true means skip re-running this arm entirely. */
export function hasTaskResults(runId: string): boolean {
  return existsSync(taskResultsPath(runId));
}
