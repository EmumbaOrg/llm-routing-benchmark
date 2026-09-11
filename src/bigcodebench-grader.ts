// Shared BigCodeBench grading executor — the ONE place this project runs a candidate's code
// against a task's test suite. Used both for real grading (grading.ts, candidate = a model's
// solution) and ground-truth validation (scripts/validate-ground-truth.ts, candidate =
// canonical_solution). Grading logic mirrors clustering-based-llm-router's
// grading/bigcodebench.py exactly (self-contained exec of candidate.py + test.py into a shared
// namespace, then unittest.TestCases) so a "pass" here means the same thing it would mean there.
//
// Runs under a DEDICATED venv (.venv/), not ambient `python3` on PATH — built from
// requirements-eval.txt, BigCodeBench's own pinned eval dependencies (with one deliberate patch
// bump, scipy 1.7.2 -> 1.7.3 — see that file's own comment), so results are reproducible on any
// machine, not just this one. Native arm64 throughout, built with `uv` rather than the system
// python3 — no Rosetta, no `arch -x86_64` needed anywhere. (An earlier x86_64-via-Rosetta venv,
// built against the unpatched scipy==1.7.2 pin which has no macOS arm64 wheel at all, broke when
// this machine's Xcode Command Line Tools dropped x86_64 support from `xcrun`'s own library —
// there was no working x86_64 Python left on the system at all. Bumping the one pin that actually
// needed it removed the dependency on x86_64/Rosetta entirely instead of chasing that further.)
// Set up with:
//   uv venv --python 3.10 .venv
//   uv pip install --python .venv/bin/python3 -r requirements-eval.txt

import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { GradeResult } from "./types.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VENV_PYTHON = join(PROJECT_ROOT, ".venv", "bin", "python3");
const DEFAULT_TIMEOUT_MS = 60_000;

export function venvReady(): boolean {
  return existsSync(VENV_PYTHON);
}

export const VENV_SETUP_HINT =
  `No venv at ${VENV_PYTHON}. Set it up first: ` +
  `uv venv --python 3.10 .venv && ` +
  `uv pip install --python .venv/bin/python3 -r requirements-eval.txt`;

export function runPython(args: string[], options: SpawnSyncOptionsWithStringEncoding) {
  return spawnSync(VENV_PYTHON, args, options);
}

export function capturePythonEnv(): { python_version: string; packages: Record<string, string> } {
  const script = `
import json, platform, sys
import numpy, pandas, pytz, requests, openpyxl, prettytable, matplotlib, sklearn, scipy
print(json.dumps({
    "python_version": platform.python_version(),
    "packages": {
        "numpy": numpy.__version__, "pandas": pandas.__version__, "pytz": pytz.__version__,
        "requests": requests.__version__, "openpyxl": openpyxl.__version__,
        "prettytable": prettytable.__version__, "matplotlib": matplotlib.__version__,
        "scikit-learn": sklearn.__version__, "scipy": scipy.__version__,
    },
}))
`;
  const proc = runPython(["-c", script], { encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error(`could not capture python env from ${VENV_PYTHON}: ${proc.stderr}`);
  }
  return JSON.parse(proc.stdout!);
}

// The candidate/test code itself can (and several pinned tasks do) print its own debug output to
// stdout — a bare "PASS"/"FAIL" sentinel collides with that. Mirrors clustering-based-llm-router's
// grading/base.py NONCE_PLACEHOLDER approach: a random-per-call prefix that candidate code can't
// forge or coincidentally match, and the LAST matching line (not the first, not startsWith on the
// whole blob) is the actual result.
function gradeScript(nonce: string): string {
  return `
import sys
import unittest

ns = {}
try:
    with open("candidate.py", encoding="utf-8") as f:
        exec(compile(f.read(), "candidate.py", "exec"), ns)
    with open("test.py", encoding="utf-8") as f:
        exec(compile(f.read(), "test.py", "exec"), ns)
    suite = unittest.TestLoader().loadTestsFromTestCase(ns["TestCases"])
    result = unittest.TextTestRunner(stream=sys.stderr, verbosity=0).run(suite)
except (ImportError, ModuleNotFoundError) as e:
    print(f"RESULT_${nonce}: ERROR_MISSING_DEP {type(e).__name__}: {e}")
    sys.exit(0)
except Exception as e:
    print(f"RESULT_${nonce}: FAIL setup-exception {type(e).__name__}: {e}")
    sys.exit(0)

if result.wasSuccessful():
    print("RESULT_${nonce}: PASS")
else:
    tracebacks = "\\n".join(tb for _, tb in (result.failures + result.errors))
    if "ModuleNotFoundError" in tracebacks or "ImportError" in tracebacks:
        print("RESULT_${nonce}: ERROR_MISSING_DEP raised during test execution")
    else:
        print(f"RESULT_${nonce}: FAIL {len(result.failures)} failures, {len(result.errors)} errors")
`;
}

/**
 * Grades one BigCodeBench candidate: execs `codePrompt + solution` then `test` into a shared
 * namespace, runs the test suite's `TestCases`. `solution` must be the function BODY only
 * (indented, continuing directly from codePrompt's signature) — not a complete standalone script.
 */
export function gradeBigCodeBench(
  codePrompt: string,
  solution: string,
  test: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): GradeResult {
  if (!venvReady()) {
    return { outcome: "error_harness", detail: VENV_SETUP_HINT };
  }

  const dir = mkdtempSync(join(tmpdir(), "bcb-grade-"));
  const nonce = randomUUID();
  const prefix = `RESULT_${nonce}: `;
  try {
    writeFileSync(join(dir, "candidate.py"), codePrompt + solution, "utf8");
    writeFileSync(join(dir, "test.py"), test, "utf8");
    writeFileSync(join(dir, "grade.py"), gradeScript(nonce), "utf8");

    const proc = runPython(["grade.py"], { cwd: dir, timeout: timeoutMs, encoding: "utf8" });

    if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { outcome: "error_timeout", detail: `no result within ${timeoutMs}ms` };
    }

    const resultLine = (proc.stdout ?? "")
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .at(-1);

    if (!resultLine) {
      return {
        outcome: "error_harness",
        detail: `no result sentinel in output (exit ${proc.status}): stdout=${(proc.stdout ?? "").slice(-300)} stderr=${(proc.stderr ?? "").slice(-300)}`,
      };
    }

    const output = resultLine.slice(prefix.length).trim();
    if (output.startsWith("PASS")) return { outcome: "pass", detail: output };
    if (output.startsWith("ERROR_MISSING_DEP")) return { outcome: "error_missing_dep", detail: output };
    return { outcome: "fail", detail: output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
