import type { Arm } from "./types.js";

/**
 * Named router arms. The spec (§5/§6) says both OpenRouter router products need zero Pi extension
 * logic — just a different `model` id, same as a direct call. In practice that's not quite true:
 * Pi strips OpenRouter's own "openrouter/" namespace prefix before sending, which 404s Pareto Code
 * outright and leaves Auto depending on undocumented behavior (see
 * .pi/extensions/openrouter-router-config.ts for the full story and the fix). Not Diamond / Avengers Pro /
 * Foundry arms need their own `before_provider_request` selector extension and aren't in scope yet.
 *
 * The direct-model (no router) arm isn't listed here — it takes an arbitrary provider/model at
 * the CLI (`--provider`/`--model`) instead of a fixed config entry, so trying a different baseline
 * model doesn't need an edit here. See buildDirectArm below.
 */
export const ARMS: Record<string, Arm> = {
  "openrouter-auto": {
    name: "openrouter-auto",
    provider: "openrouter",
    model: "openrouter/auto",
    description: "Pi -> OpenRouter Auto Router -> selected model. See spec §6.",
  },
  "openrouter-pareto-code": {
    name: "openrouter-pareto-code",
    provider: "openrouter",
    model: "openrouter/pareto-code",
    description: "Pi -> OpenRouter Pareto Code -> cheapest model above the frozen coding tier. See spec §5.",
  },
};

export function getArm(name: string): Arm {
  const arm = ARMS[name];
  if (!arm) {
    throw new Error(`Unknown arm "${name}". Known arms: ${Object.keys(ARMS).join(", ")}`);
  }
  return arm;
}

/** Builds the ad-hoc "direct" arm (no router — Pi -> provider -> a fixed, named model) from CLI
 * input, so any provider/model can be used as a baseline without editing ARMS. */
export function buildDirectArm(provider: string, model: string): Arm {
  return {
    name: "direct",
    provider,
    model,
    description: `Pi -> ${provider} -> ${model} directly (no router in the loop).`,
  };
}
