import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { recordRouterLatency } from "../../src/router-selection.js";

/**
 * Not Diamond's pre-trained (general) Model Router — spec §7. Pi is run with the synthetic model
 * id below; this `before_provider_request` hook detects it, calls Not Diamond's selection
 * endpoint, swaps in the real model it picked, and lets Pi send the (now-real) request straight
 * to OpenRouter itself — Not Diamond never sees or proxies the actual inference call.
 *
 * Endpoint/schema confirmed 2026-09-07 against Not Diamond's own live API reference
 * (docs.notdiamond.ai/reference/token_model_select_v2_modelrouter_modelselect_post), AND against a
 * real request (scripts/diagnose-notdiamond-select.ts, Not-Diamond-only, no LLM provider call).
 * That live call ruled out the docs' own {provider, model} shape for `llm_providers` under
 * ?type=openrouter — sending `provider: "openrouter"` per entry gets a 400 ("All providers must be
 * OpenRouterProvider instances"). The shape that actually works is `{model: "<slug>"}` with NO
 * `provider` field at all — confirmed 200, with the response echoing back
 * `{"provider":"openrouter","model":"<the same slug>"}`.
 */
const NOT_DIAMOND_MODEL_ID = "__router_notdiamond__";

interface NotDiamondCandidate {
  model: string;
}

interface NotDiamondSelectedProvider {
  provider: string;
  model: string;
}

interface NotDiamondSelectResponse {
  providers: NotDiamondSelectedProvider[];
  session_id: string;
}

/** NOTDIAMOND_CANDIDATE_MODELS: comma-separated OpenRouter model slugs, e.g.
 * "anthropic/claude-sonnet-4.5,openai/gpt-5-mini" — frozen once per spec §4/§7, same convention as
 * AUTO_ALLOWED_MODELS. Sent to Not Diamond as {model: slug} — no `provider` field, confirmed live
 * (see the module doc comment above). */
function parseCandidatePool(value: string | undefined): NotDiamondCandidate[] {
  if (!value) {
    throw new Error(
      "NOTDIAMOND_CANDIDATE_MODELS must be set (comma-separated OpenRouter model slugs) to use __router_notdiamond__.",
    );
  }
  const slugs = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (slugs.length === 0) {
    throw new Error("NOTDIAMOND_CANDIDATE_MODELS is set but contains no model slugs.");
  }
  return slugs.map((model) => ({ model }));
}

/** Turns a Not Diamond provider/model pair back into an OpenRouter model id Pi can send. Confirmed
 * live that `provider` always comes back "openrouter" under ?type=openrouter, in which case
 * `model` is already the full slug; the provider/model fallback below is defensive only, for a
 * shape not seen in the live call. */
function resolveOpenRouterModelId(selected: NotDiamondSelectedProvider): string {
  return selected.provider === "openrouter" ? selected.model : `${selected.provider}/${selected.model}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown>;
    if (payload.model !== NOT_DIAMOND_MODEL_ID) return;

    const candidatePool = parseCandidatePool(process.env.NOTDIAMOND_CANDIDATE_MODELS);
    // Optional — spec §7 asks to freeze one value per experiment and record it, not to tune it
    // live; unset means Not Diamond's own documented default (7) applies.
    const costQualityTradeoffEnv = process.env.NOTDIAMOND_COST_QUALITY_TRADEOFF;
    const costQualityTradeoff = costQualityTradeoffEnv ? Number(costQualityTradeoffEnv) : undefined;

    const routeStart = performance.now();
    const response = await fetch("https://api.notdiamond.ai/v2/modelRouter/modelSelect?type=openrouter", {
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

    return { ...payload, model: resolveOpenRouterModelId(selected) };
  });
}
