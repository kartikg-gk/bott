import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StreamEvent } from "../../src/agent/providers/types.ts";
import { AgentSession, type SessionEvent, type SessionOptions } from "../../src/agent/session.ts";
import { jsonlSessionStore, memorySessionStore } from "../../src/agent/sessionStore.ts";
import { THINKING_BUDGETS } from "../../src/agent/thinking.ts";
import type { ToolSpec } from "../../src/agent/tools.ts";
import {
  emptyUsage,
  type ModelEntry,
  type TranscriptEntry,
  textOf,
} from "../../src/agent/transcript.ts";
import { type FakeProvider, fakeProvider } from "../support/fakeProvider.ts";

function reply(blocks: ModelEntry["content"]): StreamEvent[] {
  const events: StreamEvent[] = [{ type: "start", model: "m" }];
  for (const b of blocks) if (b.type === "text") events.push({ type: "text_delta", text: b.text });
  const usage = { ...emptyUsage(), input: 10, output: 5 };
  events.push({
    type: "end",
    entry: { role: "assistant", content: blocks, model: "m", usage, stop: "end" },
  });
  return events;
}
const text = (t: string) => ({ type: "text", text: t }) as const;
const call = (id: string, name: string, input: unknown = {}) =>
  ({ type: "call", id, name, input }) as const;
const user = (t: string): TranscriptEntry => ({ role: "user", content: [text(t)] });

function open(id: string, provider: FakeProvider, extra: Partial<SessionOptions> = {}) {
  return AgentSession.open({
    id,
    providers: { fake: provider },
    provider: "fake",
    model: "m",
    system: "",
    ...extra,
  });
}

/** Collects events until `agent_settled`, letting `on` react to each one. */
async function untilSettled(
  session: AgentSession,
  on: (e: SessionEvent) => void | Promise<void> = () => {},
): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for await (const e of session.events()) {
    seen.push(e);
    await on(e);
    if (e.type === "agent_settled") break;
  }
  return seen;
}

function writeTool(ran: string[]): ToolSpec {
  return {
    name: "Write",
    description: "write",
    input: z.object({}),
    readOnly: false,
    async run() {
      ran.push("Write");
      return { content: [text("written")] };
    },
  };
}

describe("AgentSession", () => {
  it("prompt streams text and settles", async () => {
    const provider = fakeProvider([reply([text("hello")])]);
    const session = await open("s1", provider, { system: "sys" });
    const res = await session.request("prompt", { message: "hi" });
    expect(res).toMatchObject({ type: "response", command: "prompt", success: true });
    const seen = await untilSettled(session);
    const order = [
      "agent_start",
      "message_start",
      "message_update",
      "message_end",
      "agent_end",
      "agent_settled",
    ];
    let at = -1;
    for (const kind of order) {
      const next = seen.findIndex((e, i) => i > at && e.type === kind);
      expect(next, kind).toBeGreaterThan(at);
      at = next;
    }
    const update = seen.find((e) => e.type === "message_update");
    expect(update).toMatchObject({
      delta: { type: "text_delta", text: "hello" },
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    });
    const ends = seen.filter((e) => e.type === "message_end");
    expect(ends.at(-1)).toMatchObject({ message: { role: "assistant" } });
    expect(seen.at(-1)).toMatchObject({ outcome: "completed", state: { isStreaming: false } });
    expect(provider.requests[0]?.system).toBe("sys");
    expect(provider.requests[0]?.thinking).toBeUndefined();
  });

  it("asks the model to think with the budget its thinking level names", async () => {
    const provider = fakeProvider([reply([text("a")]), reply([text("b")])]);
    const deep = await open("s1t", provider, { thinking: "high" });
    await deep.request("prompt", { message: "hi" });
    await untilSettled(deep);
    expect(provider.requests[0]?.thinking).toEqual({ budgetTokens: THINKING_BUDGETS.high });
    const off = await open("s1u", provider, { thinking: "off" });
    await off.request("prompt", { message: "hi" });
    await untilSettled(off);
    expect(provider.requests[1]?.thinking).toBeUndefined();
  });

  it("get_state reports model, busy flag and message count", async () => {
    const provider = fakeProvider([reply([text("ok")])]);
    const session = await open("s2", provider);
    await session.request("prompt", { message: "hi" });
    const busy = await session.request("get_state");
    expect(busy).toMatchObject({
      success: true,
      data: { isStreaming: true, operation: "prompt", sessionId: "s2" },
    });
    expect((await session.request("prompt", { message: "again" })).success).toBe(false);
    await untilSettled(session);
    const idle = await session.request("get_state");
    expect(idle.data).toMatchObject({
      model: { provider: "fake", id: "m" },
      isStreaming: false,
      operation: null,
      messageCount: 2,
    });
    const stats = await session.request("get_session_stats");
    expect(stats.data).toMatchObject({ totalMessages: 2, tokens: { input: 10, output: 5 } });
    expect((await session.request("nonsense")).success).toBe(false);

    const other = fakeProvider([]);
    const s2 = await AgentSession.open({
      id: "s3",
      providers: { fake: provider, other },
      provider: "fake",
      model: "m",
      system: "",
    });
    expect((await s2.request("set_model", { provider: "other", model: "x" })).success).toBe(true);
    expect((await s2.request("get_state")).data).toMatchObject({
      model: { provider: "other", id: "x" },
    });
    expect((await s2.request("set_model", { provider: "none", model: "x" })).success).toBe(false);
  });

  it("approval round trip", async () => {
    const ran: string[] = [];
    const provider = fakeProvider([reply([call("c1", "Write")]), reply([text("done")])]);
    const session = await open("s4", provider, { tools: [writeTool(ran)], policy: "ask" });
    await session.request("prompt", { message: "write it" });
    const kinds: string[] = [];
    await untilSettled(session, async (e) => {
      kinds.push(e.type);
      if (e.type === "approval_requested") {
        expect(e.call).toMatchObject({ id: "c1", name: "Write" });
        expect(e).toMatchObject({ approvalId: e.id, tool: "Write", preview: "{}" });
        expect(e.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(e.expiresAt).toBeGreaterThan(Date.now() / 1000);
        expect(ran).toEqual([]);
        kinds.push("approve");
        await session.request("respond_to_approval", { approvalId: e.approvalId, allow: true });
      }
      if (e.type === "approval_resolved") expect(e).toMatchObject({ allow: true });
      if (e.type === "tool_execution_end") kinds.push(`ran:${ran.join()}`);
    });
    const relevant = kinds.filter((k) => k.startsWith("approv") || k.startsWith("ran:"));
    expect(relevant).toEqual(["approval_requested", "approve", "approval_resolved", "ran:Write"]);
  });

  it("host tool call is answered by the server", async () => {
    const provider = fakeProvider([
      reply([call("h1", "send_photo", { url: "x" })]),
      reply([text("sent")]),
    ]);
    const asked: unknown[] = [];
    const session = await open("s5", provider, {
      hostTools: [
        {
          name: "send_photo",
          description: "send",
          input: z.object({ url: z.string() }),
          readOnly: false,
        },
      ],
      answerHostTool: async (c) => {
        asked.push(c);
        return { content: [text("photo sent")] };
      },
      policy: "auto",
    });
    await session.request("prompt", { message: "send" });
    const seen = await untilSettled(session);
    const hostCall = seen.find((e) => e.type === "host_tool_call");
    expect(hostCall).toMatchObject({ callId: "h1", name: "send_photo", arguments: { url: "x" } });
    expect(asked).toEqual([{ id: "h1", name: "send_photo", input: { url: "x" } }]);
    const result = provider.requests[1]?.messages.at(-1);
    expect(result).toMatchObject({ role: "tool", content: [text("photo sent")] });
  });

  it("an unattended session refuses a reviewed tool at once, even under auto", async () => {
    const provider = fakeProvider([
      reply([call("h1", "send_mail", { to: "x" })]),
      reply([text("could not send")]),
    ]);
    const asked: unknown[] = [];
    const session = await open("s5b", provider, {
      hostTools: [
        {
          name: "send_mail",
          description: "send",
          input: z.object({ to: z.string() }),
          readOnly: false,
          review: true,
        },
      ],
      answerHostTool: async (c) => {
        asked.push(c);
        return { content: [text("sent")] };
      },
      policy: "auto",
      unattended: true,
    });
    await session.request("prompt", { message: "send" });
    const seen = await untilSettled(session);
    expect(seen.some((e) => e.type === "approval_requested")).toBe(false);
    expect(asked).toEqual([]);
    const result = provider.requests[1]?.messages.at(-1);
    expect(JSON.stringify(result)).toContain("send_mail needs approval, and nobody can give it");
  });

  it("a call the guard says steers later runs asks, even under auto", async () => {
    const provider = fakeProvider([
      reply([call("w1", "Write", { file_path: "SKILL.md" })]),
      reply([text("asked")]),
    ]);
    const ran: string[] = [];
    const session = await open("s5c", provider, {
      tools: [{ ...writeTool(ran), input: z.object({ file_path: z.string() }) }],
      policy: "auto",
      steers: (c) => c.name === "Write",
    });
    await session.request("prompt", { message: "save" });
    const seen = await untilSettled(session, async (e) => {
      if (e.type === "approval_requested") {
        await session.request("respond_to_approval", { approvalId: e.id, allow: false });
      }
    });
    expect(seen.some((e) => e.type === "approval_requested")).toBe(true);
    expect(ran).toEqual([]);
  });

  it("an unattended session under ask still runs commands that only look", async () => {
    const provider = fakeProvider([
      reply([call("b1", "Bash", { command: "ls -la" })]),
      reply([text("listed")]),
    ]);
    const ran: string[] = [];
    const shell: ToolSpec = {
      name: "Bash",
      description: "shell",
      input: z.object({ command: z.string() }),
      readOnly: false,
      async run() {
        ran.push("Bash");
        return { content: [text("a b")] };
      },
    };
    const session = await open("s5d", provider, {
      tools: [shell],
      policy: "ask",
      unattended: true,
      windowsShell: false,
    });
    await session.request("prompt", { message: "look" });
    await untilSettled(session);
    expect(ran).toEqual(["Bash"]);
  });

  it("abort kills the running command and settles", async () => {
    let killed = false;
    const slow: ToolSpec = {
      name: "Bash",
      description: "shell",
      input: z.object({}),
      readOnly: false,
      run: (_input, { signal }) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            killed = true;
            resolve({ content: [text("killed")], isError: true });
          });
          started();
        }),
    };
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = fakeProvider([reply([call("b1", "Bash")])]);
    const session = await open("s6", provider, { tools: [slow], policy: "auto" });
    await session.request("prompt", { message: "loop forever" });
    const seen = await untilSettled(session, async (e) => {
      if (e.type === "tool_execution_start") {
        expect(e).toMatchObject({ toolCallId: "b1", toolName: "Bash" });
        // Stop once the command is really running, whatever the approval check awaits first.
        await running;
        expect((await session.request("abort")).success).toBe(true);
      }
    });
    expect(killed).toBe(true);
    expect(seen.at(-1)).toMatchObject({ type: "agent_settled", outcome: "cancelled" });
    expect((await session.request("get_state")).data).toMatchObject({ isStreaming: false });
  });

  it("abort settles even when the running tool never notices it", async () => {
    let started = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const deaf: ToolSpec = {
      name: "Bash",
      description: "shell",
      input: z.object({}),
      readOnly: false,
      run: () =>
        new Promise(() => {
          started();
        }),
    };
    const provider = fakeProvider([reply([call("d1", "Bash")])]);
    const session = await open("s6d", provider, { tools: [deaf], policy: "auto" });
    await session.request("prompt", { message: "hang" });
    const seen = await untilSettled(session, async (e) => {
      if (e.type === "tool_execution_start") {
        await running;
        await session.request("abort");
      }
    });
    expect(seen.find((e) => e.type === "tool_execution_end")).toMatchObject({ isError: true });
    expect(seen.at(-1)).toMatchObject({ type: "agent_settled", outcome: "cancelled" });
  });

  it("abort while waiting for approval denies the call", async () => {
    const ran: string[] = [];
    const provider = fakeProvider([reply([call("c1", "Write")])]);
    const session = await open("s6b", provider, { tools: [writeTool(ran)], policy: "ask" });
    await session.request("prompt", { message: "write" });
    const seen = await untilSettled(session, async (e) => {
      if (e.type === "approval_requested") await session.request("abort");
    });
    expect(seen.find((e) => e.type === "approval_resolved")).toMatchObject({ allow: false });
    expect(ran).toEqual([]);
  });

  it("compact command shrinks the transcript and keeps the request", async () => {
    const history: TranscriptEntry[] = [];
    for (let i = 0; i < 10; i++) {
      history.push(user(`question ${i}`));
      history.push({
        role: "assistant",
        content: [text(`answer ${i}`)],
        model: "m",
        usage: emptyUsage(),
        stop: "end",
      });
    }
    history.push(user("fix the login bug"));
    const store = memorySessionStore({ s7: history });
    const provider = fakeProvider([reply([text("They talked.")])]);
    const session = await open("s7", provider, { store });
    const seen: SessionEvent[] = [];
    const reader = (async () => {
      for await (const e of session.events()) {
        seen.push(e);
        if (e.type === "compaction_end") break;
      }
    })();
    const res = await session.request("compact");
    await reader;
    expect(res.success).toBe(true);
    const state = (await session.request("get_state")).data as { messageCount: number };
    expect(state.messageCount).toBeLessThan(history.length);
    const head = (await store.load("s7"))[0];
    expect(JSON.stringify(head)).toContain("They talked.");
    expect(JSON.stringify(head)).toContain("fix the login bug");
    expect(seen.map((e) => e.type)).toEqual(["compaction_start", "compaction_end"]);
  });

  it("compacts automatically before a request and survives a failed summary", async () => {
    const big = "x".repeat(4000);
    const history: TranscriptEntry[] = [];
    for (let i = 0; i < 8; i++) history.push(user(`${big} ${i}`));
    const provider = fakeProvider([[{ type: "error", message: "boom" }], reply([text("fine")])]);
    const session = await open("s8", provider, {
      store: memorySessionStore({ s8: history }),
      contextWindow: 1000,
    });
    await session.request("prompt", { message: "go on" });
    const seen = await untilSettled(session);
    const end = seen.find((e) => e.type === "compaction_end");
    expect(end).toMatchObject({ error: expect.stringContaining("boom") });
    expect(seen.at(-1)).toMatchObject({ outcome: "completed" });
    expect(provider.requests[1]?.messages.length).toBe(9);
  });

  it("compacts partway through a long single turn", async () => {
    const big: ToolSpec = {
      name: "Read",
      description: "read",
      input: z.object({}),
      readOnly: true,
      async run() {
        return { content: [text("y".repeat(2000))] };
      },
    };
    const provider = fakeProvider([
      reply([call("r1", "Read")]),
      reply([call("r2", "Read")]),
      reply([text("Read two files.")]),
      reply([text("all done")]),
    ]);
    const session = await open("s10", provider, { tools: [big], contextWindow: 1000 });
    await session.request("prompt", { message: "audit the repo exactly" });
    const seen = await untilSettled(session);
    expect(seen.filter((e) => e.type === "compaction_start")).toHaveLength(1);
    const startAt = seen.findIndex((e) => e.type === "compaction_start");
    const toolEnds = seen.filter((e, i) => i < startAt && e.type === "tool_execution_end");
    expect(toolEnds).toHaveLength(2);
    expect(provider.requests[2]?.tools).toEqual([]);
    const head = JSON.stringify(provider.requests[3]?.messages[0]);
    expect(head).toContain("Read two files.");
    expect(head).toContain("audit the repo exactly");
    expect(seen.at(-1)).toMatchObject({ outcome: "completed" });
  });

  it("appends cleanly after a torn final line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"));
    writeFileSync(
      join(dir, "t.jsonl"),
      `${JSON.stringify({ entry: user("a") })}
{"entry": {"ro`,
    );
    const store = jsonlSessionStore(dir);
    await store.append("t", [user("b")]);
    const loaded = await store.load("t");
    expect(loaded.map((e) => textOf(e.content))).toEqual(["a", "b"]);
  });

  it("transcript persists and reloads from the jsonl store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"));
    const provider = fakeProvider([reply([text("first")])]);
    const s = await open("p1", provider, { store: jsonlSessionStore(dir) });
    await s.request("prompt", { message: "remember me" });
    await untilSettled(s);
    const reloaded = await jsonlSessionStore(dir).load("p1");
    expect(reloaded.map((e) => e.role)).toEqual(["user", "assistant"]);
    const again = await open("p1", provider, { store: jsonlSessionStore(dir) });
    expect((await again.request("get_state")).data).toMatchObject({ messageCount: 2 });

    const file = join(dir, "torn.jsonl");
    writeFileSync(file, `${JSON.stringify({ entry: user("a") })}\n{"entry": {"ro`);
    expect(await jsonlSessionStore(dir).load("torn")).toHaveLength(1);
    writeFileSync(file, `not json\n${JSON.stringify({ entry: user("a") })}\n`);
    await expect(jsonlSessionStore(dir).load("torn")).rejects.toThrow(/line 1/);
    expect(await jsonlSessionStore(dir).load("absent")).toEqual([]);
  });

  it("steer and follow_up messages reach the model", async () => {
    const provider = fakeProvider([reply([text("one")]), reply([text("two")])]);
    const session = await open("s9", provider);
    await session.request("prompt", { message: "start" });
    await session.request("follow_up", { message: "and then" });
    await untilSettled(session);
    expect(JSON.stringify(provider.requests[1]?.messages.at(-1))).toContain("and then");
    expect((await session.request("steer", {})).success).toBe(false);
  });

  it("steer and follow_up with requireActive are refused when idle", async () => {
    const provider = fakeProvider([reply([text("one")])]);
    const session = await open("s10", provider);
    for (const command of ["steer", "follow_up"]) {
      const res = await session.request(command, { message: "late", requireActive: true });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/no active run/);
    }
    expect((await session.request("get_state")).data).toMatchObject({ pendingMessageCount: 0 });
    await session.request("prompt", { message: "start" });
    await untilSettled(session);
    expect(JSON.stringify(provider.requests[0]?.messages)).not.toContain("late");
  });

  it("replies echo the request id and are emitted on the stream", async () => {
    const session = await open("s11", fakeProvider([]));
    const res = await session.request("get_state", { id: "req-1" });
    expect(res).toMatchObject({
      type: "response",
      id: "req-1",
      command: "get_state",
      success: true,
    });
    const bad = await session.request("nonsense", { id: "req-2" });
    expect(bad).toMatchObject({ id: "req-2", success: false, error: expect.any(String) });
    const seen: SessionEvent[] = [];
    for await (const e of session.events()) {
      seen.push(e);
      if (seen.length === 2) break;
    }
    expect(seen.map((e) => (e as { id?: string }).id)).toEqual(["req-1", "req-2"]);
  });

  it("respond_to_approval with an unknown approvalId is refused", async () => {
    const session = await open("s12", fakeProvider([]));
    const res = await session.request("respond_to_approval", {
      id: "req",
      approvalId: "missing",
      allow: true,
    });
    expect(res).toMatchObject({ id: "req", success: false });
    expect(res.error).toContain("missing");
  });
});
