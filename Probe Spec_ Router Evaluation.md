# **Model-Decision Router Evaluation with Pi**

## **1\. Objective**

The purpose of this experiment is to evaluate **model-decision routers for agentic coding**: systems that inspect an incoming LLM request and decide which model is capable of handling it, ideally using the **cheapest model that can maintain acceptable task quality**.

This is specifically a model-selection experiment. Generic LLM gateways, proxies, fallbacks, load balancers and provider routers that do not make a semantic model-choice decision are out of scope.

The coding harness will be **Pi** for every experiment arm. The benchmark should therefore measure the effect of the routing policy while keeping the agent harness, tools, task environment and evaluation methodology fixed.

The recommended router set is:

| Router | Type | Why include it |
| ----- | ----- | ----- |
| **OpenRouter Pareto Code** | Decision \+ inference gateway | Most directly implements the hypothesis: choose the cheapest coding model above a capability threshold. |
| **OpenRouter Auto** | Decision \+ inference gateway | Managed general-purpose router balancing task complexity, capability and cost. |
| **Not Diamond Model Router** | Decision only | Gives direct access to the model-selection decision and lets us control the candidate pool and cost/quality preference. |
| **Avengers Pro** | Decision only, open source | Research router we can calibrate ourselves on coding tasks; useful contrast to proprietary routers. |
| **Microsoft Foundry Model Router** | Decision \+ inference gateway | Commercial trained router with an explicit **Cost** mode and support for agentic/tool-calling workloads. |

All five make an actual model-capability decision rather than simply choosing a provider endpoint.

---

# **2\. Routing architecture**

There are two integration patterns, depending on the router.

### **Decision \+ inference routers**

For **OpenRouter Pareto Code, OpenRouter Auto and Microsoft Foundry Model Router**, the router itself is exposed as the model endpoint.

Pi simply sends its normal LLM request to the router:

```
Pi agent
   │
   │ every LLM invocation
   ▼
Model router endpoint
   │
   ├─ inspect current request
   ├─ choose model
   └─ invoke chosen model
          │
          ▼
     response to Pi
```

No custom routing logic is required inside Pi.

### **Decision-only routers**

For **Not Diamond and Avengers Pro**, model selection is separate from model execution.

Use **OpenRouter as the common execution backend** and one Pi extension:

```
Pi agent
   │
   │ every LLM invocation
   ▼
before_provider_request extension
   │
   ├─ Not Diamond selector
   │        OR
   └─ Avengers Pro selector
            │
            ▼
      chosen model ID
            │
            ▼
extension replaces payload.model
            │
            ▼
        OpenRouter
            │
            ▼
       chosen model
```

Pi's `before_provider_request` event is designed for exactly this location in the lifecycle: it runs after Pi has constructed the provider-specific request but immediately before the HTTP request is sent, and it is allowed to asynchronously replace that provider payload.

This means there is **no additional routing gateway or proxy to implement**. Pi remains the agent, the Pi extension performs selection, and OpenRouter performs only model execution.

---

# **3\. Routing granularity: route every Pi LLM call**

The routing opportunity should be **every LLM invocation made by Pi**, not just the original coding-task prompt.

A typical coding-agent trajectory looks like:

```
User/SWE task
      │
      ▼
LLM call #1 ──► tool calls
                    │
                    ▼
              tool results
                    │
                    ▼
LLM call #2 ──► more tools
                    │
                    ▼
              tool results
                    │
                    ▼
LLM call #3
      ...
```

Each of those LLM calls can have materially different difficulty. The first may require repository-level reasoning, a later call may simply need to interpret a test result, another may need difficult debugging, and the final call may only need to summarize completed work.

Pi's lifecycle explicitly runs its per-call hooks for each LLM invocation, including calls following tool results.

Therefore:

> **One Pi LLM invocation \= one routing opportunity.**

This does **not** mean forcing a router to change models on every call. Every call should go through the router, but a router is allowed to decide that retaining the existing model is optimal.

That distinction matters because switching models can destroy prompt-cache reuse during long agent trajectories.

OpenRouter's routers deliberately support session stickiness, while GitHub Copilot Auto goes even further and deliberately changes models only at natural cache boundaries because GitHub found that mid-task model switching can increase cache cost without sufficient quality benefit.

So the benchmark should evaluate the router's **native policy**, not force artificial model churn.

---

# **4\. Common Pi configuration**

Pi supports custom models and custom providers through:

```
~/.pi/agent/models.json
```

Custom models can also be merged into built-in providers such as OpenRouter.

Set:

```shell
export OPENROUTER_API_KEY=...
export NOTDIAMOND_API_KEY=...
```

Add four experiment-facing OpenRouter entries: the two native OpenRouter routers and two synthetic model IDs used to activate the Pi selector extension.

Conceptually:

```json
{
  "providers": {
    "openrouter": {
      "models": [
        {
          "id": "openrouter/pareto-code",
          "name": "Router - Pareto Code"
        },
        {
          "id": "openrouter/auto",
          "name": "Router - OpenRouter Auto"
        },
        {
          "id": "__router_notdiamond__",
          "name": "Router - Not Diamond"
        },
        {
          "id": "__router_avengers__",
          "name": "Router - Avengers Pro"
        }
      ]
    }
  }
}
```

The last two IDs are deliberately synthetic. They will never be sent to OpenRouter because the extension replaces them with a real OpenRouter model ID immediately before transmission.

Keep the selector candidate pool limited to models that support the same agent requirements—particularly **tool calling, the required context length and compatible Chat Completions payloads**. Otherwise a router may select a cheap model that cannot actually execute the Pi turn.

---

# **5\. OpenRouter Pareto Code**

## **What it evaluates**

Pareto Code is the cleanest implementation of the experiment's core hypothesis.

The router maintains a current shortlist of coding models ranked using coding performance. The caller supplies a `min_coding_score`, which maps into a coding-quality tier. Within that tier, OpenRouter chooses the **cheapest currently available model**.

The concrete model that actually served the request is returned in the response's `model` field. There is no additional router fee; the request is billed at the selected model's normal rate.

## **Pi setup**

Select:

```
openrouter/pareto-code
```

as Pi's model.

Configure the desired `min_coding_score` once in **OpenRouter Settings → Plugins → Pareto Router** and keep that value frozen for the complete benchmark.

OpenRouter currently defines:

| Setting | Meaning |
| ----- | ----- |
| `>= 0.66` | High coding tier |
| `0.33–0.65` | Medium coding tier |
| `< 0.33` | Low coding tier |
| omitted | High |

Do not change this threshold between benchmark tasks.

Pi then requires no routing extension for this arm:

```
Pi → openrouter/pareto-code → selected coding model
```

OpenRouter supports session stickiness for Pareto Code. Keep that behavior enabled rather than deliberately forcing a new model on every step; caching behavior is part of the router's real cost-performance policy.

---

# **6\. OpenRouter Auto**

## **What it evaluates**

OpenRouter Auto analyzes prompt complexity, task type and model capabilities and chooses among its allowed models. It is currently powered by Not Diamond.

Its `cost_quality_tradeoff` ranges from:

```
0  = optimize heavily for quality
10 = optimize heavily for cost
```

with a current default of **7**. It adds no separate router charge; inference is billed at the selected model's price. Tool calling and streaming are supported.

## **Pi setup**

Select:

```
openrouter/auto
```

as the Pi model.

In OpenRouter's Auto Router settings:

1. Freeze the allowed-model set for the experiment rather than letting it drift during the benchmark.  
2. Freeze one `cost_quality_tradeoff` value for the complete run.  
3. Record both values in the experiment metadata.

Then:

```
Pi → openrouter/auto → selected model
```

No Pi routing extension is involved.

OpenRouter can preserve model/provider affinity within a multi-turn conversation. Leave this behavior intact.

---

# **7\. Not Diamond Model Router**

## **What it evaluates**

Not Diamond exposes model selection separately from inference.

Its current Model Router endpoint is:

```
POST https://api.notdiamond.ai/v2/modelRouter/modelSelect
```

and `type=openrouter` allows candidate and returned model identifiers to use OpenRouter model naming.

The selector accepts the current OpenAI-format messages, candidate models and tools, and can optimize across model capability, cost and latency. `cost_quality_tradeoff` provides a 0–10 continuum in which `0` is quality-first and `10` selects the cheapest candidate.

## **Pi setup**

Run Pi with the synthetic model:

```
__router_notdiamond__
```

The `before_provider_request` extension detects that ID.

For every Pi LLM request it should:

```
1. Preserve the complete provider payload.
2. Send payload.messages, payload.tools and the candidate model pool to Not Diamond.
3. Obtain the recommended OpenRouter model identifier.
4. Measure selector latency.
5. Replace payload.model with that identifier.
6. Return the modified payload.
7. Pi then sends the original request directly to OpenRouter.
```

The routing call should therefore conceptually be:

```json
{
  "messages": "<current Pi messages>",
  "tools": "<current Pi tools>",
  "llm_providers": "<fixed candidate pool>",
  "cost_quality_tradeoff": 7
}
```

with:

```
?type=openrouter
```

on the endpoint.

Use the same candidate pool for every benchmark task.

The exact `cost_quality_tradeoff` is an experiment parameter; choose it before running the evaluation and record it. Do not tune it against the final benchmark results.

---

# **8\. Avengers Pro**

## **What it evaluates**

Avengers Pro is an open-source test-time routing system.

Its routing mechanism is substantially different from the commercial routers. It embeds incoming queries, locates semantically related query clusters, uses observed per-model performance and efficiency within those clusters, and selects the model with the best performance-cost trade-off.

The published work reports Pareto-style quality/cost improvements across multiple benchmarks and models, but its router has to be **calibrated from performance and cost data**; it is not a pretrained universal coding router.

This makes it especially useful for the experiment because it tests whether a router trained from our own coding evaluations can outperform generic commercial routing.

## **Calibration**

Build Avengers Pro's routing data from a **separate calibration set of coding tasks**.

For every candidate model, collect:

```
task/query
model
task success or evaluation score
token usage
actual model cost
```

Do not train or calibrate the router on the benchmark instances used for the final reported results.

Use the same candidate model IDs that the Pi extension can subsequently execute through OpenRouter.

Export/load the resulting Avengers clustering/ranking state before benchmark execution.

## **Pi setup**

Run Pi with:

```
__router_avengers__
```

The same `before_provider_request` extension detects this identifier.

The extension sends a deterministic textual representation of the current agent state into the Avengers selector, receives an OpenRouter model ID and then replaces:

```
payload.model
```

before Pi sends the request to OpenRouter.

Because the Avengers reference implementation is Python, the practical implementation should load it once and keep it resident. For example:

```
Pi extension
     │
     └── persistent Avengers Python process
             │
             ├── clusters loaded once
             ├── request over stdin/JSONL
             └── selected model returned
```

Do **not** launch Python and reload the router for every Pi LLM call; that would contaminate routing latency with process startup and model-loading time.

The representation passed into Avengers must also match the representation used during calibration. A sensible coding-agent representation is:

```
original coding task
+
most recent agent/tool context
```

rather than only the latest tool result. This allows the router to understand both the overall objective and what the agent is currently trying to accomplish.

Use the exact same construction during calibration and evaluation.

---

# **9\. Pi selector extension**

Not Diamond and Avengers Pro can share one extension.

Place it in the project-level Pi extensions directory, for example:

```
.pi/extensions/model-router.ts
```

The implementation pattern is:

```ts
const NOT_DIAMOND = "__router_notdiamond__";
const AVENGERS = "__router_avengers__";

export default function (pi) {
  let callIndex = 0;

  pi.on("before_provider_request", async (event, ctx) => {
    const payload = event.payload;

    if (
      payload.model !== NOT_DIAMOND &&
      payload.model !== AVENGERS
    ) {
      return;
    }

    const router = payload.model;
    const routeStart = performance.now();

    let selectedModel;

    if (router === NOT_DIAMOND) {
      const response = await fetch(
        "https://api.notdiamond.ai/v2/modelRouter/modelSelect?type=openrouter",
        {
          method: "POST",
          headers: {
            "Authorization":
              `Bearer ${process.env.NOTDIAMOND_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messages: payload.messages,
            tools: payload.tools,
            llm_providers: CANDIDATE_MODELS,
            cost_quality_tradeoff: ROUTER_TRADEOFF
          })
        }
      );

      if (!response.ok) {
        throw new Error(
          `Not Diamond routing failed: ${response.status}`
        );
      }

      const result = await response.json();

      // Parse the selected model according to the
      // current Not Diamond response schema.
      selectedModel = selectedModelFromResponse(result);
    }

    if (router === AVENGERS) {
      const routingText =
        buildAvengersRoutingText(payload.messages);

      selectedModel =
        await avengersSelector.select(routingText);
    }

    const routerLatencyMs =
      performance.now() - routeStart;

    callIndex += 1;

    logRoutingDecision({
      callIndex,
      router,
      selectedModel,
      routerLatencyMs
    });

    return {
      ...payload,
      model: selectedModel
    };
  });
}
```

Pi documents that `before_provider_request` may asynchronously return a replacement provider payload immediately before transmission, so the model substitution occurs on the **same LLM request that triggered the routing decision**.

---

# **10\. Microsoft Foundry Model Router**

## **What it evaluates**

Microsoft's Model Router is a trained router that analyzes the **full request**, including system instructions, conversation history and tool definitions, then chooses among its eligible models.

It exposes three routing modes:

| Mode | Behavior |
| ----- | ----- |
| Balanced | Balance quality and cost |
| **Cost** | Aggressively favor cheaper models |
| Quality | Favor highest-quality model |

For this experiment use **Cost mode**, because it most closely matches the objective of finding the least-expensive model capable of servicing the request.

Microsoft explicitly supports multi-turn conversations, long contexts, agentic workloads and tool calling. The current response contains the concrete underlying model in its `model` field.

Microsoft also explicitly describes agent routing as occurring **per request/per turn rather than once per session**.

## **Foundry setup**

In Microsoft Foundry:

1. Deploy the current `model-router`.  
2. Change routing mode to **Cost**.  
3. Select the desired candidate-model subset rather than leaving an uncontrolled pool.  
4. Give the deployment a fixed name such as `router-cost-eval`.

Microsoft exposes the router as a normal model deployment: the deployment name is simply supplied in the normal `model` field.

Configure Pi:

```shell
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://<resource>.openai.azure.com
```

Pi's Azure OpenAI provider uses:

```
azure-openai-responses
```

and treats Azure deployment names as model IDs.

Add the deployment to Pi if necessary:

```json
{
  "providers": {
    "azure-openai-responses": {
      "models": [
        {
          "id": "router-cost-eval",
          "name": "Microsoft Foundry Router - Cost"
        }
      ]
    }
  }
}
```

Then select:

```
router-cost-eval
```

in Pi.

No Pi routing extension is involved:

```
Pi → Foundry model-router deployment → selected model
```

---

# **11\. Candidate-model control**

Router comparisons become difficult to interpret if one router can choose among five models and another can choose among twenty completely different models.

Therefore use a common candidate pool wherever the router permits it.

For example, define one canonical experiment pool:

```
MODEL_POOL = [
    cheap model,
    low-mid model,
    strong mid-tier model,
    frontier model
]
```

The specific models should span meaningfully different cost/capability levels while all supporting Pi's required coding-agent features.

Use that exact pool for **Not Diamond and Avengers Pro** and restrict **OpenRouter Auto** to the same models where supported.

Pareto Code is intentionally different because its product is defined around OpenRouter's evolving coding-quality tiers. Microsoft Foundry also has its own supported model set. Record the exact pool, router version and configuration used for those arms so results remain reproducible.

---

# **12\. Baselines**

Routing results need to be compared against fixed models.

Run Pi on the same benchmark using each important candidate model directly, particularly:

```
fixed cheapest model
fixed mid-tier model
fixed strongest/frontier model
```

For OpenRouter-backed baselines, invoke those models directly through OpenRouter so Not Diamond and Avengers execution uses the same underlying provider path as the controls.

The key question is not merely:

> Did the router choose cheaper models?

It is:

> Can the router reduce total end-to-end task cost without materially reducing coding success?

A cheaper model can require additional reasoning loops, generate more tool calls, make mistakes requiring recovery, or repeatedly replay a large context. Consequently, model price per token alone is not an adequate routing metric.

---

# **13\. Instrumentation**

Create **one log record for every Pi LLM invocation**.

At minimum record:

| Field | Purpose |
| ----- | ----- |
| `task_id` | Benchmark task |
| `router` | Experimental arm |
| `call_index` / Pi turn | Position in agent trajectory |
| `selected_model` | Concrete model used |
| `router_latency_ms` | Time spent choosing model |
| `input_tokens` | Model input |
| `output_tokens` | Generated output |
| `cache_read_tokens` | Cached input if reported |
| `cache_write_tokens` | Cache creation if reported |
| `model_latency_ms` | LLM execution time |
| `total_call_latency_ms` | Routing \+ inference |
| `tool_calls` | Tools requested during turn |
| `retry/error` | Failed/rerouted calls |
| `model_cost` | Actual inference cost |
| `router_cost` | Router-specific fee, if any |

For selector-only routers, the selected model recorded by the Pi extension is authoritative.

For OpenRouter Pareto and Auto, the API response's `model` field identifies the concrete model that served the request.

For Foundry, the standard response's `model` field similarly reveals the underlying selected model.

Do not rely solely on Pi's configured model-price metadata to calculate routed-call costs: Pi initially sees a synthetic/router model, while the actual inference may come from a different model. Compute cost using the **actual selected model \+ token/cache usage \+ a frozen pricing table**, and reconcile OpenRouter-backed runs against OpenRouter's actual billed usage.

---

# **14\. Task-level evaluation**

Aggregate the call-level log into task-level outcomes.

The primary metrics should be:

| Metric | Why it matters |
| ----- | ----- |
| **Task solve rate** | Primary quality metric |
| **Total dollars per attempted task** | Actual cost impact |
| **Dollars per successfully solved task** | Best combined cost/quality metric |
| **Total wall-clock task time** | User-facing efficiency |
| LLM calls per task | Whether cheaper models create extra work |
| Input/output/cache tokens | Explains cost behavior |
| Model-selection distribution | Shows how router behaves |
| Routing latency | Cost of making the decision |
| Retry/error rate | Router/model reliability |

The most important comparison is **dollars per successfully solved task**, not average price of the selected models.

A router could select models whose list prices are dramatically cheaper but still save little if those choices produce longer trajectories or invalidate caches.

---

# **15\. Interpreting “per-call routing” against Cursor and Copilot**

Current Cursor documentation says Cursor Router runs a classifier on **each agent request** and sends simpler requests to cheaper models while escalating difficult requests to stronger ones. Cursor describes the goal as selecting the most cost-effective model that can provide comparable quality. Its public documentation does not establish the exact granularity of every hidden internal provider call, so this should be treated as per-agent-request routing rather than evidence about every implementation-level tool continuation.

GitHub Copilot Auto uses a different strategy. It evaluates task complexity but deliberately restricts model changes to **natural cache boundaries**, such as a new session or after `/compact`; GitHub explicitly says it does not switch models mid-task because doing so can increase cache-related costs.

The correct policy for this Pi experiment is therefore:

> **Pass every Pi LLM invocation through the selected routing system, but allow the routing system's native policy to decide whether the model should actually change.**

For Not Diamond and Avengers Pro, our implementation explicitly asks for a decision on each Pi LLM invocation.

For OpenRouter Auto, Pareto Code and Foundry, every invocation goes through the router endpoint and the router controls its own selection/stickiness behavior.

---

# **16\. Recommended experiment matrix**

| Arm | Pi execution path |
| ----- | ----- |
| Fixed cheap model | Pi → OpenRouter → fixed model |
| Fixed mid-tier model | Pi → OpenRouter → fixed model |
| Fixed frontier model | Pi → OpenRouter → fixed model |
| **Avengers Pro** | Pi → Pi selector extension → OpenRouter → selected model |
| **Not Diamond** | Pi → Pi selector extension → OpenRouter → selected model |
| **OpenRouter Pareto Code** | Pi → Pareto Code → selected model |
| **OpenRouter Auto** | Pi → Auto Router → selected model |
| **Microsoft Foundry Model Router** | Pi → Foundry Router Cost → selected model |

Use the identical Pi version, tools, system instructions, benchmark environment, task timeout and task set for all arms.

Router configuration must be frozen before evaluation. Record the candidate model set, prices, router parameters and router/model versions alongside the results.

---

# **17\. Developer implementation checklist**

1. **Create the fixed model pool** and verify every model supports the Pi tool-calling workflow.  
2. **Set up OpenRouter** and run the fixed-model baselines.  
3. Add `openrouter/pareto-code` and `openrouter/auto` to Pi and freeze their router settings.  
4. Create `.pi/extensions/model-router.ts`.  
5. Implement the Not Diamond branch and verify that every provider request is rewritten to the returned OpenRouter model.  
6. Calibrate Avengers Pro on a separate coding dataset, keep the selector resident, and connect it to the same Pi extension.  
7. Deploy Microsoft Foundry `model-router` in **Cost** mode and add its deployment to Pi.  
8. Add per-LLM-call instrumentation and verify that concrete selected-model IDs are captured.  
9. Run a small smoke set and inspect complete trajectories before launching the benchmark.  
10. Run every router and fixed-model baseline over the same evaluation tasks.  
11. Report solve rate, task cost, cost per solved task, latency, turns per task, routing mix and cache behavior.

The final comparison should answer one practical question:

> **Does model-decision routing make a Pi coding agent materially cheaper while preserving the success rate we would obtain from using a strong model throughout?**

