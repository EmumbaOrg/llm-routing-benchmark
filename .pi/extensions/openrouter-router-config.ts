import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Two jobs for OpenRouter's own router products (Auto, Pareto Code), both handled in the same
 * `before_provider_request` hook since both act on the same outgoing payload:
 *
 * 1. RESTORE THE DOCUMENTED MODEL ID. OpenRouter's router products live in OpenRouter's own
 *    "openrouter/" provider namespace — but Pi's request-building strips that prefix before
 *    sending (confirmed live, via a diagnostic before_provider_request dump). That's FATAL for
 *    Pareto Code (OpenRouter 404s on the bare "pareto-code" id — "No endpoints available") and
 *    silently relies on UNDOCUMENTED behavior for Auto (OpenRouter currently tolerates bare
 *    "auto", but its own docs only ever document "openrouter/auto"/"openrouter/auto-beta" as the
 *    two real slugs, and bare "auto" isn't in OpenRouter's public model catalogue at all).
 *
 * 2. INJECT THE FROZEN ROUTER CONFIG, if set. Spec §5/§6 ask to freeze Pareto's min_coding_score
 *    and Auto's cost setting "for the complete benchmark" and "record" the value used. Reading
 *    these from env (see .env.example) means that config lives in one discoverable, documented
 *    place instead of hardcoded here — and an unset var means NO plugins array is sent at all, so
 *    each router falls back to its own documented default (Pareto: High tier; Auto: full
 *    catalogue, account default cost setting) — this is the behavior already verified live and
 *    matches "no plugins array" being the deliberate starting point.
 *
 * Scoped to ROUTER_BENCH_PROVIDER=openrouter (set by runner.ts) so this never touches requests to
 * any other provider.
 */
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
    const costTier = process.env.AUTO_COST_TIER;
    // Deprecated (see .env.example) — OpenRouter still accepts it, cost_tier takes precedence if
    // both are set, so no need to enforce exclusivity ourselves.
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
