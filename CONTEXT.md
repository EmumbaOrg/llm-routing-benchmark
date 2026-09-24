# Domain glossary

Terms used throughout this project's code, docs, and reports. Written to give a new reader (or a
future AI session) the same vocabulary without re-deriving it from source each time.

**Arm** — one experimental configuration under comparison: a provider/model target plus (for
routed arms) a routing mechanism. Defined in `src/arms.ts`'s `ARMS` registry, except `direct`,
which is built ad hoc from CLI flags (`buildDirectArm`) since it takes an arbitrary provider/model
rather than a fixed config entry. Current arms: `direct`, `openrouter-auto`,
`openrouter-pareto-code`, `notdiamond`, `copilot-auto`.

**Harness** — the process that actually executes a task and produces a candidate solution. Two
exist: **Pi** (`pi` CLI, spawned per `Arm.harness: "pi"`, used by every arm except Copilot) and the
**GitHub Copilot CLI** (`copilot`, spawned directly by `copilot-runner.ts` for `Arm.harness:
"copilot"`, since Copilot is a self-contained agent with its own model selection — Pi never routes
to it). Every task, in every arm, is a **single-shot exchange**: one prompt in, one final answer
out — no tool calls, no multi-turn conversation, no file access.

**Router** — a system that picks which model handles a request, as opposed to a fixed model. Two
distinct mechanisms show up here:
- **Decision + inference combined** (`openrouter-auto`, `openrouter-pareto-code`, `copilot-auto`):
  one call to the router; it picks the model *and* runs inference in that same request, then
  reports back which model it used.
- **Decision only** (`notdiamond`): the router's API call returns *only* which provider/model to
  use — it never runs inference itself. The actual task is then sent to that model as a separate,
  second request (via OpenRouter). This is the only arm in the project shaped this way.

**Candidate pool** — the set of models a router is allowed to pick from. This project deliberately
keeps every router's pool **unrestricted** (no curated/frozen shortlist) to test each router's own
native policy rather than a policy this project imposes:
- `notdiamond` fetches Not Diamond's full live catalog (`GET /v2/models`) fresh on every single
  call — see `.pi/extensions/notdiamond-router.ts`.
- `openrouter-auto` supports an allow/exclude-list env knob but it's left blank.
- `openrouter-pareto-code` has no allow/exclude-list knob at all, only a capability-score floor
  (see below) — the closest thing to a restriction, but it's a quality bar, not a named list.
- `copilot-auto` has no restriction lever available to this project at all (only an org-wide
  GitHub admin policy could impose one, and none is applied).

**Cost/quality tradeoff** — an optional 0–10 preference dial some routers accept (0 = the router's
own quality-first default). It biases *which* model within the pool a router leans toward; it does
not remove any model from eligibility. Supplied here as `7` for both `notdiamond`
(`NOTDIAMOND_COST_QUALITY_TRADEOFF`) and `openrouter-auto` (`AUTO_COST_QUALITY_TRADEOFF`).
`openrouter-pareto-code` uses a different, unrelated dial instead: `PARETO_MIN_CODING_SCORE`
(0–1), a coding-capability floor below which a model is dropped from consideration entirely — the
one arm/knob combination in this project that's a real eligibility filter rather than a
preference.

For `openrouter-auto` specifically: `AUTO_COST_QUALITY_TRADEOFF` (0–10) is OpenRouter's
**deprecated** legacy parameter — confirmed against OpenRouter's own docs, not assumed. Its
replacement, `AUTO_COST_TIER` (`low`/`medium`/`high`/`xhigh`/`max`), is the current parameter and
takes precedence if both are set. This project currently configures the deprecated one; it still
works (kept for backwards compatibility), it's just not the parameter OpenRouter's docs now point
new integrations toward.

**Pinned task set** — the fixed 20 BigCodeBench-Instruct tasks every arm/run is measured against
(`data/pinned-tasks.json`). Originally a stratified sample of 24 (see
`scripts/select-pinned-tasks.ts`); 4 were later hand-removed (recorded under the file's
`excluded_tasks`) after a real comparison run showed every arm failing them identically due to
genuine prompt/test spec bugs, not model shortcomings. **20 is the real, current count** — treat
`sample_size` in the JSON as the corrected, post-exclusion number, not the script's original
constant.

**Run** — one execution of the benchmark loop against the pinned task set, identified by a
`run_id`. Produces three JSONL files per run: `call-log-<run_id>.jsonl` (one row per LLM
invocation — see `CallLogRecord`), `task-results-<run_id>.jsonl` (one row per task — the rollup of
that task's calls, see `TaskResult`), and `task-detail-<run_id>.jsonl` (the full raw
response/solution text behind each result's terse outcome, see `TaskDetail`) — all under
`artifacts/` (gitignored).

**Comparison run** — `scripts/run-comparison.ts` running several arms against the identical task
subset under one shared id, merging their logs into a single wide `comparison-report-<id>.csv`
(one row per task, per-arm columns). Incremental: an arm already run for that id is loaded from
disk instead of re-run, so adding an arm later doesn't re-spend on arms already done.

**Grade outcome** — the taxonomy a task attempt's result falls into (`GradeResult.outcome` in
`src/types.ts`): `pass`/`fail` are real signal (the solution ran and either passed or failed
BigCodeBench's own test suite); the `error_*` outcomes (`error_no_solution`,
`error_missing_dep`, `error_timeout`, `error_harness`) mean the harness couldn't even judge the
attempt (no usable text extracted, missing grading dependency, timeout, etc.) — these should be
excluded from pass/fail-rate math, not counted as failures.

**Cost source** — `CallLogRecord.cost_source` records which of three different mechanisms produced
a call's dollar figure, since they're genuinely not computed the same way: `pi_reported` (Pi's own
self-reported cost, used for `direct` and Not Diamond's actual OpenRouter inference leg),
`openrouter_pricing_table` (a locally-kept snapshot of OpenRouter's real per-token prices,
`data/openrouter-pricing.json`, used because Pi always reports `$0` for OpenRouter's own router
models), and `copilot_usage_file` (taken directly from GitHub's own per-session usage/billing
file). Keep the pricing snapshot refreshed (`scripts/fetch-openrouter-pricing.ts`) — a stale entry
for even one model can silently understate a whole arm's reported cost.

A fourth number, `router_cost`, is hardcoded to `0` for every arm, including `notdiamond` — but
that's not a confirmed fact for Not Diamond specifically. Their own pricing page lists a real
routing fee ($0.05/million tokens routed); whether it applies to this project's decision-only
`modelSelect` call (vs. a different, fully-proxied Not Diamond product) isn't documented publicly.
Left at `0` because the practical impact is negligible at this project's prompt sizes (~600-800
tokens/call), not because the fee is confirmed absent — don't repeat "Not Diamond charges nothing
for routing" as settled fact.
