import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { CallLogRecord, TaskResult } from "./types.js";

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

export function appendCallLog(record: CallLogRecord): void {
  appendJsonLine(callLogPath(record.run_id), record);
}

export function appendTaskResult(result: TaskResult): void {
  appendJsonLine(taskResultsPath(result.run_id), result);
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
