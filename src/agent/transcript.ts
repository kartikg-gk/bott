export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "call"; id: string; name: string; input: unknown };

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type StopReason = "end" | "tool_calls" | "length" | "error" | "aborted";

export interface UserEntry {
  role: "user";
  content: Block[];
}

export interface ModelEntry {
  role: "assistant";
  content: Block[];
  model: string;
  usage: Usage;
  stop: StopReason;
  error?: string;
}

export interface ToolResultEntry {
  role: "tool";
  callId: string;
  name: string;
  content: Block[];
  isError: boolean;
}

export type TranscriptEntry = UserEntry | ModelEntry | ToolResultEntry;

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function textOf(blocks: Block[]): string {
  return blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}
