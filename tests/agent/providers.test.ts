import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { anthropicProvider } from "../../src/agent/providers/anthropic.ts";
import { openAICompatibleProvider } from "../../src/agent/providers/openai.ts";
import { withRetry } from "../../src/agent/providers/retry.ts";
import type {
  FetchFn,
  ModelProvider,
  ProviderRequest,
  StreamEvent,
} from "../../src/agent/providers/types.ts";
import type { ToolSpec } from "../../src/agent/tools.ts";
import { fakeProvider } from "../support/fakeProvider.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/streams/${name}`, import.meta.url), "utf8");

const sse = (body: string, init: ResponseInit = {}) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });

const readTool: ToolSpec = {
  name: "read_file",
  description: "Read a file",
  input: z.object({ path: z.string() }),
  readOnly: true,
  run: async () => ({ content: [] }),
};

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "test-model",
    system: "Be brief.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [readTool],
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(provider: ModelProvider, req = request()): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(req)) events.push(event);
  return events;
}

const fetchReturning =
  (...responses: Array<() => Response>): FetchFn =>
  async () => {
    const make = responses.length > 1 ? responses.shift() : responses[0];
    if (!make) throw new Error("no response");
    return make();
  };

describe("anthropic", () => {
  it("anthropic stream becomes text, thinking and calls", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      seen = { url: String(url), init: init ?? {} };
      return sse(fixture("anthropic-reply.txt"));
    };
    const provider = anthropicProvider({ apiKey: "sk-test", fetch: fetchFn });
    const events = await collect(provider, request({ thinking: { budgetTokens: 2000 } }));

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "thinking_delta",
      "thinking_delta",
      "text_delta",
      "text_delta",
      "call",
      "end",
    ]);
    expect(events.find((e) => e.type === "call")).toEqual({
      type: "call",
      id: "toolu_01",
      name: "read_file",
      input: { path: "a.txt" },
    });
    const end = events.at(-1);
    if (end?.type !== "end") throw new Error("no end");
    expect(end.entry.stop).toBe("tool_calls");
    expect(end.entry.content).toEqual([
      { type: "thinking", text: "Let me check the file.", signature: "sig" },
      { type: "text", text: "Reading it now." },
      { type: "call", id: "toolu_01", name: "read_file", input: { path: "a.txt" } },
    ]);

    expect(seen?.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    const body = JSON.parse(String(seen?.init.body));
    expect(body.stream).toBe(true);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2000 });
    expect(body.max_tokens).toBeGreaterThan(2000);
    expect(body.tools[0]).toMatchObject({
      name: "read_file",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    });
    expect(body.tools[0].input_schema.$schema).toBeUndefined();
  });

  it("maps stop reasons and sends results of calls back as tool_result", async () => {
    let body: { messages: unknown[] } | undefined;
    const fetchFn: FetchFn = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sse(
        'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1}}}\n\n' +
          'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":2}}\n\n' +
          'data: {"type":"message_stop"}\n\n',
      );
    };
    const events = await collect(
      anthropicProvider({ apiKey: "k", fetch: fetchFn }),
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "hmm" },
              { type: "call", id: "t1", name: "read_file", input: { path: "x" } },
            ],
            model: "m",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            stop: "tool_calls",
          },
          {
            role: "tool",
            callId: "t1",
            name: "read_file",
            content: [{ type: "text", text: "data" }],
            isError: false,
          },
        ],
      }),
    );
    const end = events.at(-1);
    expect(end?.type === "end" && end.entry.stop).toBe("length");
    expect(body?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "x" } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "data" }],
            is_error: false,
          },
        ],
      },
    ]);
  });

  it("usage is reported on end", async () => {
    const provider = anthropicProvider({
      apiKey: "k",
      fetch: fetchReturning(() => sse(fixture("anthropic-reply.txt"))),
    });
    const end = (await collect(provider)).at(-1);
    if (end?.type !== "end") throw new Error("no end");
    expect(end.entry.usage).toEqual({ input: 25, output: 42, cacheRead: 10, cacheWrite: 5 });
    expect(end.entry.model).toBe("claude-test");
  });
});

describe("openai-compatible", () => {
  const make = (fetchFn: FetchFn) =>
    openAICompatibleProvider({
      apiKey: "sk-oai",
      baseUrl: "https://example.test/v1",
      id: "openrouter",
      fetch: fetchFn,
    });

  it("openai stream assembles call arguments split across chunks", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const provider = make(async (url, init) => {
      seen = { url: String(url), init: init ?? {} };
      return sse(fixture("openai-calls.txt"));
    });
    const events = await collect(provider, request({ thinking: { budgetTokens: 999 } }));

    expect(events.filter((e) => e.type === "text_delta")).toHaveLength(2);
    expect(events.filter((e) => e.type === "call")).toEqual([
      { type: "call", id: "call_a", name: "read_file", input: { path: "a.txt" } },
      { type: "call", id: "call_b", name: "list_dir", input: { dir: "src" } },
    ]);
    const end = events.at(-1);
    if (end?.type !== "end") throw new Error("no end");
    expect(end.entry.stop).toBe("tool_calls");
    expect(end.entry.content.map((b) => b.type)).toEqual(["text", "call", "call"]);

    expect(seen?.url).toBe("https://example.test/v1/chat/completions");
    const body = JSON.parse(String(seen?.init.body));
    expect(body.thinking).toBeUndefined();
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages[0]).toEqual({ role: "system", content: "Be brief." });
    expect(body.tools[0].function.name).toBe("read_file");
    expect(((seen?.init.headers ?? {}) as Record<string, string>).authorization).toBe(
      "Bearer sk-oai",
    );
  });

  it("usage is reported on end", async () => {
    const end = (await collect(make(fetchReturning(() => sse(fixture("openai-calls.txt")))))).at(
      -1,
    );
    if (end?.type !== "end") throw new Error("no end");
    expect(end.entry.usage).toEqual({ input: 30, output: 12, cacheRead: 8, cacheWrite: 0 });
  });

  it("maps stop and length finish reasons and replays calls and results", async () => {
    let body: { messages: unknown[] } | undefined;
    const provider = make(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return sse(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
      );
    });
    const events = await collect(
      provider,
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "assistant",
            content: [{ type: "call", id: "c1", name: "read_file", input: { path: "x" } }],
            model: "m",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            stop: "tool_calls",
          },
          {
            role: "tool",
            callId: "c1",
            name: "read_file",
            content: [{ type: "text", text: "data" }],
            isError: false,
          },
        ],
      }),
    );
    const end = events.at(-1);
    expect(end?.type === "end" && end.entry.stop).toBe("length");
    expect(body?.messages.slice(2)).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"x"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "data" },
    ]);
  });
});

describe("retry", () => {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };

  it("retries rate limits then reports", async () => {
    delays.length = 0;
    const flaky = anthropicProvider({
      apiKey: "k",
      fetch: fetchReturning(
        () => new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
        () => sse(fixture("anthropic-reply.txt")),
      ),
    });
    const events = await collect(withRetry(flaky, { attempts: 4, baseMs: 500, sleep }));
    expect(events.filter((e) => e.type === "retry")).toEqual([
      { type: "retry", attempt: 1, delayMs: 2000, reason: expect.stringContaining("429") },
    ]);
    expect(events.at(-1)?.type).toBe("end");
    expect(delays).toEqual([2000]);

    delays.length = 0;
    const overloaded = anthropicProvider({
      apiKey: "k",
      fetch: fetchReturning(() => new Response("overloaded", { status: 529 })),
    });
    const failed = await collect(withRetry(overloaded, { attempts: 4, baseMs: 500, sleep }));
    expect(failed.filter((e) => e.type === "retry")).toHaveLength(3);
    expect(delays).toEqual([500, 1000, 2000]);
    const last = failed.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" && last.message).toContain("529");
  });

  it("does not retry client errors", async () => {
    const bad = anthropicProvider({
      apiKey: "k",
      fetch: fetchReturning(() => new Response("nope", { status: 400 })),
    });
    const events = await collect(withRetry(bad, { attempts: 4, baseMs: 1, sleep }));
    expect(events.map((e) => e.type)).toEqual(["error"]);
  });

  it("retries network errors", async () => {
    let calls = 0;
    const provider = anthropicProvider({
      apiKey: "k",
      fetch: async () => {
        if (++calls === 1) throw new TypeError("fetch failed");
        return sse(fixture("anthropic-reply.txt"));
      },
    });
    const events = await collect(withRetry(provider, { attempts: 4, baseMs: 1, sleep }));
    expect(events.map((e) => e.type)).toContain("retry");
    expect(events.at(-1)?.type).toBe("end");
  });
});

describe("abort and secrets", () => {
  it("abort stops the stream with stop aborted", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    const fetchFn: FetchFn = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            encoder.encode(
              'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":3}}}\n\n' +
                'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
                'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"par"}}\n\n',
            ),
          );
          init?.signal?.addEventListener("abort", () =>
            stream.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(body, { status: 200 });
    };
    const events: StreamEvent[] = [];
    for await (const event of anthropicProvider({ apiKey: "k", fetch: fetchFn }).stream(
      request({ signal: controller.signal }),
    )) {
      events.push(event);
      if (event.type === "text_delta") controller.abort();
    }
    const end = events.at(-1);
    if (end?.type !== "end") throw new Error("no end");
    expect(end.entry.stop).toBe("aborted");
    expect(end.entry.content).toEqual([{ type: "text", text: "par" }]);
  });

  it("model key never appears in errors", async () => {
    const key = "sk-secret-123";
    const cases: ModelProvider[] = [
      anthropicProvider({
        apiKey: key,
        fetch: fetchReturning(() => new Response(`bad key ${key}`, { status: 401 })),
      }),
      openAICompatibleProvider({
        apiKey: key,
        baseUrl: "https://example.test/v1",
        id: "oai",
        fetch: async () => {
          throw new TypeError(`connect failed for Bearer ${key}`);
        },
      }),
      // An error the server sends inside the stream may echo the key too.
      anthropicProvider({
        apiKey: key,
        fetch: fetchReturning(() =>
          sse(
            'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1}}}\n\n' +
              `data: {"type":"error","error":{"type":"api_error","message":"key ${key} refused"}}\n\n`,
          ),
        ),
      }),
    ];
    for (const provider of cases) {
      const events = await collect(provider);
      const error = events.at(-1);
      expect(error?.type).toBe("error");
      expect(JSON.stringify(events)).not.toContain(key);
    }
  });
});

describe("thinking replay", () => {
  const replayBody = async (stream: string) => {
    const first = await collect(
      anthropicProvider({ apiKey: "k", fetch: fetchReturning(() => sse(stream)) }),
    );
    const end = first.at(-1);
    if (end?.type !== "end") throw new Error("no end");
    let body: { messages: Array<{ role: string; content: unknown[] }> } | undefined;
    await collect(
      anthropicProvider({
        apiKey: "k",
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body));
          return sse(
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
          );
        },
      }),
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          end.entry,
          {
            role: "tool",
            callId: "toolu_01",
            name: "read_file",
            content: [{ type: "text", text: "data" }],
            isError: false,
          },
        ],
      }),
    );
    return { entry: end.entry, body };
  };

  it("anthropic keeps thinking signatures for replay", async () => {
    const { entry, body } = await replayBody(fixture("anthropic-reply.txt"));
    expect(entry.content[0]).toEqual({
      type: "thinking",
      text: "Let me check the file.",
      signature: "sig",
    });
    expect(body?.messages[1]?.content).toEqual([
      { type: "thinking", thinking: "Let me check the file.", signature: "sig" },
      { type: "text", text: "Reading it now." },
      { type: "tool_use", id: "toolu_01", name: "read_file", input: { path: "a.txt" } },
    ]);
  });

  it("redacted thinking survives replay", async () => {
    const stream =
      'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1}}}\n\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque"}}\n\n' +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01","name":"read_file","input":{}}}\n\n' +
      'data: {"type":"content_block_stop","index":1}\n\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n';
    const { entry, body } = await replayBody(stream);
    expect(entry.content[0]).toEqual({ type: "redacted_thinking", data: "opaque" });
    expect(body?.messages[1]?.content[0]).toEqual({ type: "redacted_thinking", data: "opaque" });
  });

  it("openai drops thinking on replay", async () => {
    let body: { messages: unknown[] } | undefined;
    const provider = openAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://example.test/v1",
      id: "oai",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return sse('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      },
    });
    await collect(
      provider,
      request({
        system: "",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "hmm", signature: "s" },
              { type: "redacted_thinking", data: "x" },
              { type: "text", text: "answer" },
            ],
            model: "m",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            stop: "end",
          },
        ],
      }),
    );
    expect(body?.messages).toEqual([{ role: "assistant", content: "answer" }]);
  });
});

describe("fakeProvider", () => {
  it("plays one reply per call", async () => {
    const fake = fakeProvider([
      [{ type: "text_delta", text: "a" }],
      [{ type: "text_delta", text: "b" }],
    ]);
    expect(await collect(fake)).toEqual([{ type: "text_delta", text: "a" }]);
    expect(await collect(fake)).toEqual([{ type: "text_delta", text: "b" }]);
    expect(fake.requests).toHaveLength(2);
  });
});
