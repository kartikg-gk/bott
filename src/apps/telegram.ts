import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { App } from "./app.ts";
import { AppError, type Fetch, jsonOutput } from "./http.ts";
import { tool } from "./schema.ts";

export const TELEGRAM_APP_TOKEN = "BOTT_TELEGRAM_APP_TOKEN";
/** The token of the server's main Telegram bot, which linking must never share. */
export const TELEGRAM_MAIN_TOKEN = "BOTT_TELEGRAM_TOKEN";
const LINK_SECONDS = 600;

/** Telegram could not be reached or refused the call. */
export class TelegramError extends Error {
  override name = "TelegramError";
}

// biome-ignore lint/suspicious/noExplicitAny: Telegram replies are loose JSON
type Item = Record<string, any>;

/** Links an account to a private chat with the app bot, and sends to that chat. */
export class TelegramLinks {
  readonly botId: number | null;
  private readonly token: string | null;
  private readonly pending = new Map<string, { code: string; expires: number }>();
  private offset = 0;
  private confirming: Promise<void> = Promise.resolve();

  constructor(
    token: string,
    private readonly fetcher: Fetch = fetch,
    private readonly clock: () => number = () => Date.now() / 1000,
  ) {
    const usable = /^\d+:[A-Za-z0-9_-]{30,}$/.test(token);
    this.token = usable ? token : null;
    this.botId = usable ? Number(token.split(":")[0]) : null;
  }

  get ready(): boolean {
    return this.token !== null;
  }

  async call(method: string, body: Item = {}): Promise<unknown> {
    if (!this.token) throw new TelegramError("The Telegram app bot is not set up");
    let data: Item;
    try {
      const reply = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      data = (await reply.json()) as Item;
    } catch {
      throw new TelegramError("Telegram could not be reached");
    }
    if (data?.ok !== true) throw new TelegramError("Telegram refused the call");
    return data.result;
  }

  forget(account: string): void {
    this.pending.delete(account);
  }

  /** A link that opens the app bot with a one-time code for this account. */
  async begin(account: string): Promise<string> {
    const profile = (await this.call("getMe")) as Item | null;
    const username = profile?.username ?? "";
    if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
      throw new TelegramError("Telegram sent back no bot name that can be used");
    }
    const now = this.clock();
    for (const [key, link] of this.pending) if (link.expires <= now) this.pending.delete(key);
    const code = randomBytes(24).toString("base64url");
    this.pending.set(account, { code, expires: now + LINK_SECONDS });
    return `https://t.me/${username}?start=${code}`;
  }

  /**
   * Reads the app bot's new messages and saves each account whose code arrived from a person in
   * a private chat. Only one confirmation reads updates at a time.
   */
  confirm(account: string, save: (owner: string, chat: number) => Promise<void>): Promise<void> {
    const run = this.confirming.then(() => this.read(account, save));
    this.confirming = run.catch(() => {});
    return run;
  }

  private async read(account: string, save: (owner: string, chat: number) => Promise<void>) {
    const link = this.pending.get(account);
    if (!link || link.expires <= this.clock()) {
      this.forget(account);
      return;
    }
    const updates = (await this.call("getUpdates", {
      offset: this.offset,
      timeout: 0,
      limit: 100,
      allowed_updates: ["message"],
    })) as Item[];
    const owners = new Map([...this.pending].map(([key, value]) => [value.code, key]));
    for (const update of Array.isArray(updates) ? updates : []) {
      const id = update?.update_id;
      if (!Number.isInteger(id) || id < this.offset) continue;
      const message: Item = update.message ?? {};
      const chat: Item = message.chat ?? {};
      const sender: Item = message.from ?? {};
      const words = message.text;
      if (
        chat.type === "private" &&
        Number.isInteger(chat.id) &&
        chat.id > 0 &&
        sender.id === chat.id &&
        !sender.is_bot &&
        typeof words === "string" &&
        words.startsWith("/start ")
      ) {
        const code = words.slice("/start ".length);
        const owner = owners.get(code);
        const current = owner === undefined ? undefined : this.pending.get(owner);
        if (owner !== undefined && current?.code === code && current.expires > this.clock()) {
          await save(owner, chat.id);
          this.forget(owner);
        }
      }
      this.offset = id + 1;
    }
  }

  async send(chat: number, text: string): Promise<{ message_id: number }> {
    let delivery: unknown;
    try {
      delivery = await this.call("sendMessage", {
        chat_id: chat,
        text,
        link_preview_options: { is_disabled: true },
      });
    } catch {
      throw new AppError(
        "It is unclear whether Telegram delivered it; look at the linked chat before trying again.",
      );
    }
    const id = (delivery as Item | null)?.message_id;
    if (!Number.isInteger(id)) {
      throw new AppError("It is unclear whether Telegram delivered it; look at the linked chat.");
    }
    return { message_id: id };
  }
}

export const telegram: App = {
  name: "telegram",
  tools: [
    tool(
      "telegram_send_message",
      "Send plain text to the private Telegram chat linked to the person signed in. " +
        "Send only on request. When delivery is unclear, ask the person to look at the chat.",
      { text: z.string().min(1).max(3800) },
      { write: true, review: true },
    ),
  ],
  configured: () => false,
  async run(ctx, _name, args) {
    const send = ctx.services.telegramSend;
    if (!send) throw new AppError("Link Telegram from a signed-in account");
    let words = args.text as string;
    if (typeof words !== "string" || !words.trim() || words.length > 3800) {
      throw new AppError("A Telegram message needs 1 to 3800 characters");
    }
    if (ctx.botName) words = `${ctx.botName.slice(0, 100)}: ${words}`;
    return jsonOutput(await send(words));
  },
};
