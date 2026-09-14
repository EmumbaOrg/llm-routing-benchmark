import type { Arm } from "./types.js";

/** Named router arms. OpenRouter's Auto/Pareto Code need a `before_provider_request` fix (see
 * .pi/extensions/openrouter-router-config.ts); Not Diamond needs its own selector extension
 * (.pi/extensions/notdiamond-router.ts) since Pi's `model` field has to carry a synthetic id for
 * it to detect. GitHub Copilot bypasses Pi entirely (harness: "copilot", see copilot-runner.ts).
 * The direct-model (no router) arm isn't listed here — see buildDirectArm below. */
export const ARMS: Record<string, Arm> = {
  "openrouter-auto": {
    name: "openrouter-auto",
    harness: "pi",
    provider: "openrouter",
    model: "openrouter/auto",
    description: "Pi -> OpenRouter Auto Router -> selected model.",
  },
  "openrouter-pareto-code": {
    name: "openrouter-pareto-code",
    harness: "pi",
    provider: "openrouter",
    model: "openrouter/pareto-code",
    description: "Pi -> OpenRouter Pareto Code -> cheapest model above the frozen coding tier.",
  },
  notdiamond: {
    name: "notdiamond",
    harness: "pi",
    provider: "openrouter",
    // Synthetic id — .pi/extensions/notdiamond-router.ts detects it and swaps in the model Not
    // Diamond actually selects before Pi sends the request on to OpenRouter. `provider` stays
    // "openrouter" since that's who the (post-swap) request ultimately goes to, same as the two
    // arms above.
    model: "__router_notdiamond__",
    description: "Pi -> Not Diamond pre-trained Model Router -> selected model, sent via OpenRouter.",
  },
  "copilot-auto": {
    name: "copilot-auto",
    harness: "copilot",
    // No real provider/OpenRouter concept underneath a Copilot call — "copilot" is a descriptive
    // label (same idea as notdiamond's provider field describing who the request ultimately goes
    // to), and `model` is the CLI-facing knob ("auto" today; a future pinned-model variant would
    // set this to a real model id and copilot-runner.ts would pass --model <id>).
    provider: "copilot",
    model: "auto",
    description: "GitHub Copilot CLI (spawned directly, NOT through Pi) using its own Auto model routing.",
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
    harness: "pi",
    provider,
    model,
    description: `Pi -> ${provider} -> ${model} directly (no router in the loop).`,
  };
}

/** Resolves a CLI-facing arm label (as used by scripts/run-comparison.ts's --arms flag) to a real
 * Arm — "direct" isn't in ARMS (it needs a provider/model pair, not a fixed config entry), so it's
 * special-cased here rather than added to the registry. */
export function resolveArmByLabel(label: string, direct?: { provider: string; model: string }): Arm {
  if (label === "direct") {
    if (!direct) {
      throw new Error('resolveArmByLabel("direct", ...) requires the direct provider/model pair.');
    }
    return buildDirectArm(direct.provider, direct.model);
  }
  return getArm(label);
}
