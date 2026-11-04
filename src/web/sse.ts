/** What the work behind an event stream writes through. */
export interface EventWriter {
  /** Queues text for the reader; resolves once there is room for more. */
  send(text: string): Promise<void>;
  /** Aborted once the reader has gone away. */
  readonly signal: AbortSignal;
}

const encoder = new TextEncoder();

/**
 * A server-sent event response fed by `work`. The stream ends when the work returns or throws;
 * when the reader leaves first, `signal` aborts and later sends are dropped.
 */
export function eventStream(
  work: (out: EventWriter) => Promise<void>,
  headers: Record<string, string> = {},
): Response {
  const gone = new AbortController();
  let wake: (() => void) | undefined;
  const nudge = () => {
    wake?.();
    wake = undefined;
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const out: EventWriter = {
          signal: gone.signal,
          async send(text) {
            if (gone.signal.aborted) return;
            controller.enqueue(encoder.encode(text));
            // Wait while the reader is behind, so a slow reader cannot fill memory.
            while ((controller.desiredSize ?? 1) <= 0 && !gone.signal.aborted) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          },
        };
        void work(out)
          .catch(() => {})
          .finally(() => {
            if (gone.signal.aborted) return;
            try {
              controller.close();
            } catch {
              // The reader closed it first.
            }
          });
      },
      pull: nudge,
      cancel() {
        gone.abort();
        nudge();
      },
    },
    { highWaterMark: 64 },
  );
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", ...headers },
  });
}
