import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CompactionError,
  compact,
  estimate,
  needsCompaction,
  SUMMARY_PREFIX,
} from "../../src/agent/budget.ts";
import type { StreamEvent } from "../../src/agent/providers/types.ts";
import type { ToolSpec } from "../../src/agent/tools.ts";
import { emptyUsage, type TranscriptEntry, textOf } from "../../src/agent/transcript.ts";
import { fakeProvider } from "../support/fakeProvider.ts";

const user = (text: string): TranscriptEntry => ({
  role: "user",
  content: [{ type: "text", text }],
});
const said = (text: string): TranscriptEntry => ({
  role: "assistant",
  content: [{ type: "text", text }],
  model: "m",
  usage: emptyUsage(),
  stop: "end",
});
const calling = (id: string): TranscriptEntry => ({
  role: "assistant",
  content: [{ type: "call", id, name: "read", input: { path: "a.ts" } }],
  model: "m",
  usage: emptyUsage(),
  stop: "tool_calls",
});
const result = (id: string, text: string): TranscriptEntry => ({
  role: "tool",
  callId: id,
  name: "read",
  content: [{ type: "text", text }],
  isError: false,
});

function summaryReply(text: string): StreamEvent[] {
  return [
    { type: "start", model: "m" },
    { type: "text_delta", text },
    {
      type: "end",
      entry: {
        role: "assistant",
        content: [{ type: "text", text }],
        model: "m",
        usage: emptyUsage(),
        stop: "end",
      },
    },
  ];
}

const signal = new AbortController().signal;
const tool = (name: string): ToolSpec => ({
  name,
  description: name,
  input: z.object({}),
  readOnly: true,
  run: async () => ({ content: [] }),
});

describe("estimate", () => {
  it("estimates by characters and tool baseline", () => {
    const t = [user("a".repeat(400)), said("b".repeat(80))];
    const est = estimate(t, [tool("x"), tool("y")], 1000);
    expect(est.tokens).toBe(100 + 20 + 400);
    expect(est.utilization).toBeCloseTo(0.52);
  });

  it("compacts only above the threshold", () => {
    expect(needsCompaction({ tokens: 75, utilization: 0.75 })).toBe(false);
    expect(needsCompaction({ tokens: 76, utilization: 0.76 })).toBe(true);
    expect(needsCompaction({ tokens: 50, utilization: 0.5 }, 0.4)).toBe(true);
  });
});

describe("compact", () => {
  it("keeps a call and its result together at the cut", async () => {
    // 8 entries, keep 4 -> cut at 4, the call; the pair stays whole.
    const t = [
      user("one"),
      said("two"),
      user("three"),
      said("four"),
      calling("c1"),
      result("c1", "contents"),
      said("six"),
      user("seven"),
    ];
    const provider = fakeProvider([summaryReply("short summary")]);
    const out = await compact({ provider, model: "m", transcript: t, signal });
    expect(out.transcript.map((e) => e.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(out.transcript.slice(1)).toEqual(t.slice(4));
    // never a result without its call
    const kinds = out.transcript.map((e) => e.role);
    expect(kinds.indexOf("tool")).toBeGreaterThan(kinds.indexOf("assistant"));
    expect(provider.requests[0]?.tools).toEqual([]);
  });

  it("moves the cut earlier when it would land on a result", async () => {
    const t = [
      user("a"),
      said("b"),
      user("c"),
      calling("c1"),
      result("c1", "r"),
      said("d"),
      user("e"),
      said("f"),
    ];
    // keep 4 -> cut 4 is the result of c1; kept must start at the call (index 3)
    const out = await compact({
      provider: fakeProvider([summaryReply("s")]),
      model: "m",
      transcript: t,
      signal,
    });
    expect(out.transcript.slice(1)).toEqual(t.slice(3));
  });

  it("summary carries the current request word for word", async () => {
    const request =
      "Please migrate every handler in src/routes to the new router, keeping the tests green.";
    const t: TranscriptEntry[] = [user(request)];
    for (let i = 0; i < 5; i++) t.push(calling(`c${i}`), result(`c${i}`, `file ${i}`));
    const out = await compact({
      provider: fakeProvider([summaryReply("Worked through several files.")]),
      model: "m",
      transcript: t,
      currentRequest: request,
      signal,
    });
    const first = out.transcript[0];
    expect(first?.role).toBe("user");
    const text = textOf(first?.content ?? []);
    expect(text.startsWith(SUMMARY_PREFIX)).toBe(true);
    expect(text).toContain("The exact request this run is handling:");
    expect(text.endsWith(request)).toBe(true);
    expect(out.summary).toBe(text);
  });

  it("incremental compaction summarises the old summary plus new entries", async () => {
    const old = `${SUMMARY_PREFIX}EARLIER FACTS\n\nThe exact request this run is handling:\nold ask`;
    const t: TranscriptEntry[] = [
      user(old),
      said("kept-1"),
      user("n1"),
      said("n2"),
      user("n3"),
      said("n4"),
      user("n5"),
      said("n6"),
    ];
    const provider = fakeProvider([summaryReply("merged summary")]);
    const out = await compact({
      provider,
      model: "m",
      transcript: t,
      currentRequest: "new ask",
      signal,
    });
    const sent = textOf(provider.requests[0]?.messages[0]?.content ?? []);
    expect(sent).toContain("EARLIER FACTS");
    expect(sent).toContain("kept-1");
    expect(sent).not.toContain("old ask");
    const summaries = out.transcript.filter(
      (e) => e.role === "user" && textOf(e.content).startsWith(SUMMARY_PREFIX),
    );
    expect(summaries).toHaveLength(1);
    expect(textOf(out.transcript[0]?.content ?? [])).toContain("merged summary");
    expect(textOf(out.transcript[0]?.content ?? [])).not.toContain("EARLIER FACTS");
  });

  it("summarises thinking as text and never replays it", async () => {
    const t: TranscriptEntry[] = [
      user("q"),
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "secret musings", signature: "sig" },
          { type: "redacted_thinking", data: "OPAQUE" },
          { type: "text", text: "answer" },
        ],
        model: "m",
        usage: emptyUsage(),
        stop: "end",
      },
      user("a"),
      said("b"),
      user("c"),
      said("d"),
      user("e"),
      said("f"),
    ];
    const provider = fakeProvider([summaryReply("s")]);
    const out = await compact({ provider, model: "m", transcript: t, signal });
    const sent = provider.requests[0]?.messages ?? [];
    expect(sent.every((m) => m.content.every((b) => b.type === "text"))).toBe(true);
    expect(textOf(sent[0]?.content ?? [])).toContain("secret musings");
    expect(JSON.stringify(out.transcript)).not.toContain("OPAQUE");
  });

  it("throws with the original transcript when the summary call fails", async () => {
    const t = [
      user("a"),
      said("b"),
      user("c"),
      said("d"),
      user("e"),
      said("f"),
      user("g"),
      said("h"),
    ];
    const provider = fakeProvider([[{ type: "error", message: "boom" }]]);
    const err = await compact({ provider, model: "m", transcript: t, signal }).catch((e) => e);
    expect(err).toBeInstanceOf(CompactionError);
    expect((err as CompactionError).transcript).toBe(t);
  });

  it("leaves a short transcript alone without calling the model", async () => {
    const t = [user("a"), said("b")];
    const provider = fakeProvider([]);
    const out = await compact({ provider, model: "m", transcript: t, signal });
    expect(out.transcript).toEqual(t);
    expect(provider.requests).toHaveLength(0);
  });

  it("short transcript ending in a result is left whole", async () => {
    const t = [user("a"), calling("c1"), result("c1", "r")];
    const provider = fakeProvider([]);
    const out = await compact({ provider, model: "m", transcript: t, signal });
    expect(out.transcript).toEqual(t);
    expect(provider.requests).toHaveLength(0);
  });

  it("keepRecent larger than the transcript drops nothing", async () => {
    const t = [user("a"), said("b"), user("c"), said("d"), user("e")];
    const provider = fakeProvider([]);
    const out = await compact({ provider, model: "m", transcript: t, keepRecent: 50, signal });
    expect(out.transcript).toEqual(t);
    expect(provider.requests).toHaveLength(0);
  });
});
