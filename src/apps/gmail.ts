import { z } from "zod";
import { type App, type AppContext, envSet } from "./app.ts";
import { MAX_DOCUMENT_BYTES, MAX_GMAIL_RESPONSE } from "./documents.ts";
import { AppError, boundedBytes, HttpError, jsonOutput, request, send } from "./http.ts";
import { offset, text, textList, tool } from "./schema.ts";

export const GMAIL_CLIENT_ID = "BOTT_GMAIL_CLIENT_ID";
export const GMAIL_CLIENT_SECRET = "BOTT_GMAIL_CLIENT_SECRET";
export const GMAIL_REFRESH_TOKEN = "BOTT_GMAIL_REFRESH_TOKEN";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const mail = { to: text, subject: text, body: z.string() };

const tools = [
  tool("gmail_search", "Search the mailbox in Gmail and get message IDs back.", { query: text }),
  tool("gmail_read", "Read a Gmail message and list its attachments with their part IDs.", {
    id: text,
  }),
  tool(
    "gmail_read_thread",
    "Read five messages at a time from a Gmail thread, passing the nextOffset returned.",
    { id: text, offset },
    { optional: ["offset"] },
  ),
  tool(
    "gmail_read_attachment",
    "Read an attachment using its part ID from a message. " +
      "Use base64 for binary content; pass nextOffset to read on.",
    { message_id: text, part: text, offset, format: z.enum(["text", "base64"]) },
    { optional: ["offset", "format"] },
  ),
  tool(
    "gmail_extract_attachment",
    "Extract a page of a PDF, PNG or JPEG Gmail attachment on the server. " +
      "Use a message's part ID and pass nextOffset to continue.",
    { message_id: text, part: text, page: z.number().int().min(1).max(100), offset },
    { optional: ["page", "offset"] },
  ),
  tool("gmail_list_labels", "Show Gmail labels with their IDs.", {}),
  tool(
    "gmail_modify_labels",
    "Put existing labels on, or take them off, a Gmail message or thread.",
    { id: text, target: z.enum(["message", "thread"]), add: textList, remove: textList },
    { optional: ["target", "add", "remove"], write: true, review: true },
  ),
  tool(
    "gmail_send",
    "Send a plain-text Gmail message, only when the task plainly asks for it to be sent.",
    mail,
    { write: true, review: true },
  ),
  tool(
    "gmail_create_draft",
    "Save a Gmail draft for review; drafts are never sent from here.",
    mail,
    { write: true },
  ),
];

// biome-ignore lint/suspicious/noExplicitAny: Gmail replies are loose JSON
type Item = Record<string, any>;

export function gmailId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new AppError("Invalid Gmail ID");
  }
  return value;
}

/** Every MIME part with its path: the root is "0", its children "0.0", "0.1" and so on. */
export function* mimeParts(payload: Item, path = "0"): Generator<[string, Item]> {
  yield [path, payload];
  const parts: Item[] = Array.isArray(payload.parts) ? payload.parts : [];
  for (const [i, child] of parts.entries()) yield* mimeParts(child, `${path}.${i}`);
}

export function isAttachment(part: Item): boolean {
  return Boolean(part.filename || part.body?.attachmentId);
}

export const decode = (data: string): Buffer => Buffer.from(data, "base64url");

const WANTED = new Set(["from", "to", "subject", "date"]);

/** A message as the bot reads it: wanted headers, plain text and attachment parts. */
export function mailMessage(data: Item, bodyLimit = 8000): Item {
  const payload: Item = data.payload ?? {};
  const textParts: string[] = [];
  const attachments: Item[] = [];
  for (const [path, part] of mimeParts(payload)) {
    const body: Item = part.body ?? {};
    if (isAttachment(part)) {
      attachments.push({
        part: path,
        filename: part.filename ?? "",
        mimeType: part.mimeType ?? null,
        size: body.size ?? null,
      });
    } else if (body.data && String(part.mimeType ?? "").startsWith("text/plain")) {
      textParts.push(decode(body.data).toString("utf8"));
    }
  }
  const headers: Record<string, string> = {};
  for (const header of payload.headers ?? []) {
    if (WANTED.has(String(header.name).toLowerCase())) headers[header.name] = header.value;
  }
  return {
    id: data.id ?? null,
    threadId: data.threadId ?? null,
    headers,
    text: (textParts.join("") || data.snippet || "").slice(0, bodyLimit),
    attachments,
  };
}

function headerWord(value: string): string {
  if (/[\r\n]/.test(value)) throw new AppError("Keep the recipient and subject on one line");
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?utf-8?B?${Buffer.from(value).toString("base64")}?=`;
}

/** A plain-text message, encoded the way the Gmail API takes it. */
export function rawMessage(args: { to: string; subject: string; body: string }): string {
  const body = Buffer.from(args.body)
    .toString("base64")
    .replace(/.{76}(?=.)/g, "$&\r\n");
  const lines = [
    `To: ${headerWord(args.to)}`,
    `Subject: ${headerWord(args.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

/** A bearer header: the account's connection, or the server's own refresh token. */
export async function gmailHeaders(ctx: AppContext): Promise<Record<string, string>> {
  if (ctx.accounts) return { authorization: `Bearer ${await ctx.token()}` };
  const env = ctx.env;
  const reply = await request<Item>(ctx.fetch, "POST", GOOGLE_TOKEN_URL, {
    form: {
      client_id: String(env[GMAIL_CLIENT_ID]),
      client_secret: String(env[GMAIL_CLIENT_SECRET]),
      refresh_token: String(env[GMAIL_REFRESH_TOKEN]),
      grant_type: "refresh_token",
    },
  });
  if (typeof reply?.access_token !== "string") throw new AppError("Gmail did not renew access");
  return { authorization: `Bearer ${reply.access_token}` };
}

/** Finds an attachment part and its raw bytes. */
export async function attachmentData(
  ctx: AppContext,
  headers: Record<string, string>,
  messageId: unknown,
  partPath: unknown,
  load: (path: string) => Promise<Item> = (path) =>
    request(ctx.fetch, "GET", GMAIL_API + path, { headers }),
  beforeDownload: (part: Item) => void = () => {},
): Promise<{ part: Item; raw: Buffer }> {
  const id = gmailId(messageId);
  const data = await load(`/messages/${id}?format=full`);
  let selected: Item | undefined;
  for (const [path, part] of mimeParts(data.payload ?? {})) {
    if (path === partPath && isAttachment(part)) selected = part;
  }
  if (!selected) throw new AppError("That attachment is not part of the message");
  beforeDownload(selected);
  let body: Item = selected.body ?? {};
  if (body.attachmentId) {
    body = await load(`/messages/${id}/attachments/${gmailId(body.attachmentId)}`);
  }
  return { part: selected, raw: decode(body.data ?? "") };
}

async function readAttachment(ctx: AppContext, headers: Record<string, string>, a: Item) {
  const { part, raw } = await attachmentData(ctx, headers, a.message_id, a.part);
  const start: number = a.offset ?? 0;
  const format: string = a.format ?? "text";
  let content: string;
  let end: number;
  let total: number;
  if (format === "base64") {
    end = start + 9000;
    content = raw.subarray(start, end).toString("base64");
    total = raw.length;
  } else {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new AppError("This attachment holds binary data; read it with format base64.");
    }
    end = start + 2500;
    content = decoded.slice(start, end);
    total = decoded.length;
  }
  return jsonOutput({
    filename: part.filename ?? null,
    mimeType: part.mimeType ?? null,
    size: raw.length,
    format,
    content,
    nextOffset: end < total ? end : null,
  });
}

/** Extracts a page of text from an attachment, downloading no more than the size limits. */
async function extractAttachment(ctx: AppContext, headers: Record<string, string>, a: Item) {
  const documents = ctx.services.documents;
  if (!documents) throw new AppError("Document extraction is not available on this server");
  const load = async (path: string) => {
    const reply = await send(ctx.fetch, "GET", GMAIL_API + path, { headers });
    const body = await boundedBytes(
      reply,
      MAX_GMAIL_RESPONSE,
      "The attachment exceeds the server extraction size limit",
    );
    return JSON.parse(Buffer.from(body).toString("utf8")) as Item;
  };
  const { part, raw } = await attachmentData(ctx, headers, a.message_id, a.part, load, (found) => {
    if (Number(found.body?.size ?? 0) > MAX_DOCUMENT_BYTES) {
      throw new AppError("The attachment is larger than 8 MiB");
    }
  });
  return jsonOutput({
    filename: part.filename ?? null,
    ...(await documents.read(raw, part.mimeType, a)),
  });
}

export async function runGmail(ctx: AppContext, name: string, a: Item): Promise<string> {
  const headers = await gmailHeaders(ctx);
  const get = (path: string, params?: Record<string, string | number>) =>
    request<Item>(ctx.fetch, "GET", GMAIL_API + path, { headers, params });
  switch (name) {
    case "gmail_search": {
      const data = await get("/messages", { q: a.query, maxResults: 20 });
      return (data.messages ?? []).map((m: Item) => m.id).join("\n") || "None.";
    }
    case "gmail_read":
      return jsonOutput(mailMessage(await get(`/messages/${gmailId(a.id)}`, { format: "full" })));
    case "gmail_read_thread": {
      const data = await get(`/threads/${gmailId(a.id)}`, { format: "full" });
      const messages: Item[] = data.messages ?? [];
      const start: number = a.offset ?? 0;
      const end = start + 5;
      return jsonOutput({
        id: data.id ?? null,
        messages: messages.slice(start, end).map((m) => mailMessage(m, 1000)),
        nextOffset: end < messages.length ? end : null,
      });
    }
    case "gmail_read_attachment":
      return readAttachment(ctx, headers, a);
    case "gmail_extract_attachment":
      return extractAttachment(ctx, headers, a);
    case "gmail_list_labels":
      return jsonOutput((await get("/labels")).labels ?? []);
    case "gmail_modify_labels": {
      const id = gmailId(a.id);
      const add: string[] = (a.add ?? []).map(gmailId);
      const remove: string[] = (a.remove ?? []).map(gmailId);
      if ((!add.length && !remove.length) || add.some((label) => remove.includes(label))) {
        throw new AppError(
          "Give at least one label to change, and never add and remove the same one",
        );
      }
      const resource = a.target === "thread" ? "threads" : "messages";
      try {
        await send(ctx.fetch, "POST", `${GMAIL_API}/${resource}/${id}/modify`, {
          headers,
          json: { addLabelIds: add, removeLabelIds: remove },
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) {
          throw new AppError(
            "Gmail refused the label change; check permissions or connect Gmail again in Apps.",
          );
        }
        throw error;
      }
      return "Gmail labels updated.";
    }
    case "gmail_create_draft":
    case "gmail_send": {
      const sending = name === "gmail_send";
      const raw = { raw: rawMessage(a as { to: string; subject: string; body: string }) };
      const reply = await request<Item>(
        ctx.fetch,
        "POST",
        GMAIL_API + (sending ? "/messages/send" : "/drafts"),
        { headers, json: sending ? raw : { message: raw } },
      );
      return sending ? jsonOutput({ sent: true, id: reply.id }) : "The draft is saved and has not been sent.";
    }
    default:
      throw new AppError("Unknown tool");
  }
}

export const gmail: App = {
  name: "gmail",
  tools,
  configured: (env) =>
    [GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN].every((key) => envSet(env, key)),
  run: runGmail,
};
