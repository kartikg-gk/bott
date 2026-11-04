import { mendHistory } from "./mending.ts";
import type { ModelProvider } from "./providers/types.ts";
import { errorOutput, findTool, type ToolOutput, type ToolSpec } from "./tools.ts";
import {
  type Block,
  emptyUsage,
  type ModelEntry,
  type ToolResultEntry,
  type TranscriptEntry,
} from "./transcript.ts";

export const ABORTED_TEXT = "Tool call was aborted.";

export type ToolCall = Extract<Block, { type: "call" }>;

export type BeforeToolCall = (
  call: ToolCall,
) => Promise<{ allow: true } | { allow: false; reason: string }>;

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start"; turn: number }
  | { type: "message_start"; message: TranscriptEntry }
  | {
      type: "message_update";
      message: ModelEntry;
      delta: { type: "text_delta" | "thinking_delta"; text: string };
    }
  | { type: "message_end"; message: TranscriptEntry }
  | { type: "tool_execution_start"; callId: string; name: string; input: unknown }
  | { type: "tool_execution_update"; callId: string; name: string; partial: ToolOutput }
  | {
      type: "tool_execution_end";
      callId: string;
      name: string;
      result: ToolResultEntry;
      isError: boolean;
    }
  | { type: "turn_end"; turn: number; message: ModelEntry; toolResults: ToolResultEntry[] }
  | { type: "agent_end"; messages: TranscriptEntry[] };

export interface AgentLoopOptions {
  provider: ModelProvider;
  model: string;
  system: string;
  messages: TranscriptEntry[];
  tools: ToolSpec[];
  /** New messages that start this run, appended after `messages`. */
  prompts?: TranscriptEntry[];
  maxTurns?: number;
  signal: AbortSignal;
  /** Messages the user sent while the agent worked; read after each turn. */
  steering?: () => TranscriptEntry[];
  /** Messages queued for when the agent would otherwise stop. */
  followUps?: () => TranscriptEntry[];
  beforeToolCall?: BeforeToolCall;
  cacheKey?: string;
}

/** Runs model turns, executing tool calls between them, until the model stops. */
export async function* runAgentLoop(opts: AgentLoopOptions): AsyncIterable<AgentEvent> {
  let history = [...opts.messages];
  const added: TranscriptEntry[] = [];
  const maxTurns = opts.maxTurns ?? Number.POSITIVE_INFINITY;
  const record = function* (entry: TranscriptEntry): Generator<AgentEvent> {
    history.push(entry);
    added.push(entry);
    yield { type: "message_start", message: entry };
    yield { type: "message_end", message: entry };
  };

  yield { type: "agent_start" };
  let pending: TranscriptEntry[] = [...(opts.prompts ?? [])];
  let turn = 0;

  while (turn < maxTurns) {
    turn++;
    yield { type: "turn_start", turn };
    for (const entry of pending) yield* record(entry);
    pending = [];

    history = mendHistory(history).entries;
    const reply = yield* streamReply(opts, history);
    history.push(reply);
    added.push(reply);

    if (reply.stop === "error" || reply.stop === "aborted") {
      yield { type: "turn_end", turn, message: reply, toolResults: [] };
      break;
    }

    const calls = reply.content.filter((b): b is ToolCall => b.type === "call");
    const results: ToolResultEntry[] = [];
    for (const batch of batches(calls, opts.tools)) {
      for (const result of yield* runBatch(batch, opts)) {
        results.push(result);
        yield {
          type: "tool_execution_end",
          callId: result.callId,
          name: result.name,
          result,
          isError: result.isError,
        };
        yield* record(result);
      }
    }
    yield { type: "turn_end", turn, message: reply, toolResults: results };
    if (opts.signal.aborted) break;

    pending = opts.steering?.() ?? [];
    if (calls.length === 0 && pending.length === 0) {
      pending = opts.followUps?.() ?? [];
      if (pending.length === 0) break;
    }
  }

  yield { type: "agent_end", messages: added };
}

async function* streamReply(
  opts: AgentLoopOptions,
  history: TranscriptEntry[],
): AsyncGenerator<AgentEvent, ModelEntry> {
  const partial: ModelEntry = {
    role: "assistant",
    content: [],
    model: opts.model,
    usage: emptyUsage(),
    stop: "end",
  };
  yield { type: "message_start", message: partial };
  const failed = (message: string): ModelEntry => ({
    ...partial,
    stop: opts.signal.aborted ? "aborted" : "error",
    error: message,
  });

  let final: ModelEntry | undefined;
  try {
    for await (const event of opts.provider.stream({
      model: opts.model,
      system: opts.system,
      messages: [...history],
      tools: opts.tools,
      signal: opts.signal,
      cacheKey: opts.cacheKey,
    })) {
      if (event.type === "text_delta" || event.type === "thinking_delta") {
        yield { type: "message_update", message: partial, delta: event };
      } else if (event.type === "end") {
        final = event.entry;
      } else if (event.type === "error") {
        final = failed(event.message);
        break;
      }
    }
  } catch (err) {
    final = failed(err instanceof Error ? err.message : String(err));
  }
  final ??= failed("The model stream ended without a reply.");
  yield { type: "message_end", message: final };
  return final;
}

/** Consecutive read-only calls share a batch; any other call runs alone. */
function batches(calls: ToolCall[], tools: ToolSpec[]): ToolCall[][] {
  const out: ToolCall[][] = [];
  let reads: ToolCall[] = [];
  for (const call of calls) {
    const readOnly = findTool(tools, call.name)?.readOnly ?? true;
    if (readOnly) {
      reads.push(call);
      continue;
    }
    if (reads.length) out.push(reads);
    reads = [];
    out.push([call]);
  }
  if (reads.length) out.push(reads);
  return out;
}

/** Runs a batch concurrently, streaming updates, and returns results in call order. */
async function* runBatch(
  batch: ToolCall[],
  opts: AgentLoopOptions,
): AsyncGenerator<AgentEvent, ToolResultEntry[]> {
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };

  for (const call of batch) {
    yield { type: "tool_execution_start", callId: call.id, name: call.name, input: call.input };
  }
  let done = false;
  const all = Promise.all(
    batch.map((call) =>
      execute(call, opts, (partial) => {
        queue.push({ type: "tool_execution_update", callId: call.id, name: call.name, partial });
        notify();
      }),
    ),
  ).finally(() => {
    done = true;
    notify();
  });

  while (!done || queue.length) {
    const next = queue.shift();
    if (next) {
      yield next;
      continue;
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  }
  return all;
}

async function execute(
  call: ToolCall,
  opts: AgentLoopOptions,
  onUpdate: (partial: ToolOutput) => void,
): Promise<ToolResultEntry> {
  const output = await outputOf(call, opts, onUpdate);
  return {
    role: "tool",
    callId: call.id,
    name: call.name,
    content: output.content,
    isError: output.isError ?? false,
  };
}

async function outputOf(
  call: ToolCall,
  opts: AgentLoopOptions,
  onUpdate: (partial: ToolOutput) => void,
): Promise<ToolOutput> {
  const { signal } = opts;
  if (signal.aborted) return errorOutput(ABORTED_TEXT);
  const tool = findTool(opts.tools, call.name);
  if (!tool) return errorOutput(`Unknown tool: ${call.name}`);
  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) {
    return errorOutput(`Invalid input for ${call.name}: ${parsed.error.message}`);
  }
  if (opts.beforeToolCall) {
    const verdict = await opts.beforeToolCall(call);
    if (!verdict.allow) return errorOutput(verdict.reason);
  }
  if (signal.aborted) return errorOutput(ABORTED_TEXT);
  try {
    const output = await tool.run(parsed.data, { signal, onUpdate });
    return signal.aborted ? errorOutput(ABORTED_TEXT) : output;
  } catch (err) {
    if (signal.aborted) return errorOutput(ABORTED_TEXT);
    return errorOutput(err instanceof Error ? err.message : String(err));
  }
}
