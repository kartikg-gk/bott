/**
 * Opt-in export of what each run did, as OpenTelemetry spans sent to Langfuse. Only shapes and
 * counts leave the server: span names, model and tool names, token counts, cost and whether
 * each step failed. No prompt, answer, tool input or tool output is sent.
 *
 * A run is traced by wrapping it in `traced`; the session events seen inside it become spans,
 * and `observation` adds a nested span such as a delegation. Without an exporter set, both only
 * run the work.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { ConfigError, type Env } from "./config.ts";
import { RunUsage } from "./limits/usage.ts";

export const LANGFUSE_URL = "BOTT_LANGFUSE_URL";
export const LANGFUSE_PUBLIC_KEY = "BOTT_LANGFUSE_PUBLIC_KEY";
export const LANGFUSE_SECRET_KEY = "BOTT_LANGFUSE_SECRET_KEY";

/** Most spans one trace keeps, so a runaway run cannot grow an export without bound. */
export const MAX_SPANS = 256;
/** Most exports in flight; traces beyond it are dropped rather than queued. */
const MAX_SENDING = 16;
/** Names sent as they are; anything else is sent as "unknown". */
const SAFE_NAME = /^[a-zA-Z0-9._:/-]{1,120}$/;

type Attribute = { key: string; value: Record<string, unknown> };

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  status?: { code: 1 | 2 };
  attributes: Attribute[];
}

function attribute(key: string, value: string | number): Attribute {
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  return { key, value: { doubleValue: value } };
}

const nowNanos = (): bigint => BigInt(Date.now()) * 1_000_000n;
const safe = (name: unknown): string =>
  typeof name === "string" && SAFE_NAME.test(name) ? name : "unknown";

/** One traced run: a root span with the model calls, tool calls and nested work under it. */
export class Trace {
  readonly id = randomBytes(16).toString("hex");
  readonly root: Span;
  readonly spans: Span[] = [];
  private readonly open = new Map<string, Span>();
  closed = false;
  failed = false;

  constructor(readonly name: string) {
    this.root = this.start(name, "agent", null);
  }

  start(name: string, kind: string, parent: Span | null): Span {
    return {
      traceId: this.id,
      spanId: randomBytes(8).toString("hex"),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name,
      kind: 1,
      startTimeUnixNano: String(nowNanos()),
      attributes: [
        attribute("langfuse.observation.type", kind),
        attribute("langfuse.trace.name", this.name),
      ],
    };
  }

  finish(span: Span, failed: boolean, extra: Record<string, string | number> = {}): void {
    if (this.spans.length >= MAX_SPANS && span !== this.root) return;
    const started = BigInt(span.startTimeUnixNano);
    const now = nowNanos();
    span.endTimeUnixNano = String(now > started ? now : started);
    span.status = { code: failed ? 2 : 1 };
    for (const [key, value] of Object.entries(extra)) span.attributes.push(attribute(key, value));
    this.spans.push(span);
  }

  /** Turns one session event into span starts and ends under `parent`. */
  observe(parent: Span, source: object, event: unknown): void {
    if (this.closed || typeof event !== "object" || event === null) return;
    const e = event as Record<string, unknown>;
    const tag = sourceTag(source);
    if (e.type === "agent_settled" && e.outcome !== "completed") this.failed = true;
    if (e.type === "message_start" || e.type === "message_end") {
      const message = (e.message ?? {}) as Record<string, unknown>;
      if (message.role !== "assistant") return;
      const key = `${tag}:model`;
      if (e.type === "message_start") {
        if (this.open.size < MAX_SPANS)
          this.open.set(key, this.start("model", "generation", parent));
        return;
      }
      const span = this.open.get(key) ?? this.start("model", "generation", parent);
      this.open.delete(key);
      const usage = new RunUsage();
      usage.observe(event);
      const used = usage.result();
      this.finish(span, message.stop === "error", {
        "gen_ai.response.model": safe(message.model),
        "gen_ai.usage.input_tokens": used.input,
        "gen_ai.usage.output_tokens": used.output,
        "gen_ai.usage.cache_read.input_tokens": used.cache_read,
        "gen_ai.usage.cache_creation.input_tokens": used.cache_write,
        "bott.reported_cost_usd": used.cost_usd,
      });
      return;
    }
    if (e.type === "tool_execution_start" || e.type === "tool_execution_end") {
      const name = safe(e.toolName ?? e.name);
      const key = `${tag}:tool:${String(e.toolCallId ?? e.callId)}`;
      if (e.type === "tool_execution_start") {
        if (this.open.size < MAX_SPANS) this.open.set(key, this.start(name, "tool", parent));
        return;
      }
      const span = this.open.get(key) ?? this.start(name, "tool", parent);
      this.open.delete(key);
      this.finish(span, e.isError === true);
    }
  }

  /** Ends whatever is still open as failed, then the root. */
  close(failed: boolean): void {
    for (const span of this.open.values()) this.finish(span, true);
    this.open.clear();
    this.finish(this.root, failed || this.failed);
    this.closed = true;
  }
}

/** A stable tag for each session object, so two sessions' open spans never mix. */
const tags = new WeakMap<object, string>();
function sourceTag(source: object): string {
  let tag = tags.get(source);
  if (!tag) {
    tag = randomBytes(4).toString("hex");
    tags.set(source, tag);
  }
  return tag;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Sends finished traces to Langfuse's OpenTelemetry endpoint, a few at a time. */
export class TraceExporter {
  private readonly endpoint: string;
  private readonly auth: string;
  private readonly sending = new Set<Promise<void>>();

  constructor(
    base: string,
    publicKey: string,
    secretKey: string,
    private readonly fetcher: Fetch = fetch,
  ) {
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      throw new ConfigError(`${LANGFUSE_URL} must be an https address, or http on this machine`);
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(url.protocol === "https:" || (local && url.protocol === "http:"))
    ) {
      throw new ConfigError(`${LANGFUSE_URL} must be an https address, or http on this machine`);
    }
    if (!publicKey || !secretKey) {
      throw new ConfigError(`Set both ${LANGFUSE_PUBLIC_KEY} and ${LANGFUSE_SECRET_KEY}`);
    }
    this.endpoint = `${base.replace(/\/+$/, "")}/api/public/otel/v1/traces`;
    this.auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  }

  /** The exporter the environment asks for, or null when no Langfuse address is set. */
  static fromEnv(env: Env, fetcher?: Fetch): TraceExporter | null {
    const base = env[LANGFUSE_URL]?.trim();
    if (!base) return null;
    return new TraceExporter(
      base,
      env[LANGFUSE_PUBLIC_KEY]?.trim() ?? "",
      env[LANGFUSE_SECRET_KEY]?.trim() ?? "",
      fetcher,
    );
  }

  /** Starts sending the trace; a failed send is noted in the log and dropped. */
  enqueue(trace: Trace): void {
    if (this.sending.size >= MAX_SENDING) return;
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [attribute("service.name", "bott")] },
          scopeSpans: [{ scope: { name: "bott" }, spans: trace.spans }],
        },
      ],
    };
    const sent = this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        authorization: this.auth,
        "content-type": "application/json",
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
      .then((reply) => {
        if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
      })
      .catch(() => console.warn("A run trace could not be sent to Langfuse"))
      .finally(() => this.sending.delete(sent));
    this.sending.add(sent);
  }

  /** Waits a little for sends still in flight. */
  async close(): Promise<void> {
    const waiting = Promise.allSettled([...this.sending]);
    await Promise.race([waiting, new Promise((resolve) => setTimeout(resolve, 4000).unref())]);
  }
}

const current = new AsyncLocalStorage<{ trace: Trace; parent: Span }>();
let exporter: TraceExporter | null = null;

/** Where finished traces go; null stops tracing. */
export function setTraceExporter(next: TraceExporter | null): void {
  exporter = next;
}

/**
 * Runs `work` as one traced run named `name`. A result with a `status` or `outcome` other than
 * completed, or a thrown error, marks the trace failed.
 */
export async function traced<T>(name: string, work: () => Promise<T>): Promise<T> {
  const sink = exporter;
  if (!sink) return work();
  const trace = new Trace(name);
  let failed = true;
  try {
    const result = await current.run({ trace, parent: trace.root }, work);
    const r = result as { status?: unknown; outcome?: unknown } | null;
    const ended = typeof r === "object" && r !== null ? (r.outcome ?? r.status) : undefined;
    failed = ended !== undefined && ended !== "completed";
    return result;
  } finally {
    trace.close(failed);
    sink.enqueue(trace);
  }
}

/** Runs `work` as a span of its own inside the current trace, when there is one. */
export async function observation<T>(
  name: string,
  kind: string,
  work: () => Promise<T>,
): Promise<T> {
  const state = current.getStore();
  if (!state || state.trace.closed) return work();
  const span = state.trace.start(name, kind, state.parent);
  let failed = true;
  try {
    const result = await current.run({ trace: state.trace, parent: span }, work);
    failed = false;
    return result;
  } finally {
    if (!state.trace.closed) state.trace.finish(span, failed);
  }
}

/** Passes a session event to the current trace, when there is one. */
export function observeEvent(source: object, event: unknown): void {
  const state = current.getStore();
  if (state) state.trace.observe(state.parent, source, event);
}
