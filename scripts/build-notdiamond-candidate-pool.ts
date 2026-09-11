// One-off/refresh script: fetches OpenRouter's live model catalog and prints a curated, broad
// NOTDIAMOND_CANDIDATE_MODELS value spanning every provider Not Diamond supports — replaces the
// narrow 2-3 model pool used for early testing. Every candidate is confirmed present in the live
// catalog before being printed, so nothing here is a stale/typo'd slug that would 404 later.
//
// Doesn't write .env directly — prints the line, paste it in yourself.
//
// Run with: npx tsx scripts/build-notdiamond-candidate-pool.ts

interface OpenRouterModel {
  id: string;
}

// Current-generation, non-batch models across every provider Not Diamond's own catalog supports
// (docs.notdiamond.ai/docs/llm-models) that also has real OpenRouter coverage. OpenAI gets the most
// representation (flagship, coding-specialized, and cost-efficient tiers); every other provider
// gets one flagship + one cost-efficient pick. Deliberately skips deprecated/old snapshots
// (gpt-3.5-turbo, claude-3-haiku, gemini-1.5-flash, etc.) — this is a curated current-generation
// pool, not Not Diamond's full historical catalog.
const CANDIDATES = [
  // OpenAI — priority representation
  "openai/gpt-5.5",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.4-mini",
  "openai/gpt-5-nano",
  // Anthropic
  "anthropic/claude-opus-5",
  "anthropic/claude-haiku-4.5",
  // Google
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.8-flash",
  // xAI
  "x-ai/grok-4.5",
  // DeepSeek
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash-0731",
  // Qwen
  "qwen/qwen3.7-max",
  // Mistral — coding-specialized
  "mistralai/codestral-2508",
];

async function main(): Promise<void> {
  console.log("Fetching https://openrouter.ai/api/v1/models ...");
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) {
    throw new Error(`OpenRouter models request failed (${response.status})`);
  }
  const payload = (await response.json()) as { data: OpenRouterModel[] };
  const liveIds = new Set(payload.data.map((m) => m.id));

  const missing = CANDIDATES.filter((slug) => !liveIds.has(slug));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} candidate slug(s) are not in OpenRouter's current live catalog — remove or ` +
        `update them before using this pool: ${missing.join(", ")}`,
    );
  }

  console.log(`\nAll ${CANDIDATES.length} candidates confirmed present in the live catalog.\n`);
  console.log("Paste this into .env:\n");
  console.log(`NOTDIAMOND_CANDIDATE_MODELS=${CANDIDATES.join(",")}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
