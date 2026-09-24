import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Two jobs for OpenRouter's own router products (Auto, Pareto Code), in one
 * `before_provider_request` hook. (1) Restores the documented "openrouter/" model id Pi's
 * request-building strips before sending — fatal for Pareto Code (404s on the bare id) and
 * undocumented behavior for Auto. (2) Injects the frozen router config from env (see
 * .env.example), if set — an unset var sends no plugins array, so each router falls back to its
 * own documented default. Scoped to ROUTER_BENCH_PROVIDER=openrouter (set by runner.ts). */
const RESTORE_MODEL_ID: Record<string, string> = {
  "pareto-code": "openrouter/pareto-code",
  auto: "openrouter/auto",
};

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** Builds the `plugins` array for the resolved (documented) model id, or undefined if nothing is
 * configured — undefined means "send no plugins array", not "send an empty one". */
function buildPlugins(resolvedModel: string): Array<Record<string, unknown>> | undefined {
  if (resolvedModel === "openrouter/pareto-code") {
    const minCodingScore = process.env.PARETO_MIN_CODING_SCORE;
    if (!minCodingScore) return undefined;
    return [{ id: "pareto-router", min_coding_score: Number(minCodingScore) }];
  }

  if (resolvedModel === "openrouter/auto") {
    // cost_tier (low/medium/high/xhigh/max) is Auto's current parameter; cost_quality_tradeoff
    // (0-10) is the deprecated one it replaced — OpenRouter still accepts it for backwards
    // compatibility, but cost_tier takes precedence if both are set. Confirmed directly against
    // OpenRouter's own docs (openrouter.ai/docs/guides/routing/routers/auto-router), not assumed.
    const costTier = process.env.AUTO_COST_TIER;
    const costQualityTradeoff = process.env.AUTO_COST_QUALITY_TRADEOFF;
    const allowedModels = splitList(process.env.AUTO_ALLOWED_MODELS);
    const excludedModels = splitList(process.env.AUTO_EXCLUDED_MODELS);
    if (!costTier && !costQualityTradeoff && !allowedModels && !excludedModels) return undefined;

    const plugin: Record<string, unknown> = { id: "auto-router" };
    if (costTier) plugin.cost_tier = costTier;
    if (costQualityTradeoff) plugin.cost_quality_tradeoff = Number(costQualityTradeoff);
    if (allowedModels) plugin.allowed_models = allowedModels;
    if (excludedModels) plugin.excluded_models = excludedModels;
    return [plugin];
  }

  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => {
    if (process.env.ROUTER_BENCH_PROVIDER !== "openrouter") return;

    const payload = event.payload as Record<string, unknown>;
    const resolvedModel = RESTORE_MODEL_ID[payload.model as string];
    if (!resolvedModel) return;

    const plugins = buildPlugins(resolvedModel);
    return { ...payload, model: resolvedModel, ...(plugins ? { plugins } : {}) };
  });
}
