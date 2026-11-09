import { z } from "zod";
import type { App } from "./app.ts";
import { AppError, type Fetch, jsonOutput, request } from "./http.ts";
import { offset, text, tool } from "./schema.ts";
import { serviceId } from "./tinyfish.ts";

const CALLS = "https://api.bland.ai/v1/calls";
/** Characters of a transcript handed over per read. */
const SLICE = 2200;
/** Every call opens by saying who is speaking. */
const OPENING = "Begin the call by saying that you are an AI assistant. ";

const tools = [
  tool(
    "bland_call",
    "Places a phone call made by an AI voice to an E.164 number, working on the task given. " +
      "The voice says it is an AI, and nothing is recorded.",
    {
      phone_number: text,
      task: text,
      duration_minutes: z.number().int().min(1).max(15),
    },
    { write: true, review: true },
  ),
  tool(
    "bland_get_call",
    "How a call went: its status, a summary and a page of its transcript from offset.",
    { call_id: text, offset },
    { optional: ["offset"] },
  ),
];

// biome-ignore lint/suspicious/noExplicitAny: Bland replies are loose JSON
type Item = Record<string, any>;

const CALL_FIELDS = [
  "call_id",
  "status",
  "completed",
  "call_length",
  "answered_by",
  "started_at",
  "end_at",
];

/** Proves a key works by listing one call. */
export async function checkBlandKey(fetcher: Fetch, key: string): Promise<void> {
  const body = await request<Item>(fetcher, "GET", CALLS, {
    headers: { authorization: key },
    params: { limit: 1 },
    timeoutMs: 15000,
  });
  if (!body || !Array.isArray(body.calls)) throw new AppError("Bland AI sent back no call list");
}

/** One call's outcome, with its summary and a slice of its transcript from `start`. */
export async function blandCall(
  fetcher: Fetch,
  key: string,
  id: unknown,
  start = 0,
): Promise<Item> {
  const data =
    (await request<Item>(fetcher, "GET", `${CALLS}/${serviceId(id)}`, {
      headers: { authorization: key },
    })) ?? {};
  const out: Item = Object.fromEntries(
    CALL_FIELDS.filter((f) => f in data).map((f) => [f, data[f]]),
  );
  const said = String(data.concatenated_transcript ?? "");
  const end = start + SLICE;
  out.summary = String(data.summary ?? "").slice(0, 900);
  out.transcript = said.slice(start, end);
  out.nextOffset = end < said.length ? end : null;
  return out;
}

export const bland: App = {
  name: "bland",
  tools,
  configured: () => false,
  async run(ctx, name, a) {
    const key = await ctx.token();
    if (name === "bland_get_call") {
      const start = typeof a.offset === "number" ? a.offset : 0;
      return jsonOutput(await blandCall(ctx.fetch, key, a.call_id, start));
    }
    if (name !== "bland_call") throw new AppError("Unknown Bland AI tool");
    const number = a.phone_number;
    if (typeof number !== "string" || !/^\+[1-9][0-9]{6,14}$/.test(number)) {
      throw new AppError("Give the number in E.164 form, such as +14155550100");
    }
    const minutes = a.duration_minutes as number;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 15) {
      throw new AppError("Give duration_minutes from 1 to 15");
    }
    const data = await request<Item>(ctx.fetch, "POST", CALLS, {
      headers: { authorization: key },
      json: {
        phone_number: number,
        task: OPENING + String(a.task),
        max_duration: minutes,
        record: false,
      },
    });
    if (data?.status === "error" || typeof data?.call_id !== "string" || !data.call_id) {
      throw new AppError(
        "Bland AI did not confirm the call; look at its call list before calling again",
      );
    }
    return jsonOutput({ call_id: data.call_id, status: data.status ?? null });
  },
};
