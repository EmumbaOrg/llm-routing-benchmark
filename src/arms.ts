import type { Arm } from "./types.js";

/**
 * Experimental arms available this phase. Both OpenRouter router products need zero Pi extension
 * logic (spec §5/§6 — "no Pi routing extension is involved"), so they're wired identically to the
 * direct-model arm: just a different `model` id. Not Diamond / Avengers Pro / Foundry arms need
 * the `before_provider_request` selector extension and aren't in scope yet.
 *
 * `direct`'s model is intentionally left blank — the fixed baseline model is a decision for later
 * (see the plan). Fill it in before selecting `--arm direct`.
 */
export const ARMS: Record<string, Arm> = {
  direct: {
    name: "direct",
    provider: "openrouter",
    model: "", // TODO: fixed baseline model, decided later
    description: "Pi -> OpenRouter -> a fixed, named model (no router in the loop).",
  },
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
  if (!arm.model) {
    throw new Error(`Arm "${name}" has no model configured yet (see arms.ts TODO).`);
  }
  return arm;
}
