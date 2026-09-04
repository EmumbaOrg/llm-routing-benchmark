import type { CallLogRecord } from "./types.js";

/** The shape of `event.message.usage` on Pi's `turn_end`/`message_end` events (see extensions.md). */
export interface PiUsage {
  input?: number;
  output?: number;
  cost?: { total?: number };
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Frozen $/1M-token price table — the fallback path the user asked for ("if not, build a
 * queryable table and freeze it"). Left EMPTY: verified against OpenRouter's docs that every
 * chat-completion response now carries real billed cost in `usage.cost` automatically (no
 * `usage: {include: true}` needed anymore), and Pi's own `turn_end` usage should pass that
 * through — so this table is only needed if a live call proves that assumption wrong for some
 * model/arm. Do not populate with guessed numbers; fill in only real, checked prices if/when
 * `getCallCost` actually needs to fall back here.
 */
export const FROZEN_PRICES: Record<string, { inputPer1M: number; outputPer1M: number }> = {};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = FROZEN_PRICES[model];
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.inputPer1M + (outputTokens / 1_000_000) * price.outputPer1M;
}

export function getCallCost(
  model: string,
  usage: PiUsage | undefined,
): { cost: number; source: CallLogRecord["cost_source"] } {
  const piCost = usage?.cost?.total;
  if (typeof piCost === "number") {
    return { cost: piCost, source: "pi_reported" };
  }
  const estimated = estimateCost(model, usage?.input ?? 0, usage?.output ?? 0);
  if (estimated !== null) {
    return { cost: estimated, source: "frozen_table" };
  }
  return { cost: 0, source: "unknown" };
}
