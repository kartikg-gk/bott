import type { ModelProvider } from "./providers/types.ts";
import type { ToolSpec } from "./tools.ts";
import { type Block, type TranscriptEntry, textOf } from "./transcript.ts";

export const SUMMARY_PREFIX = "Summary of the earlier conversation:\n";
export const REQUEST_MARKER = "\n\nThe exact request this run is handling:\n";

const CHARS_PER_TOKEN = 4;
const TOOL_SCHEMA_TOKENS = 200;

const SUMMARY_SYSTEM =
  "You compress a conversation between a user and a coding assistant into a concise summary " +
  "so the work can continue from it. Keep the decisions made, file paths, code changes and " +
  "open questions. Drop pleasantries and repeated detail. Reply with the summary only.";

export interface Estimate {
  tokens: number;
  utilization: number;
}

function blockChars(block: Block): number {
  switch (block.type) {
    case "text":
    case "thinking":
      return block.text.length;
    case "redacted_thinking":
      return block.data.length;
    case "call":
      return block.name.length + (JSON.stringify(block.input) ?? "").length;
  }
}

export function estimate(
  transcript: TranscriptEntry[],
  tools: ToolSpec[],
  window = 128_000,
): Estimate {
  let chars = 0;
  for (const entry of transcript) for (const b of entry.content) chars += blockChars(b);
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN) + tools.length * TOOL_SCHEMA_TOKENS;
  return { tokens, utilization: tokens / window };
}

export function needsCompaction(est: Estimate, threshold = 0.75): boolean {
  return est.utilization > threshold;
}

export class CompactionError extends Error {
  readonly transcript: TranscriptEntry[];
  constructor(message: string, transcript: TranscriptEntry[]) {
    super(message);
    this.name = "CompactionError";
    this.transcript = transcript;
  }
}

function isSummary(entry: TranscriptEntry | undefined): boolean {
  return entry?.role === "user" && textOf(entry.content).startsWith(SUMMARY_PREFIX);
}

/** The model's own summary text, without the prefix or the appended request. */
function summaryBody(entry: TranscriptEntry): string {
  const text = textOf(entry.content).slice(SUMMARY_PREFIX.length);
  const at = text.indexOf(REQUEST_MARKER);
  return at === -1 ? text : text.slice(0, at);
}

function renderBlock(b: Block): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "thinking":
      return `(thinking) ${b.text}`;
    case "redacted_thinking":
      return "(thinking withheld)";
    case "call":
      return `(called ${b.name} with ${JSON.stringify(b.input)})`;
  }
}

function render(entry: TranscriptEntry): string {
  if (isSummary(entry)) return `[earlier summary]\n${summaryBody(entry)}`;
  const parts = entry.content.map(renderBlock);
  const label =
    entry.role === "tool"
      ? `[tool result: ${entry.name}${entry.isError ? ", error" : ""}]`
      : `[${entry.role}]`;
  return `${label}\n${parts.join("\n")}`;
}

export interface CompactOptions {
  provider: ModelProvider;
  model: string;
  transcript: TranscriptEntry[];
  currentRequest?: string;
  keepRecent?: number;
  signal: AbortSignal;
}

export async function compact(
  opts: CompactOptions,
): Promise<{ transcript: TranscriptEntry[]; summary: string }> {
  const { transcript } = opts;
  const n = transcript.length;
  const keep = Math.max(opts.keepRecent ?? 4, Math.floor(n / 4));
  let cut = Math.max(0, n - keep);
  // A result must stay with its call: back up until the kept part starts on a non-result.
  while (cut > 0 && transcript[cut]?.role === "tool") cut--;
  const dropped = transcript.slice(0, cut);
  const nothingNew = dropped.length === 0 || (dropped.length === 1 && isSummary(dropped[0]));
  if (nothingNew) return { transcript, summary: "" };

  const body = await summarise(opts, dropped);
  let summary = SUMMARY_PREFIX + body;
  if (opts.currentRequest) summary += REQUEST_MARKER + opts.currentRequest;
  const head: TranscriptEntry = { role: "user", content: [{ type: "text", text: summary }] };
  return { transcript: [head, ...transcript.slice(cut)], summary };
}

async function summarise(opts: CompactOptions, dropped: TranscriptEntry[]): Promise<string> {
  const material = dropped.map(render).join("\n\n");
  const prompt: TranscriptEntry = {
    role: "user",
    content: [{ type: "text", text: `Summarise this conversation:\n\n${material}` }],
  };
  let streamed = "";
  let final: string | undefined;
  try {
    for await (const event of opts.provider.stream({
      model: opts.model,
      system: SUMMARY_SYSTEM,
      messages: [prompt],
      tools: [],
      signal: opts.signal,
    })) {
      if (event.type === "text_delta") streamed += event.text;
      else if (event.type === "error") throw new Error(event.message);
      else if (event.type === "end") {
        if (event.entry.stop === "error" || event.entry.stop === "aborted") {
          throw new Error(event.entry.error ?? `summary call ended with ${event.entry.stop}`);
        }
        final = textOf(event.entry.content);
      }
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new CompactionError(`Compaction failed: ${why}`, opts.transcript);
  }
  const text = (final ?? streamed).trim();
  if (!text) throw new CompactionError("Compaction failed: empty summary", opts.transcript);
  return text;
}
