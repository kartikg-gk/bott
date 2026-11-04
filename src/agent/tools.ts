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
