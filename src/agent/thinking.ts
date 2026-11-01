import type { Thinking } from "./providers/types.ts";

/** Tokens the model may spend thinking before it answers, at each level above off. */
export const THINKING_BUDGETS = {
  minimal: 1024,
  low: 4096,
  medium: 10_000,
  high: 20_000,
  xhigh: 32_000,
  max: 64_000,
} as const;

export const THINKING_LEVELS = ["off", ...Object.keys(THINKING_BUDGETS)] as readonly string[];

/** What to ask of the model for a thinking level; nothing for off or an unknown level. */
export function thinkingFor(level: string | null | undefined): Thinking | undefined {
  if (!level || !Object.hasOwn(THINKING_BUDGETS, level)) return undefined;
  return { budgetTokens: THINKING_BUDGETS[level as keyof typeof THINKING_BUDGETS] };
}
