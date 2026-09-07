/**
 * A channel from a `before_provider_request` selector extension (e.g.
 * `.pi/extensions/notdiamond-router.ts`) to `call-logger.ts`'s `turn_end` handler, so the real
 * routing latency can reach `CallLogRecord.router_latency_ms` instead of the hardcoded `0` used
 * when no selector extension is in play (see types.ts's CallLogRecord doc comment).
 *
 * Backed by a temp file, not a plain module-level variable — confirmed live (2026-09-07) that a
 * `let` here does NOT work as a cross-extension channel: `notdiamond-router.ts` and
 * `call-logger.ts` each get their own separate instance of this module even though both resolve
 * the identical file path (Pi isolates each extension's module graph). A file is genuinely
 * process-wide regardless of that isolation, matching the same reasoning `log.ts` already uses to
 * cross the harder boundary of runner.ts's own process vs. the spawned `pi` process.
 *
 * Safe under this project's own concurrency model: `runner.ts` runs one `pi` process at a time,
 * strictly sequentially, and `scripts/run-comparison.ts` runs its three arms sequentially too — so
 * there's never a second selection in flight to clobber this one before it's read.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ARTIFACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "artifacts");
const LATENCY_FILE = join(ARTIFACTS_DIR, ".router-latency.tmp.json");

export function recordRouterLatency(ms: number): void {
  writeFileSync(LATENCY_FILE, JSON.stringify({ ms }), "utf8");
}

/** Reads and clears the last recorded latency — 0 (not null) when no selector extension ran for
 * this turn, so callers never need to special-case "no router was involved". */
export function takeRouterLatency(): number {
  if (!existsSync(LATENCY_FILE)) return 0;
  const { ms } = JSON.parse(readFileSync(LATENCY_FILE, "utf8")) as { ms: number };
  unlinkSync(LATENCY_FILE);
  return ms;
}

/** Clears any stale file left behind by a crashed prior run, so a fresh run's first call can never
 * accidentally pick up an old, unrelated latency value. Call once per run, before the first task. */
export function resetRouterLatencyChannel(): void {
  if (existsSync(LATENCY_FILE)) unlinkSync(LATENCY_FILE);
}
