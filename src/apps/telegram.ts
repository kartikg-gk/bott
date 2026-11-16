import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { App } from "./app.ts";
import { AppError, type Fetch, jsonOutput } from "./http.ts";
import { tool } from "./schema.ts";

export const TELEGRAM_APP_TOKEN = "BOTT_TELEGRAM_APP_TOKEN";
/** Where the server's main Telegram bot keeps its token; linking must use a different bot. */
export const TELEGRAM_MAIN_TOKEN = "TELEGRAM_BOT_TOKEN";
const CODE_SECONDS = 600;
const MAX_TEXT = 3800;
const START = "/start ";

/** Telegram could not be reached or refused the call. */
export class TelegramError extends Error {
  override name = "TelegramError";
}

// biome-ignore lint/suspicious/noExplicitAny: Telegram replies are loose JSON
type Item = Record<string, any>;

/**
 * The chat and code in an update, when it is a person (not a bot) opening the link bot in their
 * own private chat with a start code. Anything else gives null.
 */
export function startRequest(update: Item): { chat: number; code: string } | null {
  const message: Item = update?.message ?? {};
  const chat: Item = message.chat ?? {};
  const from: Item = message.from ?? {};
  const text = message.text;
  const personal =
    chat.type === "private" &&
    Number.isInteger(chat.id) &&
    chat.id > 0 &&
    from.id === chat.id &&
    !from.is_bot;
  if (!personal || typeof text !== "string" || !text.startsWith(START)) return null;
  return { chat: chat.id, code: text.slice(START.length) };
}

/** One-time link codes, one per account, each good for ten minutes. */
class LinkCodes {
  private readonly byAccount = new Map<string, { code: string; expires: number }>();

  issue(account: string, now: number): string {
    for (const [owner, entry] of this.byAccount) {
      if (entry.expires <= now) this.byAccount.delete(owner);
    }
    const code = randomBytes(24).toString("base64url");
    this.byAccount.set(account, { code, expires: now + CODE_SECONDS });
    return code;
  }

  waiting(account: string, now: number): boolean {
    const entry = this.byAccount.get(account);
    return entry !== undefined && entry.expires > now;
  }

  /** The account a live code belongs to. */
  owner(code: string, now: number): string | undefined {
    for (const [account, entry] of this.byAccount) {
      if (entry.code === code && entry.expires > now) return account;
    }
    return undefined;
  }

  drop(account: string): void {
    this.byAccount.delete(account);
  }
}

/** Links an account to a private chat with the app bot, and sends to that chat. */
export class TelegramLinks {
  readonly botId: number | null;
  private readonly token: string | null;
  private readonly codes = new LinkCodes();
  private nextUpdate = 0;
  private reading: Promise<void> = Promise.resolve();

  constructor(
    token: string,
    private readonly fetcher: Fetch = fetch,
    private readonly clock: () => number = () => Date.now() / 1000,
  ) {
    const shaped = /^\d+:[A-Za-z0-9_-]{30,}$/.test(token);
    this.token = shaped ? token : null;
    this.botId = shaped ? Number.parseInt(token, 10) : null;
  }

  get ready(): boolean {
    return this.token !== null;
  }

  private async api(method: string, body: Item = {}): Promise<unknown> {
    if (this.token === null) throw new TelegramError("No Telegram link bot is set up");
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    const reply = await this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    })
      .then((r) => r.json() as Promise<Item>)
      .catch(() => {
        // The URL holds the token, so the underlying error is never passed on.
        throw new TelegramError("Telegram did not answer");
      });
    if (reply?.ok !== true) throw new TelegramError(`Telegram turned down ${method}`);
    return reply.result;
  }

  forget(account: string): void {
    this.codes.drop(account);
  }

  /** A link that opens the app bot with a one-time code for this account. */
  async begin(account: string): Promise<string> {
    const me = (await this.api("getMe")) as Item | null;
    const handle = me?.username;
    if (typeof handle !== "string" || !/^[A-Za-z0-9_]{5,32}$/.test(handle)) {
      throw new TelegramError("The link bot's username is missing or malformed");
    }
    return `https://t.me/${handle}?start=${this.codes.issue(account, this.clock())}`;
  }

  /**
   * Reads the app bot's new messages and saves each account whose code arrived from a person in
   * a private chat. Reads never overlap, so no update is handled twice.
   */
  confirm(account: string, save: (owner: string, chat: number) => Promise<void>): Promise<void> {
    const turn = this.reading.then(() => this.drain(account, save));
    this.reading = turn.catch(() => {});
    return turn;
  }

  private async drain(account: string, save: (owner: string, chat: number) => Promise<void>) {
    if (!this.codes.waiting(account, this.clock())) {
      this.codes.drop(account);
      return;
    }
    const batch = await this.api("getUpdates", {
      offset: this.nextUpdate,
      timeout: 0,
      limit: 100,
      allowed_updates: ["message"],
    });
    for (const update of Array.isArray(batch) ? (batch as Item[]) : []) {
      const id = update?.update_id;
      if (!Number.isInteger(id) || id < this.nextUpdate) continue;
      const request = startRequest(update);
      const owner = request && this.codes.owner(request.code, this.clock());
      if (request && owner !== undefined && owner !== null) {
        await save(owner, request.chat);
        this.codes.drop(owner);
      }
      this.nextUpdate = id + 1;
    }
  }

  async send(chat: number, text: string): Promise<{ message_id: number }> {
    const unsure =
      "Telegram may or may not have delivered it. Look at the chat before sending again.";
    const sent = (await this.api("sendMessage", {
      chat_id: chat,
      text,
      link_preview_options: { is_disabled: true },
    }).catch(() => {
      throw new AppError(unsure);
    })) as Item | null;
    if (!Number.isInteger(sent?.message_id)) throw new AppError(unsure);
    return { message_id: sent?.message_id };
  }
}

export const telegram: App = {
  name: "telegram",
  tools: [
    tool(
      "telegram_send_message",
      "Sends plain text to the private Telegram chat the signed-in person linked. " +
        "Only send when asked. If it is unclear whether it arrived, ask them to look.",
      { text: z.string().min(1).max(MAX_TEXT) },
      { write: true, review: true },
    ),
  ],
  configured: () => false,
  async run(ctx, _name, args) {
    const deliver = ctx.services.telegramSend;
    if (!deliver) throw new AppError("Link Telegram from a signed-in account");
    const body = args.text;
    if (typeof body !== "string" || body.trim() === "" || body.length > MAX_TEXT) {
      throw new AppError(`A Telegram message needs 1 to ${MAX_TEXT} characters`);
    }
    const signed = ctx.botName ? `${ctx.botName.slice(0, 100)}: ${body}` : body;
    return jsonOutput(await deliver(signed));
  },
};
