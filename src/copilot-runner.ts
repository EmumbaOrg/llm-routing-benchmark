/**
 * Runs one task through the GitHub Copilot CLI (`copilot`) directly — NOT through Pi. Copilot is a
 * self-contained agentic coding CLI with its own Auto model-selection feature, so unlike every
 * other arm (which only ever changes which `model` string Pi is told to use), a `harness: "copilot"`
 * arm bypasses Pi entirely: this file spawns `copilot` itself and builds/appends the
 * `CallLogRecord` directly, since there's no Pi extension mechanism to hook into a non-Pi process.
 *
 * Confirmed live (2026-09-08) against a real authenticated `copilot` CLI and a real pinned task:
 * `--output-format json` emits real JSONL to stdout, and `--usage-output-file <path>` writes a
 * separate JSON file after the process exits with a per-model token/cost breakdown. Cost math was
 * hand-verified against GitHub's own published per-model $/token rate card
 * (docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing): reconstructing
 * `usage.totalNanoAiu * 1e-11` independently from raw token counts × published rates matched to
 * the ten-thousandth of a cent — so, unlike OpenRouter's arms (see pricing.ts), no separate frozen
 * pricing table is needed here; the usage file self-reports the real dollar cost.
 *
 * CANDIDATE-POOL RESTRICTION IS NOT A PER-RUN KNOB. Unlike AUTO_ALLOWED_MODELS/
 * NOTDIAMOND_CANDIDATE_MODELS, there is no CLI flag or per-session parameter to restrict which
 * models Copilot's Auto mode considers — that's only controllable via an org/enterprise Business+
 * admin policy (Settings -> Copilot -> Models), applied account-wide, not scoped per benchmark run.
 * On the currently-authenticated test account, `candidateModels`/`availableModels` showed exactly
 * one model for every prompt tried, including a real pinned BigCodeBench task — so "Auto" is not
 * currently exercising any real routing decision on this account, just always resolving to one
 * fixed model. Don't imply otherwise in analysis of this arm's results without re-checking.
 *
 * ERROR HANDLING — confirmed live against a real failure (2026-09-08, `--model
 * this-model-does-not-exist-xyz`): a real Copilot failure prints a plain-text `Error: ...` line
 * and exits nonzero WITHOUT ever emitting a `result` JSONL event at all — so `parsed.exitCode`
 * (which only comes from a `result` event) stays `null`, and detecting the failure relies on
 * falling back to the real child-process exit code instead (see `processExitCode` below). Both are
 * checked via `parsed.exitCode ?? processExitCode`.
 *
 * RECORD GRANULARITY: one CallLogRecord per `copilot` invocation (call_index always 1), not one
 * per internal LLM turn the way call-logger.ts does for Pi — `--usage-output-file` only reports
 * session-level aggregates, not a per-turn breakdown, so a genuinely multi-turn Copilot task would
 * under-count `calls` relative to an equivalent Pi arm. In practice, with --available-tools
 * suppressing tool use, real traces should reduce to exactly one LLM call per task anyway.
 *
 * No module-isolation concern here (contrast with router-selection.ts's file-channel workaround,
 * needed only because Pi isolates each *extension's* module graph): this file and runner.ts share
 * one ordinary process/module graph, so a plain function call and return value is all that's
 * needed to get data back to the caller.
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
    "--available-tools", // no tool names follow -> no tools available; see this file's doc comment on the "no-tools" equivalent, unconfirmed until the first real run
    "--output-format",
    "json",
    "--usage-output-file",
    usagePath,
    // Always explicit, including "auto" itself (a real, accepted --model value) — confirmed live
    // (2026-09-08) that omitting --model relies on the CLI's own ambient config default, which is
    // NOT guaranteed to be "auto": a fresh `copilot login` was observed to reset it to a fixed
    // model (no session.auto_mode_resolved event at all) rather than "auto". Never rely on that
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
    // Falls back to the real process exit code since a real failure never emits a `result` event
    // (confirmed live — see this file's doc comment).
    error: (parsed.exitCode ?? processExitCode) !== 0 ? `copilot exited ${parsed.exitCode ?? processExitCode}` : null,
    model_cost: modelMetrics?.totalNanoAiu !== undefined ? modelMetrics.totalNanoAiu * 1e-11 : 0,
    router_cost: 0, // bundled into the one billed call — same reasoning as the notdiamond arm
    cost_source: modelMetrics ? "copilot_usage_file" : "unknown",
  };
  appendCallLog(record);

  return { rawResponse: parsed.content, wallClockMs };
}
