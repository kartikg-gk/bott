import type { ToolSpec } from "../tools.ts";
import type { ModelEntry, TranscriptEntry } from "../transcript.ts";

export interface Thinking {
  budgetTokens: number;
}

export type StreamEvent =
  | { type: "start"; model: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "call"; id: string; name: string; input: unknown }
  | { type: "end"; entry: ModelEntry }
  | { type: "retry"; attempt: number; delayMs: number; reason: string }
  | { type: "error"; message: string; status?: number; retryable?: boolean; retryAfterMs?: number };

export interface ProviderRequest {
  model: string;
  system: string;
  messages: TranscriptEntry[];
  tools: ToolSpec[];
  signal: AbortSignal;
  cacheKey?: string;
  thinking?: Thinking;
}

export interface ModelProvider {
  id: string;
  stream(req: ProviderRequest): AsyncIterable<StreamEvent>;
}

export type FetchFn = typeof fetch;
