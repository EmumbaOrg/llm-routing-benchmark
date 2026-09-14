import type { Task } from "./types.js";

const CODE_BLOCK_RE = /```(?:\w+)?\n([\s\S]*?)```/;

function stripNewlines(s: string): string {
  return s.replace(/^\n+/, "").replace(/\n+$/, "");
}

/** Per-source instructions telling the agent what SHAPE of answer the grader expects — this
 * OVERRIDES the task's own natural-language framing. Needed for bigcodebench specifically:
 * `instruct_prompt` asks for a complete self-contained script, but the grader concatenates just the
 * function BODY after `code_prompt`, so the model's raw response would double up signature/imports
 * and fail regardless of whether the logic was right. */
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

/** Extracts the single fenced code block from a raw agent response, falling back to the raw
 * trimmed text if nothing is fenced. Uses `stripNewlines`, NOT a bare `.trim()` — trim() would
 * also eat the solution's own leading INDENTATION, fatal since the grader concatenates
 * `code_prompt + solution` directly (code_prompt ends mid-signature). */
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
