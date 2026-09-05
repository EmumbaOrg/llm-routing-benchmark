import "dotenv/config"; // loads .env into process.env — silently a no-op if the file doesn't exist

import { spawn } from "node:child_process";

import { ARMS, buildDirectArm, getArm } from "./arms.js";
import { grade } from "./grading.js";
import { appendTaskDetail, appendTaskResult, assertRunIdIsFresh, readCallLog } from "./log.js";
import { buildPrompt, extractSolution } from "./prompts.js";
import { loadPinnedTasks } from "./tasks.js";
import type { Arm, CallLogRecord, TaskResult } from "./types.js";

const PI_TIMEOUT_MS = 120_000;

const USAGE =
  "Usage:\n" +
  `  npm run bench -- --arm <${Object.keys(ARMS).join("|")}> [--run-id <id>] [--limit <n>]\n` +
  "  npm run bench -- --provider <name> --model <id> [--run-id <id>] [--limit <n>]   (direct, no router)\n" +
  "  npm run bench -- [--run-id <id>] [--limit <n>]   (direct, using BASELINE_PROVIDER/BASELINE_MODEL from .env)";

function parseArgs(argv: string[]): { arm: Arm; runId: string; limit: number | undefined } {
  let armName: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let limit: number | undefined;
  let runId = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--arm") armName = argv[++i];
    else if (argv[i] === "--provider") provider = argv[++i];
    else if (argv[i] === "--model") model = argv[++i];
    else if (argv[i] === "--run-id") runId = argv[++i] ?? runId;
    else if (argv[i] === "--limit") limit = Number(argv[++i]);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive integer.\n${USAGE}`);
  }

  const wantsNamedArm = armName !== undefined;
  const wantsDirectArm = provider !== undefined || model !== undefined;
  if (wantsNamedArm && wantsDirectArm) {
    throw new Error(USAGE); // both given — exactly one selection mode is valid
  }
  if (wantsNamedArm) {
    return { arm: getArm(armName!), runId, limit };
  }
  if (wantsDirectArm) {
    if (!provider || !model) throw new Error(`--provider and --model are both required together.\n${USAGE}`);
    return { arm: buildDirectArm(provider, model), runId, limit };
  }
  // Neither --arm nor --provider/--model given — fall back to the env-configured baseline
  // (BASELINE_PROVIDER/BASELINE_MODEL, see .env.example), so a plain `npm run bench` works once
  // that's set instead of requiring CLI flags every time. CLI flags still take priority above.
  const baselineProvider = process.env.BASELINE_PROVIDER;
  const baselineModel = process.env.BASELINE_MODEL;
  if (baselineProvider && baselineModel) {
    return { arm: buildDirectArm(baselineProvider, baselineModel), runId, limit };
  }
  throw new Error(USAGE);
}

interface PiRunResult {
  rawResponse: string | null;
  wallClockMs: number;
  exitCode: number | null;
}

function runPiOnTask(
  prompt: string,
  env: NodeJS.ProcessEnv,
  provider: string,
  model: string,
): Promise<PiRunResult> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const args = [
      "-p",
      prompt,
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-tools", // Phase 1 stub tasks have no repo checkout for tools to act on
      // Project-local extensions (.pi/extensions/call-logger.ts) only auto-load once the project
      // is trusted — without this, the logger silently never fires and every call goes unlogged.
      "--approve",
      "--provider",
      provider,
      "--model",
      model,
      "--mode",
      "json",
    ];
    const child = spawn("pi", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => child.kill("SIGKILL"), PI_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const wallClockMs = Math.round(performance.now() - started);
      if (code !== 0) {
        console.warn(`pi exited ${code}: ${stderr.slice(-500)}`);
      }
      resolve({ rawResponse: extractRawResponse(stdout), wallClockMs, exitCode: code });
    });
  });
}

/**
 * Minimal NDJSON read-back — pulls the final assistant message's raw text out of Pi's
 * `--mode json` event stream. This is NOT the solution yet — prompts.ts's extractSolution() still
 * needs to pull the fenced code block out of it per the grading contract. Usage/cost is NOT
 * derived here either; that comes from the call-logger extension's own log rows (readCallLog),
 * which is the authoritative source per the plan.
 */
function extractRawResponse(stdout: string): string | null {
  let lastAssistantText: string | null = null;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof event === "object" &&
      event !== null &&
      (event as { type?: string }).type === "agent_end" &&
      Array.isArray((event as { messages?: unknown[] }).messages)
    ) {
      const messages = (event as { messages: Array<Record<string, unknown>> }).messages;
      const assistantMessages = messages.filter((m) => m.role === "assistant");
      const last = assistantMessages.at(-1);
      const content = last?.content;
      if (Array.isArray(content)) {
        lastAssistantText = content
          .filter((b): b is { type: string; text: string } => (b as { type?: string })?.type === "text")
          .map((b) => b.text)
          .join("");
      }
    }
  }
  return lastAssistantText;
}

export function printSummary(runId: string, arm: Arm, results: TaskResult[]): void {
  const outcomeCounts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.grade.outcome] = (acc[r.grade.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const solved = outcomeCounts.pass ?? 0;
  const totalCost = results.reduce((sum, r) => sum + r.total_cost_usd, 0);
  const totalCalls = results.reduce((sum, r) => sum + r.calls, 0);
  const totalToolCalls = results.reduce((sum, r) => sum + r.total_tool_calls, 0);
  const totalWallClockMs = results.reduce((sum, r) => sum + r.wall_clock_ms, 0);
  const zeroCallTasks = results.filter((r) => r.calls === 0).map((r) => r.task_id);

  console.log(`\n=== Summary: run_id=${runId} arm=${arm.name} model=${arm.model} ===`);
  console.log(`outcomes:`, outcomeCounts);
  console.log(`solved: ${solved}/${results.length} (${((solved / results.length) * 100).toFixed(1)}%)`);
  console.log(
    `cost: $${totalCost.toFixed(5)} total, $${(totalCost / results.length).toFixed(5)} avg/task` +
      (solved > 0 ? `, $${(totalCost / solved).toFixed(5)} per solved task` : ""),
  );
  console.log(`calls: ${totalCalls} total, ${totalToolCalls} tool calls`);
  console.log(`wall-clock: ${(totalWallClockMs / 1000).toFixed(1)}s total`);
  if (zeroCallTasks.length > 0) {
    console.log(`WARNING: ${zeroCallTasks.length} task(s) logged zero calls: ${zeroCallTasks.join(", ")}`);
  }
}

/** Runs every pinned task (or the first `limit` of them) through one arm — real Pi calls, real
 * grading, real logging. Shared by the CLI (`main`, below) and scripts/run-comparison.ts, so both
 * paths exercise the identical logic rather than one re-invoking the other as a subprocess. */
export async function runBenchmark(arm: Arm, runId: string, limit?: number): Promise<TaskResult[]> {
  assertRunIdIsFresh(runId);
  const allTasks = loadPinnedTasks();
  // Always the first N of the pinned (already-shuffled, seeded) 24 — same subset every time a
  // given --limit is used, so partial runs stay comparable across arms.
  const tasks = limit !== undefined ? allTasks.slice(0, limit) : allTasks;
  const taskResults: TaskResult[] = [];

  console.log(`run_id=${runId} arm=${arm.name} model=${arm.model} tasks=${tasks.length}`);

  for (const task of tasks) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ROUTER_BENCH_RUN_ID: runId,
      ROUTER_BENCH_TASK_ID: task.task_id,
      ROUTER_BENCH_ARM: arm.name,
      ROUTER_BENCH_MODEL: arm.model,
      ROUTER_BENCH_PROVIDER: arm.provider,
    };

    console.log(`-> ${task.task_id}`);
    const { rawResponse, wallClockMs } = await runPiOnTask(buildPrompt(task), env, arm.provider, arm.model);
    const solution = extractSolution(rawResponse);
    const gradeResult = await grade(task, solution);

    const rows: CallLogRecord[] = readCallLog(runId).filter(
      (r) => r.task_id === task.task_id && r.arm === arm.name,
    );
    const taskResult: TaskResult = {
      run_id: runId,
      task_id: task.task_id,
      arm: arm.name,
      calls: rows.length,
      total_tool_calls: rows.reduce((sum, r) => sum + r.tool_calls, 0),
      total_cost_usd: rows.reduce((sum, r) => sum + r.model_cost, 0),
      wall_clock_ms: wallClockMs,
      grade: gradeResult,
    };
    appendTaskResult(taskResult);
    appendTaskDetail({
      run_id: runId,
      task_id: task.task_id,
      arm: arm.name,
      raw_response: rawResponse,
      solution,
      outcome: gradeResult.outcome,
      detail: gradeResult.detail,
    });
    taskResults.push(taskResult);
    console.log(
      `   outcome=${gradeResult.outcome} calls=${taskResult.calls} cost=$${taskResult.total_cost_usd.toFixed(5)}`,
    );
  }

  return taskResults;
}

async function main(): Promise<void> {
  const { arm, runId, limit } = parseArgs(process.argv.slice(2));
  const taskResults = await runBenchmark(arm, runId, limit);
  printSummary(runId, arm, taskResults);
}

// Only auto-run when this file is executed directly (`npm run bench` / `tsx src/runner.ts`), not
// when imported — scripts/run-comparison.ts imports runBenchmark/printSummary from this module,
// and without this guard main() would fire on import too (confirmed: bit us once already, when
// importing this file from a scratch script threw a stray usage error from main() running with
// the wrong argv).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
