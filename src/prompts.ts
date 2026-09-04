import type { Task } from "./types.js";

const CODE_BLOCK_RE = /```(?:\w+)?\n([\s\S]*?)```/;

function stripNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

/**
 * Per-source instructions telling the agent what SHAPE of answer the grader expects — this
 * OVERRIDES the task's own natural-language framing, which matters for bigcodebench specifically:
 * `instruct_prompt` itself asks for a complete self-contained script (imports + signature +
 * body), but the grader's contract (matching how `canonical_solution` is stored) needs just the
 * function BODY, appended directly after `code_prompt`. Sending the model's raw "self-contained"
 * response into that concatenation would double up the signature/imports and fail almost every
 * time — not because the answer was wrong, but because of a prompt/grading contract mismatch.
 * Mirrors clustering-based-llm-router's runner.py _INSTRUCTIONS dict.
 */
const RESPONSE_INSTRUCTIONS: Record<string, (task: Task) => string> = {
  bigcodebench: (task) =>
    "Respond with ONLY the function body, indented, continuing directly from this signature " +
    "(no import statements, no signature line, no explanation):\n\n" +
    `${(task.row.code_prompt as string) ?? ""}\n\n` +
    "Wrap your answer in a single ```python code block.",
};

export function buildPrompt(task: Task): string {
  const instruction = RESPONSE_INSTRUCTIONS[task.source];
  if (!instruction) return task.prompt;
  return `${task.prompt}\n\n${instruction(task)}`;
}

/**
 * Extracts the single fenced code block from a raw agent response, matching the solution contract
 * `RESPONSE_INSTRUCTIONS` asks for. Falls back to the raw trimmed text if nothing is fenced.
 *
 * Uses `stripNewlines`, NOT a bare `.trim()` — trim() would also eat the solution's own leading
 * INDENTATION, which is fatal for bigcodebench: the grader concatenates `code_prompt + solution`
 * directly (code_prompt ends mid-signature, e.g. "def task_func(...):\n"), so a solution missing
 * its first line's indentation always raises IndentationError regardless of whether the model's
 * logic was right. Same gotcha documented in clustering-based-llm-router's runner.py.
 */
export function extractSolution(rawResponse: string | null): string | null {
  if (rawResponse === null) return null;
  const match = CODE_BLOCK_RE.exec(rawResponse);
  if (match) {
    const extracted = stripNewlines(match[1]!);
    return extracted || null;
  }
  const stripped = rawResponse.trim();
  return stripped || null;
}
