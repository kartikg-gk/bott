import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentEvent, runAgentLoop } from "../../src/agent/engine.ts";
import { mendHistory } from "../../src/agent/mending.ts";
import type { StreamEvent } from "../../src/agent/providers/types.ts";
import type { ToolSpec } from "../../src/agent/tools.ts";
import {
  emptyUsage,
  type ModelEntry,
  type ToolResultEntry,
  type TranscriptEntry,
} from "../../src/agent/transcript.ts";
import { fakeProvider } from "../support/fakeProvider.ts";

const user = (text: string): TranscriptEntry => ({
  role: "user",
  content: [{ type: "text", text }],
});

function reply(blocks: ModelEntry["content"], stop: ModelEntry["stop"] = "end"): StreamEvent[] {
  const events: StreamEvent[] = [{ type: "start", model: "m" }];
  for (const b of blocks) {
    if (b.type === "text") events.push({ type: "text_delta", text: b.text });
    if (b.type === "call") events.push({ type: "call", id: b.id, name: b.name, input: b.input });
  }
  events.push({
    type: "end",
    entry: { role: "assistant", content: blocks, model: "m", usage: emptyUsage(), stop },
  });
  return events;
}

const call = (id: string, name: string, input: unknown = {}) =>
  ({ type: "call", id, name, input }) as const;

function tool(name: string, readOnly: boolean, run: ToolSpec["run"]): ToolSpec {
  return { name, description: name, input: z.object({ n: z.number() }), readOnly, run };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const base = { model: "m", system: "s", signal: new AbortController().signal };

const toolResults = (events: AgentEvent[]): ToolResultEntry[] =>
  events.flatMap((e) => (e.type === "message_end" && e.message.role === "tool" ? [e.message] : []));

describe("runAgentLoop", () => {
  it("answers without tools in one turn", async () => {
    const provider = fakeProvider([reply([{ type: "text", text: "hello" }])]);
    const events = await collect(
      runAgentLoop({ ...base, provider, messages: [user("hi")], tools: [] }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    const update = nth(events, 3);
    expect(update.type === "message_update" && update.delta).toEqual({
      type: "text_delta",
      text: "hello",
    });
    expect(provider.requests).toHaveLength(1);
  });

  it("runs a tool and continues", async () => {
    const echo = tool("echo", true, async (input) => ({
      content: [{ type: "text", text: `got ${(input as { n: number }).n}` }],
    }));
    const provider = fakeProvider([
      reply([call("c1", "echo", { n: 3 })], "tool_calls"),
      reply([{ type: "text", text: "done" }]),
    ]);
    const events = await collect(
      runAgentLoop({ ...base, provider, messages: [user("hi")], tools: [echo] }),
    );
    expect(provider.requests).toHaveLength(2);
    const last = nth(provider.requests, 1).messages.at(-1) as ToolResultEntry;
    expect(last).toMatchObject({ role: "tool", callId: "c1", isError: false });
    expect(last.content).toEqual([{ type: "text", text: "got 3" }]);
    expect(events.filter((e) => e.type === "tool_execution_end")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(2);
  });

  it("runs read-only calls in parallel and write calls in order", async () => {
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const make = (name: string, readOnly: boolean, delay: number) =>
      tool(name, readOnly, async (input) => {
        const n = (input as { n: number }).n;
        running++;
        maxRunning = Math.max(maxRunning, running);
        log.push(`start ${name}${n}`);
        await new Promise((r) => setTimeout(r, delay - n));
        log.push(`end ${name}${n}`);
        running--;
        return { content: [{ type: "text", text: `${name}${n}` }] };
      });
    const provider = fakeProvider([
      reply(
        [
          call("a", "read", { n: 1 }),
          call("b", "read", { n: 2 }),
          call("c", "write", { n: 3 }),
          call("d", "read", { n: 4 }),
        ],
        "tool_calls",
      ),
      reply([{ type: "text", text: "ok" }]),
    ]);
    const events = await collect(
      runAgentLoop({
        ...base,
        provider,
        messages: [user("go")],
        tools: [make("read", true, 20), make("write", false, 8)],
      }),
    );
    expect(log.slice(0, 2)).toEqual(["start read1", "start read2"]);
    expect(log.indexOf("end read2")).toBeLessThan(log.indexOf("end read1"));
    expect(log.indexOf("start write3")).toBeGreaterThan(log.indexOf("end read1"));
    expect(log.indexOf("start read4")).toBeGreaterThan(log.indexOf("end write3"));
    expect(maxRunning).toBe(2);
    expect(toolResults(events).map((r) => r.callId)).toEqual(["a", "b", "c", "d"]);
  });

  it("blocked call returns the reason to the model", async () => {
    let ran = false;
    const t = tool("rm", false, async () => {
      ran = true;
      return { content: [] };
    });
    const provider = fakeProvider([
      reply([call("c1", "rm", { n: 1 })], "tool_calls"),
      reply([{ type: "text", text: "ok" }]),
    ]);
    await collect(
      runAgentLoop({
        ...base,
        provider,
        messages: [user("go")],
        tools: [t],
        beforeToolCall: async () => ({ allow: false, reason: "not allowed here" }),
      }),
    );
    expect(ran).toBe(false);
    const result = nth(provider.requests, 1).messages.at(-1) as ToolResultEntry;
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "not allowed here" }]);
  });

  it("approval hook failure blocks only that call", async () => {
    const ran: number[] = [];
    const t = tool("look", true, async (input) => {
      const n = (input as { n: number }).n;
      ran.push(n);
      return { content: [{ type: "text", text: `saw ${n}` }] };
    });
    const provider = fakeProvider([
      reply([call("a", "look", { n: 1 }), call("b", "look", { n: 2 })], "tool_calls"),
      reply([{ type: "text", text: "ok" }]),
    ]);
    const events = await collect(
      runAgentLoop({
        ...base,
        provider,
        messages: [user("go")],
        tools: [t],
        beforeToolCall: async (c) => {
          if (c.id === "a") throw new Error("hook down");
          return { allow: true };
        },
      }),
    );
    const results = toolResults(events);
    expect(results.map((r) => r.callId)).toEqual(["a", "b"]);
    expect(nth(results, 0).isError).toBe(true);
    expect(nth(results, 0).content).toEqual([
      { type: "text", text: "Approval check failed: hook down" },
    ]);
    expect(nth(results, 1).isError).toBe(false);
    expect(ran).toEqual([2]);
    expect(events.some((e) => e.type === "turn_end")).toBe(true);
    expect(events.at(-1)?.type).toBe("agent_end");
  });

  it("unknown tool and bad input become error results", async () => {
    const t = tool("echo", true, async () => ({ content: [{ type: "text", text: "x" }] }));
    const provider = fakeProvider([
      reply([call("c1", "nope", {}), call("c2", "echo", { n: "bad" })], "tool_calls"),
      reply([{ type: "text", text: "ok" }]),
    ]);
    const events = await collect(
      runAgentLoop({ ...base, provider, messages: [user("go")], tools: [t] }),
    );
    const r1 = nth(toolResults(events), 0);
    const r2 = nth(toolResults(events), 1);
    expect(r1.isError).toBe(true);
    expect(r1.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("nope") });
    expect(r2.isError).toBe(true);
    expect(r2.callId).toBe("c2");
  });

  it("steering message lands before the next turn", async () => {
    const t = tool("echo", true, async () => ({ content: [{ type: "text", text: "x" }] }));
    const provider = fakeProvider([
      reply([call("c1", "echo", { n: 1 })], "tool_calls"),
      reply([{ type: "text", text: "ok" }]),
    ]);
    let given = false;
    await collect(
      runAgentLoop({
        ...base,
        provider,
        messages: [user("go")],
        tools: [t],
        steering: () => {
          if (given) return [];
          given = true;
          return [user("actually stop")];
        },
      }),
    );
    const msgs = nth(provider.requests, 1).messages;
    expect(msgs.at(-2)?.role).toBe("tool");
    expect(msgs.at(-1)).toEqual(user("actually stop"));
  });

  it("follow-up starts another turn after the loop would end", async () => {
    const provider = fakeProvider([
      reply([{ type: "text", text: "one" }]),
      reply([{ type: "text", text: "two" }]),
    ]);
    let given = false;
    const events = await collect(
      runAgentLoop({
        ...base,
        provider,
        messages: [user("go")],
        tools: [],
        followUps: () => {
          if (given) return [];
          given = true;
          return [user("and then?")];
        },
      }),
    );
    expect(provider.requests).toHaveLength(2);
    expect(nth(provider.requests, 1).messages.at(-1)).toEqual(user("and then?"));
    expect(events.filter((e) => e.type === "agent_end")).toHaveLength(1);
  });

  it("stops at maxTurns", async () => {
    const t = tool("echo", true, async () => ({ content: [{ type: "text", text: "x" }] }));
    const again = (i: number) => reply([call(`c${i}`, "echo", { n: 1 })], "tool_calls");
    const provider = fakeProvider([again(1), again(2), again(3), again(4)]);
    const events = await collect(
      runAgentLoop({ ...base, provider, messages: [user("go")], tools: [t], maxTurns: 2 }),
    );
    expect(provider.requests).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("agent_end");
  });

  it("abort mid tool marks results aborted", async () => {
    const controller = new AbortController();
    const t = tool(
      "slow",
      true,
      (_input, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("stopped")));
          controller.abort();
        }),
    );
    const provider = fakeProvider([reply([call("c1", "slow", { n: 1 })], "tool_calls")]);
    const events = await collect(
      runAgentLoop({
        ...base,
        signal: controller.signal,
        provider,
        messages: [user("go")],
        tools: [t],
      }),
    );
    const r = nth(toolResults(events), 0);
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: "Tool call was aborted." }]);
    expect(provider.requests).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("agent_end");
  });

  it("mends a call with no result as interrupted", async () => {
    const provider = fakeProvider([reply([{ type: "text", text: "ok" }])]);
    const history: TranscriptEntry[] = [
      user("go"),
      {
        role: "assistant",
        content: [call("c1", "echo", { n: 1 })],
        model: "m",
        usage: emptyUsage(),
        stop: "tool_calls",
      },
      user("hello again"),
    ];
    await collect(runAgentLoop({ ...base, provider, messages: history, tools: [] }));
    const msgs = nth(provider.requests, 0).messages;
    expect(msgs[2]).toEqual({
      role: "tool",
      callId: "c1",
      name: "echo",
      isError: true,
      content: [{ type: "text", text: "Tool call was interrupted before it returned." }],
    });
    expect(msgs[3]).toEqual(user("hello again"));
  });

  it("records a provider error and ends", async () => {
    const provider = fakeProvider([[{ type: "error", message: "boom" }]]);
    const events = await collect(
      runAgentLoop({ ...base, provider, messages: [user("go")], tools: [] }),
    );
    const end = events.find((e) => e.type === "message_end");
    expect(end?.type === "message_end" && end.message).toMatchObject({
      role: "assistant",
      stop: "error",
      error: "boom",
    });
    expect(events.at(-1)?.type).toBe("agent_end");
  });
});

describe("mendHistory", () => {
  it("leaves valid history alone and drops orphans", () => {
    const valid: TranscriptEntry[] = [user("a")];
    expect(mendHistory(valid)).toEqual({ entries: valid, mended: 0 });
    const orphan: TranscriptEntry = {
      role: "tool",
      callId: "x",
      name: "t",
      content: [],
      isError: false,
    };
    expect(mendHistory([user("a"), orphan])).toEqual({ entries: [user("a")], mended: 1 });
  });
});

function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

describe("beforeModelRequest", () => {
  it("beforeModelRequest can replace history between turns", async () => {
    const echo = tool("echo", true, async () => ({ content: [{ type: "text", text: "ok" }] }));
    const provider = fakeProvider([
      reply([call("c1", "echo", { n: 1 })]),
      reply([{ type: "text", text: "done" }]),
    ]);
    const seen: number[] = [];
    await collect(
      runAgentLoop({
        ...base,
        provider,
        messages: [user("old"), user("older")],
        prompts: [user("go")],
        tools: [echo],
        beforeModelRequest: async (messages) => {
          seen.push(messages.length);
          return seen.length === 2 ? [user("summary"), ...messages.slice(-2)] : undefined;
        },
      }),
    );
    expect(seen).toEqual([3, 5]);
    expect(provider.requests[0]?.messages).toHaveLength(3);
    expect(provider.requests[1]?.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });
});
