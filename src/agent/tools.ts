import type { z } from "zod";
import type { Block } from "./transcript.ts";

export interface ToolOutput {
  content: Block[];
  isError?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  readOnly: boolean;
  run(
    input: unknown,
    ctx: { signal: AbortSignal; onUpdate?: (partial: ToolOutput) => void },
  ): Promise<ToolOutput>;
}

/** A tool output that tells the model what went wrong. */
export function errorOutput(text: string): ToolOutput {
  return { content: [{ type: "text", text }], isError: true };
}

export function findTool(tools: ToolSpec[], name: string): ToolSpec | undefined {
  return tools.find((t) => t.name === name);
}
