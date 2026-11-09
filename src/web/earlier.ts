/**
 * Between two requests a hosted deployment forgets every session, so the page includes the
 * chat so far whenever it asks for a run: at most MAX_EARLIER messages, MAX_EARLIER_TEXT
 * characters apiece. They wait in `run_context`, keyed by the inbox row, and the run opens a
 * brand-new session that already contains them.
 */

import { HttpError } from "../accounts/http.ts";
import { emptyUsage, type TranscriptEntry } from "../agent/transcript.ts";
import type { Store } from "../store/store.ts";

export const MAX_EARLIER = 20;
export const MAX_EARLIER_TEXT = 4000;

export interface Earlier {
  role: "user" | "assistant";
  content: string;
}

const REFUSED = `Send no more than ${MAX_EARLIER} earlier messages, each with a role and at most ${MAX_EARLIER_TEXT} characters`;

/** The checked earlier messages from a request body; none when it sent none. */
export function parseEarlier(value: unknown): Earlier[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_EARLIER) throw new HttpError(400, REFUSED);
  return value.map((message: unknown) => {
    const fields = message as Record<string, unknown>;
    if (
      typeof message !== "object" ||
      message === null ||
      Object.keys(message).sort().join(",") !== "content,role" ||
      (fields.role !== "user" && fields.role !== "assistant") ||
      typeof fields.content !== "string" ||
      fields.content.length > MAX_EARLIER_TEXT
    ) {
      throw new HttpError(400, REFUSED);
    }
    return { role: fields.role, content: fields.content };
  });
}

/** Keeps the earlier messages beside the queued message until its run starts. */
export async function saveEarlier(store: Store, inbox: bigint, earlier: Earlier[]): Promise<void> {
  const { db, instance } = store.ctx;
  await db.run("INSERT OR REPLACE INTO run_context(instance,inbox,conversation) VALUES(?,?,?)", [
    instance,
    inbox,
    JSON.stringify(earlier),
  ]);
}

/** Reads and deletes, in one statement, what was stored for this inbox row. */
export async function takeEarlier(store: Store, inbox: bigint): Promise<Earlier[]> {
  const { db, instance } = store.ctx;
  const rows = await db.query(
    "DELETE FROM run_context WHERE instance=? AND inbox=? RETURNING conversation",
    [instance, inbox],
  );
  if (!rows[0]) return [];
  try {
    return parseEarlier(JSON.parse(String(rows[0].conversation)));
  } catch {
    return [];
  }
}

/** Transcript entries for a session that starts with these messages. */
export function toEntries(earlier: Earlier[]): TranscriptEntry[] {
  return earlier.map(
    (message): TranscriptEntry =>
      message.role === "user"
        ? { role: "user", content: [{ type: "text", text: message.content }] }
        : {
            role: "assistant",
            content: [{ type: "text", text: message.content }],
            model: "",
            usage: emptyUsage(),
            stop: "end",
          },
  );
}
