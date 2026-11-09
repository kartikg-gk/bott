import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.ts";
import { type RuntimeConfig, SessionManager } from "../src/runtime/sessions.ts";
import { Store } from "../src/store/store.ts";
import {
  observation,
  observeEvent,
  setTraceExporter,
  TraceExporter,
  traced,
} from "../src/tracing.ts";
import { database } from "./support/fakeD1.ts";
import { reply } from "./web/support.ts";

interface Sent {
  url: string;
  headers: Record<string, string>;
  // biome-ignore lint/suspicious/noExplicitAny: OTLP bodies are read loosely
  body: any;
}

function capture() {
  const sent: Sent[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response("{}", { status: 200 });
  };
  const exporter = new TraceExporter("https://cloud.langfuse.example/", "pk", "sk", fetcher);
  setTraceExporter(exporter);
  return { sent, exporter };
}

// biome-ignore lint/suspicious/noExplicitAny: spans are read loosely
const spansOf = (sent: Sent): any[] => sent.body.resourceSpans[0].scopeSpans[0].spans;
// biome-ignore lint/suspicious/noExplicitAny: spans are read loosely
const attr = (span: any, key: string) =>
  span.attributes.find((a: { key: string }) => a.key === key)?.value;

afterEach(() => setTraceExporter(null));

describe("run traces", () => {
  it("are off without an address and refuse settings that cannot work", () => {
    expect(TraceExporter.fromEnv({})).toBeNull();
    const bad = [
      { BOTT_LANGFUSE_URL: "http://cloud.langfuse.example" },
      { BOTT_LANGFUSE_URL: "https://user:pw@cloud.langfuse.example" },
      { BOTT_LANGFUSE_URL: "not a url" },
      { BOTT_LANGFUSE_URL: "https://cloud.langfuse.example", BOTT_LANGFUSE_PUBLIC_KEY: "pk" },
    ];
    for (const env of bad) expect(() => TraceExporter.fromEnv(env)).toThrow(ConfigError);
    const local = { BOTT_LANGFUSE_URL: "http://localhost:3000" };
    expect(
      TraceExporter.fromEnv({
        ...local,
        BOTT_LANGFUSE_PUBLIC_KEY: "a",
        BOTT_LANGFUSE_SECRET_KEY: "b",
      }),
    ).toBeInstanceOf(TraceExporter);
  });

  it("send model and tool spans with counts but no words from the run", async () => {
    const { sent, exporter } = capture();
    const source = {};
    const usage = { input: 40, output: 7, cacheRead: 5, cacheWrite: 0, cost: { total: 0.01 } };
    await traced("prompt", async () => {
      observeEvent(source, { type: "message_start", message: { role: "user" } });
      observeEvent(source, {
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      observeEvent(source, {
        type: "message_end",
        message: { role: "assistant", model: "m-1", usage, content: "secret plan", stop: "end" },
      });
      observeEvent(source, { type: "tool_execution_start", toolCallId: "c1", toolName: "Bash" });
      observeEvent(source, {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "Bash",
        isError: true,
      });
      await observation("delegation", "agent", async () => {});
      observeEvent(source, { type: "agent_settled", outcome: "completed" });
    });
    await exporter.close();
    expect(sent).toHaveLength(1);
    const [one] = sent as [Sent];
    expect(one.url).toBe("https://cloud.langfuse.example/api/public/otel/v1/traces");
    expect(one.headers.authorization).toBe(`Basic ${Buffer.from("pk:sk").toString("base64")}`);
    expect(JSON.stringify(one.body)).not.toContain("secret plan");
    const spans = spansOf(one);
    expect(spans.map((s) => s.name)).toEqual(["model", "Bash", "delegation", "prompt"]);
    const [model, tool, delegation, root] = spans;
    expect(attr(model, "gen_ai.response.model")).toEqual({ stringValue: "m-1" });
    expect(attr(model, "gen_ai.usage.input_tokens")).toEqual({ intValue: "40" });
    expect(attr(model, "gen_ai.usage.cache_read.input_tokens")).toEqual({ intValue: "5" });
    expect(tool.status).toEqual({ code: 2 });
    expect(delegation.parentSpanId).toBe(root.spanId);
    expect(root.parentSpanId).toBeUndefined();
    expect(root.status).toEqual({ code: 1 });
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1);
  });

  it("mark a run failed when it did not complete, and do nothing when off", async () => {
    const { sent, exporter } = capture();
    await traced("job", async () => ({ outcome: "failed" }));
    await expect(
      traced("job", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await exporter.close();
    expect(sent.map((s) => spansOf(s).at(-1).status.code)).toEqual([2, 2]);
    setTraceExporter(null);
    expect(await traced("job", async () => 5)).toBe(5);
    expect(sent).toHaveLength(2);
  });

  it("follow a session's events into the run's trace", async () => {
    const { sent, exporter } = capture();
    const { db } = database("sqlite");
    const root = mkdtempSync(join(tmpdir(), "trace-"));
    const store = await Store.open(db, "main");
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
    };
    const sessions = new SessionManager(config, store, () => ({
      id: "fake",
      async *stream() {
        yield* reply("hello");
      },
    }));
    try {
      const route = await store.conversation(1, 1);
      await traced("prompt", () => sessions.prompt(route, "hi"));
      await exporter.close();
      expect(spansOf(sent[0] as Sent).map((s) => s.name)).toEqual(["model", "prompt"]);
    } finally {
      await sessions.close();
      await db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
