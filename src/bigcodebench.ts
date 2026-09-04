// Pulls BigCodeBench-Instruct rows via the Hugging Face datasets-server REST API — pure HTTP, no
// `datasets` library / Python needed. Mirrors clustering-based-llm-router's corpus.py source
// metadata exactly (same hf_id/split/field) so results stay comparable across the two projects.
//   hf_id: bigcode/bigcodebench, config: default, split: v0.1.4 (latest versioned split; the
//   unversioned default split merges all 5 versions), field: instruct_prompt (not complete_prompt
//   — instruct_prompt is the natural-language framing suited to an agentic chat call, complete_prompt
//   is docstring-style code completion).

const DATASET = "bigcode/bigcodebench";
const CONFIG = "default";
const SPLIT = "v0.1.4";
const PAGE_SIZE = 100;

export interface BigCodeBenchRow {
  task_id: string;
  complete_prompt: string;
  instruct_prompt: string;
  canonical_solution: string;
  code_prompt: string;
  test: string;
  entry_point: string;
  doc_struct: string;
  libs: string[];
}

/** `libs` comes back as a Python list-repr string, e.g. "['numpy', 'random']" — extract the
 * quoted tokens rather than attempting a full Python-literal parse. */
function parseLibs(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return [...raw.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

async function fetchPage(offset: number, length: number): Promise<BigCodeBenchRow[]> {
  const url =
    `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
    `&config=${CONFIG}&split=${SPLIT}&offset=${offset}&length=${length}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`datasets-server request failed (${response.status}): ${url}`);
  }
  const payload = (await response.json()) as { rows: Array<{ row: Record<string, unknown> }> };
  return payload.rows.map(({ row }) => ({
    task_id: row.task_id as string,
    complete_prompt: row.complete_prompt as string,
    instruct_prompt: row.instruct_prompt as string,
    canonical_solution: row.canonical_solution as string,
    code_prompt: row.code_prompt as string,
    test: row.test as string,
    entry_point: row.entry_point as string,
    doc_struct: row.doc_struct as string,
    libs: parseLibs(row.libs),
  }));
}

export async function fetchAllBigCodeBenchRows(): Promise<BigCodeBenchRow[]> {
  // Verified live (2026-09-03): v0.1.4 has exactly 1140 rows, 9 columns, and the datasets-server
  // caps each page at 100 rows regardless of a larger requested `length` — hence the pagination
  // loop below rather than a single fetch.
  const rows: BigCodeBenchRow[] = [];
  let offset = 0;
  for (;;) {
    const page = await fetchPage(offset, PAGE_SIZE);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}
