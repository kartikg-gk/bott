import { z } from "zod";
import type { ToolSpec } from "../tools.ts";
import type { FetchFn, StreamEvent } from "./types.ts";

export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

type ErrorEvent = Extract<StreamEvent, { type: "error" }>;

export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

export function toolSchema(tool: ToolSpec): Record<string, unknown> {
  const { $schema: _omit, ...schema } = z.toJSONSchema(tool.input) as Record<string, unknown>;
  return schema;
}

export function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === "AbortError");
}

export type Opened =
  | { ok: true; response: Response }
  | { ok: false; event: ErrorEvent | "aborted" };

/** Sends the request; HTTP failures and network failures come back as an error event. */
export async function openStream(
  fetchFn: FetchFn,
  label: string,
  url: string,
  init: RequestInit & { signal: AbortSignal },
  secret: string,
): Promise<Opened> {
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch (err) {
    if (isAbort(err, init.signal)) return { ok: false, event: "aborted" };
    const detail = redact(err instanceof Error ? err.message : String(err), secret);
    return {
      ok: false,
      event: { type: "error", message: `${label} request failed: ${detail}`, retryable: true },
    };
  }
  if (response.ok && response.body) return { ok: true, response };
  const body = redact(await response.text().catch(() => ""), secret).slice(0, 500);
  const event: ErrorEvent = {
    type: "error",
    message: `${label} returned status ${response.status}${body ? `: ${body}` : ""}`,
    status: response.status,
    retryable: RETRYABLE_STATUS.has(response.status),
  };
  const header = response.headers.get("retry-after");
  const seconds = Number(header);
  if (header !== null && Number.isFinite(seconds) && seconds >= 0) {
    event.retryAfterMs = seconds * 1000;
  }
  return { ok: false, event };
}

/** Yields the data payloads of a server-sent event body. Stops early when the signal aborts. */
export async function* sseData(response: Response, signal: AbortSignal): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort);
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (isAbort(err, signal)) return;
        throw err;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n?/g, "\n");
      let sep = buffer.indexOf("\n\n");
      while (sep >= 0) {
        const data = dataOf(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (data !== undefined) yield data;
        sep = buffer.indexOf("\n\n");
      }
    }
    const rest = dataOf(buffer);
    if (rest !== undefined) yield rest;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function dataOf(rawEvent: string): string | undefined {
  const lines: string[] = [];
  for (const line of rawEvent.split("\n")) {
    if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /, ""));
  }
  return lines.length ? lines.join("\n") : undefined;
}

export function endedEarly(label: string, secret: string, err?: unknown): ErrorEvent {
  const detail = err instanceof Error ? `: ${redact(err.message, secret)}` : "";
  return { type: "error", message: `${label} stream ended before completion${detail}` };
}
