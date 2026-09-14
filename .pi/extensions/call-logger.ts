import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { appendCallLog } from "../../src/log.js";
import { getCallCost, type PiUsage } from "../../src/pricing.js";
import { takeRouterLatency } from "../../src/router-selection.js";
import type { CallLogRecord } from "../../src/types.js";

// Loose local shape for the bits of turn_end's event we read. `message.model` is just Pi's own
// echo of what we ASKED for ("auto") — for a router model that's useless. `message.responseModel`
// is the field that actually identifies the concrete model that served the request.
interface TurnEndEvent {
  message?: {
    usage?: PiUsage;
    stopReason?: string;
    errorMessage?: string;
    model?: string;
    responseModel?: string;
    provider?: string;
  };
  toolResults?: unknown[];
}

/** Logging only — no routing logic. One row per Pi LLM invocation, written via `appendCallLog`.
 * `turn_start`/`turn_end` bracket one LLM invocation. `runner.ts` sets ROUTER_BENCH_* env vars once
 * per spawned `pi` process, so this extension knows which task/arm/model it's logging for without
 * any other coordination. */
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
    const requestedProvider = process.env.ROUTER_BENCH_PROVIDER ?? "unknown-provider";
    const requestedModel = process.env.ROUTER_BENCH_MODEL ?? "unknown-model";

    const turnEvent = event as TurnEndEvent;
    // The model that actually served the request. Prefers responseModel (the real resolved model
    // — see the interface comment above), falls back through model, then the requested model, so
    // selected_model can never come back empty.
    const selectedModel = turnEvent.message?.responseModel ?? turnEvent.message?.model ?? requestedModel;
    const usage = turnEvent.message?.usage;
    const { cost, source } = getCallCost(requestedProvider, selectedModel, usage);

    const record: CallLogRecord = {
      run_id: runId,
      task_id: taskId,
      arm,
      call_index: callIndex,
      selected_model: selectedModel,
      // 0 when no before_provider_request selector extension ran for this turn (e.g. the direct,
      // openrouter-auto and openrouter-pareto-code arms) — see router-selection.ts.
      router_latency_ms: takeRouterLatency(),
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
      // Not Diamond's Model Router charges no separate per-call fee — selection is separate from
      // inference, which is billed directly at the selected model's OpenRouter rate, same as
      // Auto/Pareto Code.
      router_cost: 0,
      cost_source: source,
    };

    appendCallLog(record);
  });
}
