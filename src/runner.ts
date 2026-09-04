import { spawn } from "node:child_process";

import { getArm } from "./arms.js";
import { grade } from "./grading.js";
import { appendTaskResult, readCallLog } from "./log.js";
import { loadPinnedTasks } from "./tasks.js";
import type { CallLogRecord, TaskResult } from "./types.js";

const PI_TIMEOUT_MS = 120_000;

function parseArgs(argv: string[]): { arm: string; runId: string } {
  let arm: string | undefined;
  let runId = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--arm") arm = argv[++i];
    else if (argv[i] === "--run-id") runId = argv[++i] ?? runId;
  }
  if (!arm) {
    throw new Error(
      "Usage: npm run bench -- --arm <direct|openrouter-auto|openrouter-pareto-code> [--run-id <id>]",
    );
  }
  return { arm, runId };
}

interface PiRunResult {
  solution: string | null;
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
      resolve({ solution: extractSolution(stdout), wallClockMs, exitCode: code });
    });
  });
}

/**
 * Minimal NDJSON read-back — just enough to hand grading.ts something to look at. Usage/cost is
 * NOT derived here; that comes from the call-logger extension's own log rows (readCallLog), which
 * is the authoritative source per the plan.
 */
function extractSolution(stdout: string): string | null {
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

async function main(): Promise<void> {
  const { arm: armName, runId } = parseArgs(process.argv.slice(2));
  const arm = getArm(armName);
  const tasks = loadPinnedTasks();

  console.log(`run_id=${runId} arm=${arm.name} model=${arm.model} tasks=${tasks.length}`);

  for (const task of tasks) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ROUTER_BENCH_RUN_ID: runId,
      ROUTER_BENCH_TASK_ID: task.task_id,
      ROUTER_BENCH_ARM: arm.name,
      ROUTER_BENCH_MODEL: arm.model,
    };

    console.log(`-> ${task.task_id}`);
    const { solution, wallClockMs } = await runPiOnTask(task.prompt, env, arm.provider, arm.model);
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
    console.log(
      `   outcome=${gradeResult.outcome} calls=${taskResult.calls} cost=$${taskResult.total_cost_usd.toFixed(5)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
