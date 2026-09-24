# Router Benchmark

Benchmarks model-decision routers for agentic coding — systems that pick which model handles a
request — against a fixed set of pinned BigCodeBench-Instruct tasks, using [Pi](https://github.com/earendil-works/pi-coding-agent)
as the fixed coding harness (GitHub Copilot CLI is the one exception, run directly — see
`src/copilot-runner.ts`).

Arms currently implemented: `direct` (no router, a fixed baseline model), `openrouter-auto`,
`openrouter-pareto-code`, `notdiamond`, `copilot-auto` (see `src/arms.ts`).

This project has **two separate setups that are both required**: the Node/TypeScript benchmark
runtime itself, and a Python venv used only for grading BigCodeBench solutions (running candidate
code against each task's test suite).

## Prerequisites

- Node.js 20+ and npm
- [`uv`](https://docs.astral.sh/uv/) — used to build the grading venv (native arm64, no system
  Python or Rosetta involved)
- The [Pi CLI](https://github.com/earendil-works/pi-coding-agent) (`pi`) installed and
  authenticated with whichever providers you'll run against (OpenAI/OpenRouter/Anthropic/etc.) —
  every arm except `copilot-auto` is spawned through it
- The [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)
  (`copilot`), installed and logged in — only needed for the `copilot-auto` arm

## Setup

### 1. Node / TypeScript (required)

```
npm install
cp .env.example .env
# fill in .env — see Configuration below
```

### 2. Python grading venv (required before any real grading)

BigCodeBench grading execs a candidate's solution and its test suite in a subprocess, using a
dedicated venv pinned to BigCodeBench's own eval dependencies (`requirements-eval.txt`):

```
uv venv --python 3.10 .venv
uv pip install --python .venv/bin/python3 -r requirements-eval.txt
```

Built natively for arm64 via `uv` — no system `python3`, no Rosetta/`arch -x86_64` involved (see
`src/bigcodebench-grader.ts`'s module comment for why that matters on this kind of machine). If
this venv is missing, grading returns an `error_harness` outcome with a hint pointing back to
these two commands rather than failing silently. Required by `npm run bench`, `run-comparison.ts`,
and `scripts/validate-ground-truth.ts`.

## Configuration (`.env`)

| Variable | Arm | Meaning |
|---|---|---|
| `BASELINE_PROVIDER`, `BASELINE_MODEL` | `direct` | Fixed baseline model used when `npm run bench` is invoked with no `--arm`/`--provider`/`--model` flags. |
| `PARETO_MIN_CODING_SCORE` | `openrouter-pareto-code` | OpenRouter Pareto Code's coding-capability tier threshold (0–1). |
| `AUTO_COST_QUALITY_TRADEOFF` | `openrouter-auto` | OpenRouter Auto's cost/quality knob (0–10). |
| `AUTO_COST_TIER` | `openrouter-auto` | Deprecated alternate form of the above; takes precedence if both are set. |
| `AUTO_ALLOWED_MODELS`, `AUTO_EXCLUDED_MODELS` | `openrouter-auto` | Comma-separated wildcard patterns restricting Auto's candidate pool (e.g. `anthropic/*`). Leave blank for unrestricted. |
| `NOTDIAMOND_API_KEY` | `notdiamond` | Not Diamond API key. |
| `NOTDIAMOND_COST_QUALITY_TRADEOFF` | `notdiamond` | Optional, 0–10; omit to use Not Diamond's own default. |

`notdiamond`'s candidate pool is fetched live from Not Diamond's own `GET /v2/models` on every
call, not a frozen/env-configured list — always the full current catalog, no restriction. It also
calls `modelSelect` in native mode (no `?type=openrouter`), so it isn't limited to models that
already have an OpenRouter mapping; see `.pi/extensions/notdiamond-router.ts`'s module doc comment
for why, and what happens when a selection turns out to have no real OpenRouter counterpart.

`copilot-auto` takes no candidate-pool config either — it uses the Copilot CLI's own `--model
auto`, and whatever account/subscription `copilot` is logged into. There is also no CLI flag or
per-session parameter to restrict which models Auto considers — that's only controllable via an
org/enterprise Business+ admin policy, applied account-wide. Auto's real routing diversity depends
heavily on sample size: early small-sample runs (a handful of calls) sometimes saw it resolve to
just one candidate model throughout, i.e. not exercising any real routing decision. A full 20-task
run has since shown genuine diversity (5 distinct models picked across 20 tasks) — but re-check
`candidateModels`/`availableModels` in your own run's output before assuming either behavior holds
for your account/session.

## Running

```
npm run typecheck                                              # tsc --noEmit

npm run bench                                                  # baseline, from .env
npm run bench -- --arm openrouter-pareto-code                  # a named router arm
npm run bench -- --provider openai --model gpt-5.3-codex        # direct, arbitrary model
npm run bench -- --arm notdiamond --run-id my-run --limit 5    # optional --run-id / --limit

npx tsx scripts/run-comparison.ts --arms direct,notdiamond,copilot-auto --run-id my-run
```

`run-comparison.ts` runs multiple arms against the pinned task set and compiles one merged
per-task CSV (`artifacts/comparison-report-<run-id>.csv`). It's incremental by `--run-id`: an arm
already run for that run-id is loaded from disk instead of re-run, so adding an arm later doesn't
re-run (and re-spend on) the arms already done.

### One-off curation scripts

Not part of the regular benchmark loop — run manually, in order, when the pinned task set or
reference data needs refreshing:

- `scripts/select-pinned-tasks.ts` — samples and freezes the pinned task set to `data/pinned-tasks.json`.
- `scripts/validate-ground-truth.ts` — runs each pinned task's own reference solution against its own test suite (the one other place, besides real grading, that needs the Python venv from setup step 2) and writes `data/ground-truth-report.json`.
- `scripts/fetch-openrouter-pricing.ts` — refreshes the frozen per-token pricing snapshot in `data/openrouter-pricing.json` (OpenRouter's router models don't report real cost themselves).

## Artifacts

`artifacts/` (gitignored) accumulates per-run call logs, task results/details, and comparison
reports — nothing under it is committed.
