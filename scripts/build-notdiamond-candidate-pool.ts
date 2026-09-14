// One-off/refresh script: fetches OpenRouter's live model catalog and prints
// NOTDIAMOND_CANDIDATE_MODELS covering everything from Not Diamond's own published catalog
// (docs.notdiamond.ai/docs/llm-models) that has a real, current OpenRouter slug — the broadest
// pool Not Diamond's API actually allows (it always requires an explicit llm_providers list, so
// this is the closest thing to "unrestricted" achievable; the other routers in this project need
// no candidate list from us at all).
//
// Every candidate is confirmed present in the live catalog before being printed, so nothing here
// is a stale/typo'd slug that would 404 later.
//
// Doesn't write .env directly — prints the line, paste it in yourself.
//
// Run with: npx tsx scripts/build-notdiamond-candidate-pool.ts

interface OpenRouterModel {
  id: string;
}

// Translated from Not Diamond's own catalog IDs (which carry dates/dashes, e.g.
// "claude-sonnet-4-6", "gpt-5-mini-2025-08-07") to their real OpenRouter slugs. Not Diamond's
// catalog also lists TogetherAI and Replicate entries — dropped entirely, not just individually:
// OpenRouter has no provider namespace for either at all, so nothing in those two providers is
// reachable this way. Older provider snapshots superseded by newer versions on OpenRouter were
// dropped too, not because they're invalid Not Diamond ids.
const CANDIDATES = [
  // OpenAI
  "openai/gpt-4o-2024-11-20",
  "openai/gpt-4o-2024-08-06",
  "openai/gpt-4o-2024-05-13",
  "openai/gpt-4-turbo",
  "openai/gpt-4o-mini-2024-07-18",
  "openai/gpt-4.1",
  "openai/gpt-4.1-mini",
  "openai/gpt-4.1-nano",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
  "openai/gpt-5.1",
  "openai/gpt-5.2",
  "openai/gpt-5.2-pro",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.5",
  "openai/gpt-oss-120b",
  // Anthropic
  "anthropic/claude-opus-4.7",
  "anthropic/claude-opus-4",
  "anthropic/claude-sonnet-4",
  "anthropic/claude-3-haiku",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-opus-4.1",
  // Google
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemma-4-31b-it",
  // Mistral
  "mistralai/mistral-large-2407",
  "mistralai/mixtral-8x22b-instruct",
  "mistralai/codestral-2508",
  "mistralai/mistral-medium-3.1",
  "mistralai/mistral-small-3.2-24b-instruct",
  "mistralai/mistral-nemo",
  // xAI
  "x-ai/grok-4.3",
  // DeepSeek
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  // Qwen
  "qwen/qwen3.6-plus",
  // Perplexity
  "perplexity/sonar",
  "perplexity/sonar-pro",
  // Minimax
  "minimax/minimax-m2.5",
  // Inception
  "inception/mercury-2",
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
