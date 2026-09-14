/**
 * Runs one task through the GitHub Copilot CLI (`copilot`) directly — NOT through Pi. Copilot is a
 * self-contained agentic CLI with its own Auto model-selection, so this arm bypasses Pi entirely:
 * it spawns `copilot` itself and builds/appends the `CallLogRecord` directly (no Pi extension
 * mechanism to hook into a non-Pi process, but also no module-isolation concern the way
 * router-selection.ts has — this file and runner.ts share one ordinary process/module graph).
 *
 * `--output-format json` emits JSONL to stdout; `--usage-output-file <path>` writes a per-model
 * token/cost breakdown after exit, matching GitHub's published rate card — so unlike OpenRouter's
 * arms (see pricing.ts), the usage file self-reports the real dollar cost directly.
 *
 * A real Copilot failure prints a plain-text `Error: ...` line and exits nonzero WITHOUT ever
 * emitting a `result` JSONL event — so `parsed.exitCode` stays `null` and detection falls back to
 * the real child-process exit code (`parsed.exitCode ?? processExitCode`, see below).
 *
 * One CallLogRecord per invocation (call_index always 1), not per internal LLM turn — the usage
 * file only reports session-level aggregates, and `--available-tools` suppressing tool use should
 * reduce real traces to one LLM call per task anyway.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { appendCallLog } from "./log.js";
import type { Arm, CallLogRecord } from "./types.js";

const COPILOT_TIMEOUT_MS = 120_000; // matches runner.ts's PI_TIMEOUT_MS; not yet validated for Copilot specifically

const ARTIFACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts");
const COPILOT_CWD_DIR = join(ARTIFACTS_DIR, ".copilot-cwd");
const COPILOT_USAGE_DIR = join(ARTIFACTS_DIR, ".copilot-usage");

interface CopilotUsageFile {
  currentModel?: string;
  modelMetrics?: Record<
    string,
    {
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      };
      totalNanoAiu?: number;
    }
  >;
}

interface ParsedCopilotRun {
  chosenModel: string | null;
  routerLatencyMs: number;
  content: string | null;
  toolCalls: number;
  totalCallLatencyMs: number;
  exitCode: number | null;
}

function parseCopilotStdout(stdout: string): ParsedCopilotRun {
  let chosenModel: string | null = null;
  let routerLatencyMs = 0;
  let content: string | null = null;
  let toolCalls = 0;
  let totalCallLatencyMs = 0;
  let exitCode: number | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const type = event.type as string | undefined;
    const data = event.data as Record<string, unknown> | undefined;

    if (type === "session.auto_mode_resolved" && data) {
      chosenModel = (data.chosenModel as string) ?? chosenModel;
      routerLatencyMs = (data.endToEndLatencyMs as number) ?? routerLatencyMs;
    } else if (type === "assistant.message" && data) {
      content = (data.content as string) ?? content;
      const toolRequests = data.toolRequests as unknown[] | undefined;
      toolCalls += Array.isArray(toolRequests) ? toolRequests.length : 0;
    } else if (type === "model.call_finished" && data) {
      totalCallLatencyMs += (data.dispatchDurationMs as number) ?? 0;
    } else if (type === "result") {
      exitCode = (event.exitCode as number | null) ?? null;
    }
  }

  return { chosenModel, routerLatencyMs, content, toolCalls, totalCallLatencyMs, exitCode };
}

function readUsageFile(path: string): CopilotUsageFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CopilotUsageFile;
  } catch {
    return null;
  }
}

/** Runs one task through `copilot -p ...` directly, builds one CallLogRecord from its JSONL stdout
 * plus its --usage-output-file, appends it via log.ts (no Pi extension involved), and returns the
 * raw response text for prompts.ts's extractSolution/grading.ts's grade — same return shape as
 * runner.ts's runPiOnTask, so the caller needs no special-casing. */
export async function runCopilotOnTask(
  prompt: string,
  env: NodeJS.ProcessEnv,
  arm: Arm,
  runId: string,
  taskId: string,
): Promise<{ rawResponse: string | null; wallClockMs: number }> {
  const safeId = `${runId}-${taskId}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const cwd = join(COPILOT_CWD_DIR, safeId);
  const usagePath = join(COPILOT_USAGE_DIR, `${safeId}.json`);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(COPILOT_USAGE_DIR, { recursive: true });

  const args = [
    "-p",
    prompt,
    "-s",
    "--allow-all-tools",
    "--no-ask-user",
    "--available-tools", // no tool names follow -> no tools available
    "--output-format",
    "json",
    "--usage-output-file",
    usagePath,
    // Always explicit, including "auto" itself (a real, accepted --model value) — omitting
    // --model relies on the CLI's own ambient config default, which is NOT guaranteed to be
    // "auto" (a fresh `copilot login` can reset it to a fixed model instead). Never rely on that
    // default silently matching what an arm claims to be requesting.
    "--model",
    arm.model,
  ];

  const started = performance.now();
  const { stdout, exitCode: processExitCode } = await new Promise<{ stdout: string; exitCode: number | null }>(
    (resolve, reject) => {
      const child = spawn("copilot", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      let out = "";
      let err = "";
      child.stdout.on("data", (chunk: string) => (out += chunk));
      child.stderr.on("data", (chunk: string) => (err += chunk));

      const timer = setTimeout(() => child.kill("SIGKILL"), COPILOT_TIMEOUT_MS);

      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.warn(`copilot exited ${code}: ${err.slice(-500)}`);
        }
        resolve({ stdout: out, exitCode: code });
      });
    },
  );
  const wallClockMs = Math.round(performance.now() - started);

  const parsed = parseCopilotStdout(stdout);
  const usage = readUsageFile(usagePath);
  const selectedModel = parsed.chosenModel ?? usage?.currentModel ?? arm.model;
  const modelMetrics = usage?.modelMetrics?.[selectedModel];

  const record: CallLogRecord = {
    run_id: runId,
    task_id: taskId,
    arm: arm.name,
    call_index: 1,
    selected_model: selectedModel,
    router_latency_ms: parsed.routerLatencyMs,
    input_tokens: modelMetrics?.usage?.inputTokens ?? 0,
    output_tokens: modelMetrics?.usage?.outputTokens ?? 0,
    cache_read_tokens: modelMetrics?.usage?.cacheReadTokens ?? 0,
    cache_write_tokens: modelMetrics?.usage?.cacheWriteTokens ?? 0,
    total_call_latency_ms: parsed.totalCallLatencyMs || wallClockMs,
    tool_calls: parsed.toolCalls,
    // Falls back to the real process exit code since a real failure never emits a `result` event.
    error: (parsed.exitCode ?? processExitCode) !== 0 ? `copilot exited ${parsed.exitCode ?? processExitCode}` : null,
    model_cost: modelMetrics?.totalNanoAiu !== undefined ? modelMetrics.totalNanoAiu * 1e-11 : 0,
    router_cost: 0, // bundled into the one billed call — same reasoning as the notdiamond arm
    cost_source: modelMetrics ? "copilot_usage_file" : "unknown",
  };
  appendCallLog(record);

  return { rawResponse: parsed.content, wallClockMs };
}
