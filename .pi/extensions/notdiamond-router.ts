import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { recordRouterLatency } from "../../src/router-selection.js";

/**
 * Not Diamond's pre-trained (general) Model Router. Pi is run with the synthetic model id below;
 * this `before_provider_request` hook detects it, calls Not Diamond's selection endpoint, swaps in
 * the real model it picked, and lets Pi send the (now-real) request straight to OpenRouter itself
 * — Not Diamond never sees or proxies the actual inference call.
 *
 * The candidate pool is fetched live from Not Diamond's own `GET /v2/models` on every call — not a
 * frozen env-configured list — so it always reflects whatever Not Diamond currently supports,
 * including models with no OpenRouter mapping at all. That's also why the `?type=openrouter` query
 * param is deliberately omitted from the modelSelect call: native mode accepts every model Not
 * Diamond knows about (RequestProvider's plain {provider, model} shape), not just the subset
 * `type=openrouter` would otherwise restrict `llm_providers` to.
 *
 * Since ROUTER_BENCH_PROVIDER is fixed to "openrouter" for this arm (see arms.ts), whatever Not
 * Diamond selects still has to resolve to a real OpenRouter slug for Pi's actual inference call
 * downstream — see the out-of-scope check below for what happens when it doesn't.
 */
const NOT_DIAMOND_MODEL_ID = "__router_notdiamond__";

interface NotDiamondCatalogModel {
  provider: string;
  model: string;
}

interface NotDiamondModelsResponse {
  models: NotDiamondCatalogModel[];
}

interface NotDiamondSelectedProvider {
  provider: string;
  model: string;
}

interface NotDiamondSelectResponse {
  providers: NotDiamondSelectedProvider[];
  session_id: string;
}

interface OpenRouterModel {
  id: string;
}

/** Live, unfiltered — every model Not Diamond currently knows about, not a frozen/curated subset.
 * Confirmed stale in practice once: a hand-maintained env-configured list silently drifted behind
 * Not Diamond's real catalog and changed routing outcomes materially once corrected. Fetching live
 * on every call means this can't happen again. */
async function fetchFullCandidatePool(): Promise<NotDiamondCatalogModel[]> {
  const response = await fetch("https://api.notdiamond.ai/v2/models", {
    headers: { Authorization: `Bearer ${process.env.NOTDIAMOND_API_KEY}` },
  });
  if (!response.ok) {
    throw new Error(`Not Diamond GET /v2/models failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as NotDiamondModelsResponse;
  return data.models.map((m) => ({ provider: m.provider, model: m.model }));
}

/** Not Diamond's native mode returns whatever provider/model pair it selected verbatim — no
 * `?type=openrouter` reshaping to second-guess. `<provider>/<model>` is simply OpenRouter's own
 * slug convention, so this is a direct formatting of Not Diamond's real answer, not a remapping to
 * a different model. */
function toOpenRouterSlug(selected: NotDiamondSelectedProvider): string {
  return `${selected.provider}/${selected.model}`;
}

/** Not every model Not Diamond can select natively has a real OpenRouter counterpart (e.g.
 * TogetherAI/Replicate-only models, or naming that doesn't line up). Since this arm's downstream
 * inference call always goes through OpenRouter, a selection with no live OpenRouter match would
 * otherwise fail silently deep in Pi's own request — warn here instead, where the actual selection
 * is known, so it's clear the model Not Diamond picked is what's actually out of scope. */
async function warnIfOutOfOpenRouterScope(slug: string): Promise<void> {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) {
    console.warn(`notdiamond-router: could not verify "${slug}" against OpenRouter's live catalog (${response.status})`);
    return;
  }
  const payload = (await response.json()) as { data: OpenRouterModel[] };
  const liveIds = new Set(payload.data.map((m) => m.id));
  if (!liveIds.has(slug)) {
    console.warn(
      `notdiamond-router: Not Diamond selected "${slug}", which has no live OpenRouter mapping — ` +
        "this arm's inference call is expected to fail since it always routes through OpenRouter.",
    );
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown>;
    if (payload.model !== NOT_DIAMOND_MODEL_ID) return;

    const candidatePool = await fetchFullCandidatePool();
    // Frozen once per experiment and recorded, not tuned live; unset means Not Diamond's own
    // documented default (7) applies.
    const costQualityTradeoffEnv = process.env.NOTDIAMOND_COST_QUALITY_TRADEOFF;
    const costQualityTradeoff = costQualityTradeoffEnv ? Number(costQualityTradeoffEnv) : undefined;

    const routeStart = performance.now();
    // No `?type=openrouter` — native mode, so llm_providers takes the plain {provider, model} shape.
    const response = await fetch("https://api.notdiamond.ai/v2/modelRouter/modelSelect", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NOTDIAMOND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: payload.messages,
        tools: payload.tools,
        llm_providers: candidatePool,
        ...(costQualityTradeoff !== undefined ? { cost_quality_tradeoff: costQualityTradeoff } : {}),
      }),
    });
    const latencyMs = Math.round(performance.now() - routeStart);
    recordRouterLatency(latencyMs);

    if (!response.ok) {
      throw new Error(`Not Diamond routing failed: ${response.status} ${await response.text()}`);
    }
    const result = (await response.json()) as NotDiamondSelectResponse;
    const selected = result.providers[0];
    if (!selected) {
      throw new Error("Not Diamond returned no providers in its routing response.");
    }

    const slug = toOpenRouterSlug(selected);
    await warnIfOutOfOpenRouterScope(slug);

    return { ...payload, model: slug };
  });
}
