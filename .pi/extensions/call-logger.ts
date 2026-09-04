import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { appendCallLog } from "../../src/log.js";
import { getCallCost, type PiUsage } from "../../src/pricing.js";
import type { CallLogRecord } from "../../src/types.js";

// Loose local shape for the bits of turn_end's event we read — the full Pi message/event types
// weren't pinned down against a live run yet (no OpenRouter credentials in this environment; see
// the plan's verification section), so this stays intentionally permissive rather than asserting
// field names we haven't confirmed.
interface TurnEndEvent {
  message?: {
    usage?: PiUsage;
    stopReason?: string;
    errorMessage?: string;
  };
  toolResults?: unknown[];
}

/**
 * Logging only — no routing logic. One row per Pi LLM invocation (spec §13), written via
 * `appendCallLog`. `turn_start`/`turn_end` bracket one LLM invocation per the spec's own framing
 * (spec §3: "One Pi LLM invocation = one routing opportunity").
 *
 * `runner.ts` sets ROUTER_BENCH_* env vars once per spawned `pi` process, so this extension knows
 * which task/arm/model it's logging for without any other coordination.
 */
export default function (pi: ExtensionAPI) {
  let callIndex = 0;
  let turnStartedAt = 0;

  pi.on("turn_start", () => {
    turnStartedAt = performance.now();
  });

  pi.on("turn_end", (event) => {
    callIndex += 1;
    const totalCallLatencyMs = Math.round(performance.now() - turnStartedAt);

    const runId = process.env.ROUTER_BENCH_RUN_ID ?? "unassigned-run";
    const taskId = process.env.ROUTER_BENCH_TASK_ID ?? "unassigned-task";
    const arm = process.env.ROUTER_BENCH_ARM ?? "unassigned-arm";
    const model = process.env.ROUTER_BENCH_MODEL ?? "unknown-model";

    const turnEvent = event as TurnEndEvent;
    const usage = turnEvent.message?.usage;
    const { cost, source } = getCallCost(model, usage);

    const record: CallLogRecord = {
      run_id: runId,
      task_id: taskId,
      arm,
      call_index: callIndex,
      selected_model: model,
      router_latency_ms: 0, // no selector extension this phase — see arms.ts
      input_tokens: usage?.input ?? 0,
      output_tokens: usage?.output ?? 0,
      cache_read_tokens: usage?.cacheRead ?? 0,
      cache_write_tokens: usage?.cacheWrite ?? 0,
      total_call_latency_ms: totalCallLatencyMs,
      tool_calls: Array.isArray(turnEvent.toolResults) ? turnEvent.toolResults.length : 0,
      error:
        turnEvent.message?.stopReason === "error"
          ? (turnEvent.message.errorMessage ?? "error")
          : null,
      model_cost: cost,
      router_cost: 0, // no selector extension this phase — see arms.ts
      cost_source: source,
    };

    appendCallLog(record);
  });
}
