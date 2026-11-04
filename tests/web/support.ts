import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Policy } from "../../src/agent/policy.ts";
import type { ModelProvider, StreamEvent } from "../../src/agent/providers/types.ts";
import { emptyUsage } from "../../src/agent/transcript.ts";
import type { Database } from "../../src/db/database.ts";
import type { RuntimeConfig } from "../../src/runtime/sessions.ts";
import { createApp } from "../../src/web/app.ts";
import { Gateway, type GatewayOptions } from "../../src/web/gateway.ts";
import { type Backend, database } from "../support/fakeD1.ts";
import { type FakeProvider, fakeProvider } from "../support/fakeProvider.ts";

export const TOKEN = "a-token-long-enough-for-tests";

export function reply(text: string, usage = emptyUsage()): StreamEvent[] {
  return [
    { type: "start", model: "m" },
    { type: "text_delta", text },
    {
      type: "end",
      entry: {
        role: "assistant",
        content: [{ type: "text", text }],
        model: "m",
        usage,
        stop: "end",
      },
    },
  ];
}

export function toolCall(name: string, input: unknown, id = "c1"): StreamEvent[] {
  return [
    { type: "start", model: "m" },
    {
      type: "end",
      entry: {
        role: "assistant",
        content: [{ type: "call", id, name, input }],
        model: "m",
        usage: emptyUsage(),
        stop: "end",
      },
    },
  ];
}

/** Holds a model call until opened; an aborted run gets through with an error. */
export class Gate {
  private open!: () => void;
  private arrive!: () => void;
  readonly opened = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  readonly reached = new Promise<void>((resolve) => {
    this.arrive = resolve;
  });

  release(): void {
    this.open();
  }

  async pass(signal: AbortSignal): Promise<void> {
    this.arrive();
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      void this.opened.then(resolve);
    });
  }
}

/** Plays the script, holding the calls that have a gate (by call number) until it opens. */
export function gated(script: StreamEvent[][], gates: Record<number, Gate> = {}): FakeProvider {
  const inner = fakeProvider(script);
  let calls = 0;
  return {
    id: inner.id,
    requests: inner.requests,
    async *stream(req) {
      const gate = gates[calls++];
      if (gate) await gate.pass(req.signal);
      yield* inner.stream(req);
    },
  };
}

/** Builds gateways for one test file and cleans them up afterwards. */
export class Harness {
  private readonly cleanups: (() => Promise<void> | void)[] = [];

  constructor(readonly kind: Backend) {}

  folder(): string {
    const root = mkdtempSync(join(tmpdir(), "web-"));
    this.cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
  }

  database(): Database {
    const { db } = database(this.kind);
    this.cleanups.push(() => db.close());
    return db;
  }

  runtime(root: string, policy: Policy = "auto", hosted = false): RuntimeConfig {
    return {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: hosted ? null : join(root, "sessions"),
      policy,
      model: "m",
      idleSeconds: 60,
    };
  }

  async gateway(
    provider: ModelProvider,
    opts: Partial<GatewayOptions> & { policy?: Policy } = {},
  ): Promise<Gateway> {
    const root = this.folder();
    const gateway = await Gateway.open({
      db: opts.db ?? this.database(),
      instance: "main",
      runtime: this.runtime(root, opts.policy, opts.hosted),
      providers: () => provider,
      ...opts,
    });
    this.cleanups.unshift(() => gateway.close());
    return gateway;
  }

  /** A handler for one gateway, with a helper that sends the token. */
  app(gateway: Gateway) {
    const handler = createApp({ token: TOKEN, gateway, page: "<html>page</html>" });
    const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
      const headers = new Headers(init.headers);
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${TOKEN}`);
      const { json, ...rest } = init;
      return handler(
        new Request(`http://127.0.0.1${path}`, {
          ...rest,
          headers,
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        }),
      );
    };
    return { handler, call };
  }

  async close(): Promise<void> {
    for (const cleanup of this.cleanups.splice(0)) await cleanup();
  }
}

/** Reads server-sent records from a stream until `done` says to stop. */
export async function readEvents(
  response: Response,
  done: (records: Record<string, unknown>[]) => boolean,
): Promise<Record<string, unknown>[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const records: Record<string, unknown>[] = [];
  let buffer = "";
  try {
    while (!done(records)) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        const id = block.split("\n").find((line) => line.startsWith("id: "));
        if (data) {
          const record = JSON.parse(data.slice(6)) as Record<string, unknown>;
          if (id) record._seq = Number(id.slice(4));
          records.push(record);
        }
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return records;
}
