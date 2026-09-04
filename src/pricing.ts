import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { CallLogRecord } from "./types.js";

/** The shape of `event.message.usage` on Pi's `turn_end`/`message_end` events (see extensions.md). */
export interface PiUsage {
  input?: number;
  output?: number;
  cost?: { total?: number };
  cacheRead?: number;
  cacheWrite?: number;
}

const OPENROUTER_PRICING_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "openrouter-pricing.json",
);

interface OpenRouterPrice {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
}

let openRouterPrices: Record<string, OpenRouterPrice> | null = null;

/**
 * Loaded from data/openrouter-pricing.json (scripts/fetch-openrouter-pricing.ts), a frozen
 * snapshot of OpenRouter's real published per-token prices for every model — needed because Pi
 * does NOT compute real cost for OpenRouter's router models (openrouter/auto,
 * openrouter/pareto-code): confirmed live, `usage.cost.total` stays 0 for the whole call, since Pi
 * has no static local price for a virtual routing id. Lazy + cached: only read once per process.
 */
function loadOpenRouterPrices(): Record<string, OpenRouterPrice> {
  if (openRouterPrices) return openRouterPrices;
  if (!existsSync(OPENROUTER_PRICING_PATH)) {
    openRouterPrices = {};
    return openRouterPrices;
  }
  const file = JSON.parse(readFileSync(OPENROUTER_PRICING_PATH, "utf8")) as { prices: Record<string, OpenRouterPrice> };
  openRouterPrices = file.prices;
  return openRouterPrices;
}

function costFromOpenRouterTable(model: string, usage: PiUsage | undefined): number | null {
  const price = loadOpenRouterPrices()[model];
  if (!price) return null;
  return (
    (usage?.input ?? 0) * price.prompt +
    (usage?.output ?? 0) * price.completion +
    (usage?.cacheRead ?? 0) * price.cacheRead +
    (usage?.cacheWrite ?? 0) * price.cacheWrite
  );
}

/**
 * Hand-maintained $/1M-token fallback for non-OpenRouter providers, only if Pi's own reported
 * cost is ever missing. Left EMPTY: Pi's self-reported cost has proven accurate for direct
 * anthropic/openai/local-provider calls (real runs this session) — this stays dormant unless a
 * live call proves that wrong for some other provider/model.
 */
export const FROZEN_PRICES: Record<string, { inputPer1M: number; outputPer1M: number }> = {};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = FROZEN_PRICES[model];
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.inputPer1M + (outputTokens / 1_000_000) * price.outputPer1M;
}

export function getCallCost(
  provider: string,
  model: string,
  usage: PiUsage | undefined,
): { cost: number; source: CallLogRecord["cost_source"] } {
  // OpenRouter specifically: Pi's own cost is unreliable for router models (proven $0 live), so
  // prefer our own real-pricing-table computation whenever the resolved model is in it — not just
  // as a fallback for when Pi reports 0, since a genuinely-free model could also legitimately cost
  // $0 and we'd rather trust the real published price either way.
  if (provider === "openrouter") {
    const fromTable = costFromOpenRouterTable(model, usage);
    if (fromTable !== null) {
      return { cost: fromTable, source: "openrouter_pricing_table" };
    }
  }

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
