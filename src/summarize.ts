import type { AnnaRuntime } from "/static/anna-apps/_sdk/latest/index.js";
import { TOOL_ID, TOOL_METHOD } from "./config";
import type { Note } from "./notesStore";

export interface SummaryResult {
  summary: string;
  model?: string;
  stopReason?: string;
}

/**
 * Ask the local Executa tool for an LLM summary of the current notes.
 *
 * The full chain is:
 *   anna.tools.invoke({tool_id, method:"summarize", args})
 *     → local Executa (JSON-RPC over stdio)
 *     → reverse `sampling/createMessage` to the host LLM
 *     → summary back to this Promise.
 *
 * The UI never talks to an LLM directly and never fabricates the
 * summary locally.
 */
export async function summarizeNotes(
  anna: AnnaRuntime,
  notes: readonly Note[],
): Promise<SummaryResult> {
  const payload = await anna.tools.invoke({
    tool_id: TOOL_ID,
    method: TOOL_METHOD,
    args: {
      notes: notes.map((n) => `${n.seq}. ${n.text}`),
      max_words: 80,
    },
    timeoutMs: 90_000,
  });

  // The host strips the {success, data} envelopes; be tolerant of a
  // partially-stripped shape from older harness versions.
  const data = unwrap(payload);
  const summary = typeof data.summary === "string" ? data.summary : "";
  if (!summary) {
    throw new Error("工具没有返回 summary 字段: " + JSON.stringify(payload));
  }
  return {
    summary,
    model: typeof data.model === "string" ? data.model : undefined,
    stopReason:
      typeof data.stopReason === "string" ? data.stopReason : undefined,
  };
}

function unwrap(payload: Record<string, unknown>): Record<string, unknown> {
  let cur = payload;
  for (let i = 0; i < 3; i++) {
    if (cur && typeof cur === "object" && "data" in cur && !("summary" in cur)) {
      cur = cur.data as Record<string, unknown>;
      continue;
    }
    break;
  }
  return cur ?? {};
}
