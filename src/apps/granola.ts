import { z } from "zod";
import type { App } from "./app.ts";
import { AppError, bearer, type Fetch, jsonOutput, request } from "./http.ts";
import { offset, text, tool } from "./schema.ts";

const NOTES = "https://public-api.granola.ai/v1/notes";
const paging = { cursor: text, page_size: z.number().int().min(1).max(20) };
const FILTERS = ["created_after", "created_before", "folder_id", "space_id"];
const NOTE_FIELDS = ["id", "title", "owner", "created_at", "updated_at", "deleted_at"];

const tools = [
  tool(
    "granola_list_notes",
    "Meeting notes the person can open, narrowed by date, folder or space when given.",
    { ...paging, ...Object.fromEntries(FILTERS.map((f) => [f, text])) },
    { optional: "all" },
  ),
  tool(
    "granola_get_note",
    "One note's details, with a page of its summary and of the person's own notes when it has them.",
    { note_id: text, offset },
    { optional: ["offset"] },
  ),
  tool(
    "granola_get_transcript",
    "A page of what was said in the meeting; send the cursor back for the next page.",
    { note_id: text, ...paging },
    { optional: ["cursor", "page_size"] },
  ),
];

// biome-ignore lint/suspicious/noExplicitAny: Granola replies are loose JSON
type Item = Record<string, any>;

export function granolaKeyValid(key: unknown): key is string {
  return typeof key === "string" && /^grn_[A-Za-z0-9_-]{8,200}$/.test(key);
}

/** Proves a key works by listing one note. */
export async function checkGranolaKey(fetcher: Fetch, key: string): Promise<void> {
  const body = await request<Item>(fetcher, "GET", NOTES, {
    headers: bearer(key),
    params: { page_size: 1 },
    timeoutMs: 15000,
  });
  if (!body || typeof body !== "object" || !Array.isArray(body.notes)) {
    throw new AppError("Granola's reply had no notes in it");
  }
}

const pick = (item: Item) =>
  Object.fromEntries(NOTE_FIELDS.filter((f) => f in item).map((f) => [f, item[f]]));

const page = (data: Item, field: string) => ({
  items: data[field],
  cursor: data.cursor ?? null,
  hasMore: data.hasMore ?? false,
});

export const granola: App = {
  name: "granola",
  tools,
  configured: () => false,
  async run(ctx, name, a) {
    const headers = bearer(await ctx.token());
    const get = (url: string, params: Item) =>
      request<Item>(ctx.fetch, "GET", url, { headers, params });
    if (name === "granola_list_notes") {
      const params: Item = {};
      for (const field of [...FILTERS, "cursor"]) if (field in a) params[field] = a[field];
      params.page_size = a.page_size ?? 10;
      const out = page(await get(NOTES, params), "notes");
      return jsonOutput({ ...out, items: (out.items ?? []).map(pick) });
    }
    const note = String(a.note_id);
    if (!/^[nN][oO][tT]_[A-Za-z0-9]{14}$/.test(note)) {
      throw new AppError("Use a note ID that granola_list_notes gave back");
    }
    const url = `${NOTES}/${note}`;
    if (name === "granola_get_transcript") {
      const params: Item = { page_size: a.page_size ?? 10 };
      if (a.cursor) params.cursor = a.cursor;
      const out = page(await get(`${url}/transcript`, params), "transcript");
      if (JSON.stringify(out).length > 19000) {
        throw new AppError(
          "That many transcript entries is too much at once; ask for a smaller page_size.",
        );
      }
      return jsonOutput(out);
    }
    const data = await get(url, {});
    const out: Item = pick(data);
    out.attendees = (data.attendees ?? []).slice(0, 25);
    const start: number = (a.offset as number | undefined) ?? 0;
    const end = start + 1000;
    const summary: string = data.summary_markdown || data.summary_text || "";
    const own: string | null = data.private_notes_markdown || data.private_notes_text || null;
    out.summary = summary.slice(start, end);
    out.privateNotes = own === null ? null : own.slice(start, end);
    out.nextOffset = end < Math.max(summary.length, (own ?? "").length) ? end : null;
    return jsonOutput(out);
  },
};
