# Routing List Validation Report

Validates `routing-list.md`'s claims about which models each router can select against two independent
sources: (1) live official documentation, re-fetched today, and (2) this project's own real, logged
`selected_model` values from actual benchmark runs (`artifacts/call-log-*.jsonl`).

**Bottom line up front:** none of the four entries in `routing-list.md` can be trusted at face value as
"the complete set of models this router will select from." Two are internally accurate but structurally
incomplete (the router's own docs only publish an illustrative subset), one mixes two different real lists
without saying which one it is, and one is simply blank.

---

## 1. Pareto Code

**`routing-list.md` claims** (High/Medium/Low tiers by `min_coding_score`):
- High (≥0.66): GPT-5.5, Gemini 3.1 Pro Preview, Claude Opus 5, DeepSeek V4 Pro 0423
- Medium (0.33–0.65): GPT-5.4 Mini, Claude Sonnet 4.6, Kimi K2.6, Grok 4.3
- Low (<0.33): MiMo-V2.5-Pro, Qwen3.7 Max, GLM 5.1, DeepSeek V4 Flash 0423, Claude Haiku 4.5

**Live-doc check:** re-fetched `https://openrouter.ai/openrouter/pareto-code` today and extracted the
page's embedded model data directly (the tier widget is client-rendered; a plain fetch/summary tool sees
only the surrounding API-reference boilerplate, not this list — had to pull it from the raw HTML's embedded
JS data). **Matches `routing-list.md` exactly** — same 13 models, same three tiers, same thresholds. As a
transcription of the page's own "current tier membership" display, `routing-list.md` is accurate.

**Real-run check — this is the important part.** Every real `openrouter-pareto-code` call ever logged in
this project (60+ calls across three full comparison runs on 2026-09-04) selected the exact same model,
every single time:

```
openai/gpt-5.6-sol
```

**`gpt-5.6-sol` does not appear in any of the three tiers above, on either `routing-list.md` or the live
page.** It's not a stale-data artifact on our end — we re-fetched the page today and it's still absent.

**Why this matters:** the tier widget is best read as an *illustrative* snapshot of "some models currently
in this tier," not an exhaustive, live-synced list of everything Pareto Code can route to. OpenRouter's own
docs already hedge this ("the router maintains a curated shortlist... it evolves over time... the capability
bar shifts as the frontier moves") — our data shows the practical effect: a model that's clearly eligible
and gets selected 100% of the time in real traffic simply isn't reflected in the page's own example list.
**Verdict: not reliable as a complete list.** Useful as a rough indicator of tier *thresholds* and the kind
of models in play, unusable as a prediction of the actual model a real call will get.

(Side note, not a documentation-reliability finding but worth flagging: 100% of ~60 calls picking the
identical model isn't Pareto "choosing based on the task" — it's consistent with Pareto's own documented
mechanism, "cheapest model clearing the tier bar," which is price-driven and content-independent. Expect
the same model every time unless pricing/availability shifts, not per-task variation.)

---

## 2. Not Diamond

**`routing-list.md` claims:** nothing — the entry (lines 42–48) has only the source URL
(`https://docs.notdiamond.ai/docs/llm-models`) and no model list was actually copied in. This section is
empty in the file as it stands.

**Live-doc check:** `docs.notdiamond.ai/docs/llm-models` lists ~80 models across 14 providers (OpenAI,
Anthropic, Google, Mistral, xAI, Replicate, TogetherAI, Perplexity, Cohere, Minimax, DeepSeek, Qwen,
Inception, plus base Gemma) — this is Not Diamond's full routing-capable catalog, already captured
elsewhere this session (see the "which models does each router route to" discussion, dated versioned IDs
like `openai/gpt-5-mini-2025-08-07`, `anthropic/claude-opus-4.7`, etc.).

**Real-run check:** every real `notdiamond` call logged (3 calls, 2026-09-07) selected
`openai/gpt-5-mini` — the OpenRouter-format equivalent of the doc's `openai/gpt-5-mini-2025-08-07` (our
integration calls Not Diamond with `?type=openrouter`, which is why the id comes back date-suffix-free).
Consistent with the documented catalog.

**Verdict:** what's actually written in `routing-list.md` right now is **unusable — it's blank**. The
underlying source is legitimate and the one real data point we have matches it, but the file needs the
list actually filled in before it's worth anything as a reference.

---

## 3. GitHub Copilot

**`routing-list.md` claims** (26 models across 6 groups): Claude — Fable 5, Haiku 4.5, Opus 4.7, Opus 4.8,
Opus 4.8 fast mode, Opus 5, Sonnet 5; Gemini — 3.5/3.6/3.7/3.8 Flash; GPT — 5 mini, 5.3 codex, 5.4, 5.4
mini, 5.5, 5.6 Luna, 5.6 sol, 5.6 terra, 6 Astra; Grok — 4.5, 4.6; Kimi — k2.7 code, k3; MAI — Code 1.1
flash, Code 1 Flash.

**This list conflates two genuinely different official lists, and `routing-list.md` doesn't say which one
it is** — that's the core finding here:

| | Official "Auto model selection" doc¹ (16 models) | Full manual `--model` catalog² (~26 models) |
|---|---|---|
| Claude | Haiku 4.5, Opus 4.8, Opus 5, Sonnet 4.6, Sonnet 5 | + Fable 5, Fable 5.1, Opus 4.7, Opus 4.8-fast |
| Gemini | 3.6 Flash, 3.7 Flash | + 3.5 Flash, 3.8 Flash |
| GPT | 5 mini, 5.3-Codex, 5.4, 5.4 mini, 5.5, 5.6 Luna/Sol/Terra | (same) |
| Grok | — not listed | + 4.5 |
| Kimi | — not listed | + k3, k2.7-code |
| MAI | Code-1.1-Flash | + Code-1-Flash-picker |

¹ `docs.github.com/en/copilot/reference/ai-models/supported-models`, "Supported AI models in Auto model
selection" — fetched this session.
² `copilot help config`'s `model` setting — the exact list the installed CLI (`v1.0.83`) itself printed
when directly queried this session, i.e. empirically confirmed, not just documentation.

**`routing-list.md`'s list matches the broader manual catalog almost exactly** (differences: it has "GPT-6
Astra" which appears in neither real list we found, and "Grok 4.6"/"Opus 4.8 fast mode" as slightly
different labels than the CLI's own "grok-4.5"/"claude-opus-4.8-fast") — **it does not match the narrower,
official "Auto model selection" list**, which is the one that actually answers "what can the `copilot-auto`
arm select."

**Real-run check:** every real `copilot-auto` call (2 calls) selected `gpt-5.6-luna` or `gpt-5.6-terra` —
both present in *both* lists, so this doesn't discriminate between them; our sample is too small (and this
session already found Copilot's Auto only ever resolved to a single candidate model on our test account
anyway, so it hasn't had the chance to reach outside the smaller list).

**Verdict: unreliable for its likely intended purpose.** If `routing-list.md` is meant to answer "what can
`copilot-auto` route to," it's the wrong list — half its entries (Grok, Kimi, Claude Fable, Gemini
3.5/3.8, Opus 4.7) are, per GitHub's own docs, not in Auto's pool at all, only reachable via an explicit
`--model` pin. If it's meant to document "everything Copilot CLI can be pointed at," it's approximately
right but has at least one unverifiable entry ("GPT-6 Astra") and should cite the CLI-config source
explicitly rather than "Github settings."

---

## 4. OpenRouter Auto

**`routing-list.md` claims:** nothing — line 86 has only the URL, no content at all.

**Live-doc check:** re-fetched `https://openrouter.ai/openrouter/auto` today the same way as Pareto Code
(raw HTML, searching for embedded model data) — **found nothing**. No model list is embedded anywhere on
the page. This matches what this session already established from OpenRouter's own documentation: Auto's
model roster is deliberately undisclosed, unlike Pareto Code's (which at least has an illustrative,
if incomplete, tier widget).

**Real-run check:** real `openrouter-auto` calls have selected `deepseek/deepseek-v4-flash-0731`,
`openai/gpt-5.6-luna`, and `z-ai/glm-5.2` across different runs — a real, varied pool, consistent with "no
fixed published list" rather than a small fixed set.

**Verdict:** the blank entry is **correct, not a gap** — there is nothing to fill in. OpenRouter genuinely
does not publish an Auto roster, so no version of this section could ever be "reliable" as a prediction
list; the honest content for this section is "not disclosed," not a model list.

---

## Summary table

| Router | List completeness in `routing-list.md` | Matches live docs? | Matches real observed selections? | Reliable as "what it will pick"? |
|---|---|---|---|---|
| Pareto Code | Complete | Yes, exactly | **No** — real selection never appears in the list | **No** |
| Not Diamond | Empty | N/A | N/A (no list to check) | **No — needs filling in** |
| Copilot | Complete, but ambiguous source | Matches the *wrong* (broader) official list | Yes, but sample too small to discriminate | **No — mislabeled scope** |
| OpenRouter Auto | Empty | Correctly so — no such list exists | N/A | N/A — blank is correct |

**Overall:** treat `routing-list.md` as a set of notes worth keeping, not a reliable reference for "which
model will this router actually pick." The two routers with real problems here for different reasons —
Pareto Code's page understates its live pool, Copilot's entry doesn't specify which of two real official
lists it's transcribing — both need a caveat next to them if this file is going to be relied on rather than
just re-derived live before each real decision.
