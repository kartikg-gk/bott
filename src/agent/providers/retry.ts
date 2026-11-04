import { emptyUsage } from "../transcript.ts";
import type { ModelProvider, ProviderRequest, StreamEvent } from "./types.ts";

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  /** Waits; injectable so tests do not sleep. Resolves early when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

/** Retries a stream that failed before producing any event: rate limits, overload and network errors. */
export function withRetry(provider: ModelProvider, options: RetryOptions): ModelProvider {
  const sleep = options.sleep ?? realSleep;
  return {
    id: provider.id,
    async *stream(req: ProviderRequest): AsyncIterable<StreamEvent> {
      for (let attempt = 1; ; attempt++) {
        let produced = false;
        let failure: Extract<StreamEvent, { type: "error" }> | undefined;
        for await (const event of provider.stream(req)) {
          if (event.type === "error" && !produced) {
            failure = event;
            break;
          }
          produced = true;
          yield event;
        }
        if (!failure) return;
        if (!failure.retryable || attempt >= options.attempts) {
          yield failure;
          return;
        }
        const delayMs = failure.retryAfterMs ?? options.baseMs * 2 ** (attempt - 1);
        yield { type: "retry", attempt, delayMs, reason: failure.message };
        await sleep(delayMs, req.signal);
        if (req.signal.aborted) {
          yield {
            type: "end",
            entry: {
              role: "assistant",
              content: [],
              model: req.model,
              usage: emptyUsage(),
              stop: "aborted",
            },
          };
          return;
        }
      }
    },
  };
}
