import type { ToolResultEntry, TranscriptEntry } from "./transcript.ts";

export const INTERRUPTED_TEXT = "Tool call was interrupted before it returned.";

/**
 * Providers reject history where a call lacks exactly one result right after it.
 * Rebuilds the history so each call is followed by its result in call order:
 * a missing result becomes an interrupted error, and results with no call
 * (or a second result for one call) are dropped. Valid history is unchanged.
 */
export function mendHistory(entries: TranscriptEntry[]): {
  entries: TranscriptEntry[];
  mended: number;
} {
  const resultsById = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    if (entry.role !== "tool") return;
    const list = resultsById.get(entry.callId) ?? [];
    list.push(index);
    resultsById.set(entry.callId, list);
  });

  const used = new Set<number>();
  const out: TranscriptEntry[] = [];
  let mended = 0;

  entries.forEach((entry, index) => {
    if (entry.role === "tool") return;
    out.push(entry);
    if (entry.role !== "assistant") return;
    for (const block of entry.content) {
      if (block.type !== "call") continue;
      const found = (resultsById.get(block.id) ?? []).find((i) => i > index && !used.has(i));
      if (found === undefined) {
        mended++;
        out.push(interrupted(block.id, block.name));
        continue;
      }
      const result = entries[found];
      if (!result) continue;
      used.add(found);
      // A result that was not right behind the entry it now follows was moved.
      if (entries[found - 1] !== out[out.length - 1]) mended++;
      out.push(result);
    }
  });

  entries.forEach((entry, index) => {
    if (entry.role === "tool" && !used.has(index)) mended++;
  });

  return { entries: mended === 0 ? [...entries] : out, mended };
}

function interrupted(callId: string, name: string): ToolResultEntry {
  return {
    role: "tool",
    callId,
    name,
    content: [{ type: "text", text: INTERRUPTED_TEXT }],
    isError: true,
  };
}
