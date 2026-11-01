import { z } from "zod";

/** One tool an app offers. The server runs it; the bot only sees what it returns. */
export interface AppTool {
  name: string;
  description: string;
  input: z.ZodTypeAny;
  /** Reads run without approval; everything else follows the bot's approval policy. */
  readOnly: boolean;
  /** Always asks the person first, whatever the bot's policy, unless the policy refuses. */
  review: boolean;
}

export const text = z.string().min(1);
export const count = z.number().int().min(1);
export const offset = z.number().int().min(0);
export const textList = z.array(text).max(100);

/**
 * Describes a tool. Every field is required unless named in `optional`. A write asks for
 * approval; `review` makes it ask even when the bot's other tools run unattended.
 */
export function tool(
  name: string,
  description: string,
  fields: Record<string, z.ZodTypeAny>,
  opts: { optional?: string[] | "all"; write?: boolean; review?: boolean } = {},
): AppTool {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, schema] of Object.entries(fields)) {
    const optional = opts.optional === "all" || (opts.optional ?? []).includes(key);
    shape[key] = optional ? schema.optional() : schema;
  }
  return {
    name,
    description,
    input: z.object(shape).strict(),
    readOnly: opts.write !== true,
    review: opts.review === true,
  };
}
