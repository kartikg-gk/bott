const COUNTS = [
  ["input", "input"],
  ["output", "output"],
  ["cache_read", "cacheRead"],
  ["cache_write", "cacheWrite"],
] as const;

export interface UsageTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  model_messages: number;
  cost_usd: number;
}

/** Adds up the token counts and cost providers report on each finished model message. */
export class RunUsage {
  private totals: UsageTotals = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    model_messages: 0,
    cost_usd: 0,
  };

  /** Takes any run event; only a finished model message with usage counts. */
  observe(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const { type, message } = event as { type?: unknown; message?: unknown };
    if (type !== "message_end" || typeof message !== "object" || message === null) return;
    const { role, usage } = message as { role?: unknown; usage?: unknown };
    if (role !== "assistant" || typeof usage !== "object" || usage === null) return;
    const given = usage as Record<string, unknown>;
    this.totals.model_messages += 1;
    for (const [total, field] of COUNTS) {
      const value = given[field];
      if (Number.isInteger(value) && (value as number) >= 0) this.totals[total] += value as number;
    }
    const cost = (given.cost as { total?: unknown } | undefined)?.total;
    if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
      this.totals.cost_usd += cost;
    }
  }

  result(): UsageTotals {
    return { ...this.totals };
  }
}
