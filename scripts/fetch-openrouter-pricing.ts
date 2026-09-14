// One-off/refresh script: fetches OpenRouter's public model catalogue (no auth needed) and
// freezes per-token pricing for every model into data/openrouter-pricing.json.
//
// Why this exists: Pi does not compute real cost for OpenRouter's router models (openrouter/auto,
// openrouter/pareto-code) — `usage.cost.total` stays 0 for the whole call, because Pi has no
// static price for a virtual routing id. OpenRouter's response itself DOES carry real billed cost,
// but Pi's own normalization doesn't surface it. So pricing.ts computes cost itself from (real
// resolved model, from message.responseModel) x (real token counts, already logged) x (this frozen
// table), instead of trusting Pi's report for openrouter-provider calls.
//
// Re-run this whenever OpenRouter's pricing may have moved and you want the benchmark's cost
// numbers to reflect current rates — it's a frozen snapshot, not a live lookup per call.
//
// Run with: npx tsx scripts/fetch-openrouter-pricing.ts

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUTPUT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "openrouter-pricing.json");

interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

async function main(): Promise<void> {
  console.log("Fetching https://openrouter.ai/api/v1/models ...");
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed (${response.status})`);
  }
  const payload = (await response.json()) as { data: OpenRouterModel[] };

  const prices: Record<string, { prompt: number; completion: number; cacheRead: number; cacheWrite: number }> = {};
  for (const model of payload.data) {
    if (!model.pricing) continue;
    prices[model.id] = {
      prompt: Number(model.pricing.prompt ?? 0),
      completion: Number(model.pricing.completion ?? 0),
      cacheRead: Number(model.pricing.input_cache_read ?? 0),
      cacheWrite: Number(model.pricing.input_cache_write ?? 0),
    };
  }

  const outputDir = dirname(OUTPUT_PATH);
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify({ fetched_at: new Date().toISOString(), source: "https://openrouter.ai/api/v1/models", prices }, null, 2) + "\n",
    "utf8",
  );
  console.log(`Wrote ${Object.keys(prices).length} model prices to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
