// One-off ground-truth check (not part of the benchmark runtime): for each pinned task, runs its
// own `canonical_solution` against its own `test` suite and records whether BigCodeBench's own
// reference answer actually passes. This is the one place in this project that shells out to
// Python — unavoidable, since validating a Python solution against a Python unittest suite means
// executing Python. The ongoing Pi/OpenRouter benchmark runtime stays pure TS; this is a curation
// step, run manually, same as scripts/select-pinned-tasks.ts.
//
// Grading logic mirrors clustering-based-llm-router's grading/bigcodebench.py exactly (self-
// contained exec of candidate.py + test.py into a shared namespace, then unittest.TestCases) so a
// "pass" here means the same thing it would mean in that project.
//
// Runs under a DEDICATED venv (.venv/), not ambient `python3` on PATH — built from
// requirements-eval.txt, which is BigCodeBench's own pinned eval dependencies (numpy==1.21.2,
// pandas==2.0.3, etc.), so this is reproducible on any machine, not just this one. Those pins
// predate macOS arm64 wheels for some packages (scipy in particular), so .venv is built under x86_64
// (Rosetta) — see README for the exact setup commands. Every invocation of .venv's python MUST go
// through `arch -x86_64`; without it, macOS launches the interpreter's arm64 slice instead, which
// can't load these x86_64-only wheels.
//
// Run with: npx tsx scripts/validate-ground-truth.ts

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_TASKS_PATH = join(PROJECT_ROOT, "data", "pinned-tasks.json");
const REPORT_PATH = join(PROJECT_ROOT, "data", "ground-truth-report.json");
const VENV_PYTHON = join(PROJECT_ROOT, ".venv", "bin", "python3");
const TIMEOUT_MS = 60_000;

function runPython(args: string[], options: SpawnSyncOptionsWithStringEncoding) {
  // `arch -x86_64` on every call, not just venv creation — architecture is decided per-process at
  // launch, not baked into the venv itself (bit us once already: the venv "existing" under x86_64
  // did not stop a bare `.venv/bin/python3` invocation from launching arm64 and failing to import
  // the x86_64-only wheels installed into it).
  return spawnSync("arch", ["-x86_64", VENV_PYTHON, ...args], options);
}

function capturePythonEnv(): { python_version: string; packages: Record<string, string> } {
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

interface PinnedTask {
  task_id: string;
  code_prompt: string;
  canonical_solution: string;
  test: string;
  [key: string]: unknown;
}

interface PinnedTasksFile {
  ground_truth_validated: boolean;
  tasks: PinnedTask[];
  [key: string]: unknown;
}

type Outcome = "pass" | "fail" | "error_missing_dep" | "error_timeout" | "error_harness";

interface ValidationResult {
  task_id: string;
  outcome: Outcome;
  detail: string;
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

function runOne(task: PinnedTask): ValidationResult {
  const dir = mkdtempSync(join(tmpdir(), "gt-check-"));
  const nonce = randomUUID();
  const prefix = `RESULT_${nonce}: `;
  try {
    writeFileSync(join(dir, "candidate.py"), task.code_prompt + task.canonical_solution, "utf8");
    writeFileSync(join(dir, "test.py"), task.test, "utf8");
    writeFileSync(join(dir, "grade.py"), gradeScript(nonce), "utf8");

    const proc = runPython(["grade.py"], {
      cwd: dir,
      timeout: TIMEOUT_MS,
      encoding: "utf8",
    });

    if (proc.error && (proc.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { task_id: task.task_id, outcome: "error_timeout", detail: `no result within ${TIMEOUT_MS}ms` };
    }

    const resultLine = (proc.stdout ?? "")
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .at(-1);

    if (!resultLine) {
      return {
        task_id: task.task_id,
        outcome: "error_harness",
        detail: `no result sentinel in output (exit ${proc.status}): stdout=${(proc.stdout ?? "").slice(-300)} stderr=${(proc.stderr ?? "").slice(-300)}`,
      };
    }

    const output = resultLine.slice(prefix.length).trim();
    if (output.startsWith("PASS")) return { task_id: task.task_id, outcome: "pass", detail: output };
    if (output.startsWith("ERROR_MISSING_DEP")) {
      return { task_id: task.task_id, outcome: "error_missing_dep", detail: output };
    }
    return { task_id: task.task_id, outcome: "fail", detail: output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  if (!existsSync(VENV_PYTHON)) {
    throw new Error(
      `No venv at ${VENV_PYTHON}. Set it up first (see README): ` +
        `arch -x86_64 /usr/bin/python3 -m venv .venv && ` +
        `arch -x86_64 .venv/bin/python3 -m pip install -r requirements-eval.txt`,
    );
  }
  const pythonEnv = capturePythonEnv();

  const file = JSON.parse(readFileSync(PINNED_TASKS_PATH, "utf8")) as PinnedTasksFile;
  console.log(`Validating ground truth for ${file.tasks.length} pinned tasks against their own test suites...`);
  console.log(`Using ${VENV_PYTHON} (python ${pythonEnv.python_version}):`, pythonEnv.packages);

  const results: ValidationResult[] = [];
  for (const task of file.tasks) {
    const result = runOne(task);
    results.push(result);
    console.log(`  ${result.outcome === "pass" ? "PASS" : result.outcome.toUpperCase()}  ${task.task_id}`);
  }

  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\nSummary:", counts);

  writeFileSync(
    REPORT_PATH,
    JSON.stringify({ validated_at: new Date().toISOString(), python_env: pythonEnv, counts, results }, null, 2) + "\n",
    "utf8",
  );
  console.log(`Wrote ${REPORT_PATH}`);

  const badTaskIds = results.filter((r) => r.outcome !== "pass").map((r) => r.task_id);
  if (badTaskIds.length > 0) {
    console.log(
      `\n${badTaskIds.length} task(s) failed their OWN ground truth: ${badTaskIds.join(", ")}\n` +
        "Not modifying data/pinned-tasks.json automatically — see the report and decide whether to " +
        "drop/replace these before treating the pin as final.",
    );
  } else {
    console.log("\nAll pinned tasks pass their own ground truth.");
  }
}

main();
