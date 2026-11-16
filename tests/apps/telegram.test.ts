import { describe, expect, it } from "vitest";
import { BotApps } from "../../src/apps/access.ts";
import { AppConnections } from "../../src/apps/connections.ts";
import { MemoryAttempts, MemoryCredentials, MemoryFlows } from "../../src/apps/credentials.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { TelegramLinks, telegram } from "../../src/apps/telegram.ts";
import { Store } from "../../src/store/store.ts";
import { database } from "../support/fakeD1.ts";
import { fakeFetch, json, type Seen } from "../support/fakeFetch.ts";

const TOKEN = `12345:${"a".repeat(35)}`;
const API = `https://api.telegram.org/bot${TOKEN}`;

/** A Telegram app bot with a queue of updates and a record of what was sent. */
function telegramServer() {
  const updates: unknown[] = [];
  const sent: Seen[] = [];
  let failSend = false;
  const fetcher = fakeFetch({
    [`POST ${API}/getMe`]: () => json({ ok: true, result: { username: "bott_link_bot" } }),
    [`POST ${API}/getUpdates`]: (req) =>
      json({
        ok: true,
        result: updates.filter((u) => (u as { update_id: number }).update_id >= req.json.offset),
      }),
    [`POST ${API}/sendMessage`]: (req) => {
      sent.push(req);
      return failSend
        ? json({ ok: false, description: "blocked" })
        : json({ ok: true, result: { message_id: 77 } });
    },
  });
  return {
    fetcher,
    updates,
    sent,
    failNext: () => {
      failSend = true;
    },
  };
}

const start = (id: number, chat: number, text: string, extra: object = {}) => ({
  update_id: id,
  message: { chat: { id: chat, type: "private" }, from: { id: chat }, text, ...extra },
});

async function setup(
  env: Record<string, string> = { BOTT_TELEGRAM_APP_TOKEN: TOKEN },
  extra: Partial<ConstructorParameters<typeof AppConnections>[0]> = {},
) {
  const { db } = database("sqlite");
  const store = await Store.open(db, "main");
  const bot = await store.createBot({ name: "Writer", role: "Drafts" });
  const server = telegramServer();
  const credentials = new MemoryCredentials();
  const connections = new AppConnections({
    credentials,
    flows: new MemoryFlows(),
    attempts: new MemoryAttempts(),
    storeFor: async () => store,
    origin: "https://bott.test",
    fetch: server.fetcher,
    env,
    ...extra,
  });
  return { db, store, bot, server, credentials, connections };
}

describe("telegram", () => {
  async function expectRefused(connections: AppConnections) {
    expect(connections.configured("telegram")).toBe(false);
    await expect(
      connections.connect({ account: "a", session: "s" }, "telegram"),
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("main Telegram bot") });
    const listed = (await connections.list({ account: "a", session: "s" })).find(
      (a) => a.id === "telegram",
    );
    expect(listed).toMatchObject({ configured: false, configurationError: expect.any(String) });
  }

  it("refuses an app token equal to the main bot token in the environment", async () => {
    const { db, connections } = await setup({
      BOTT_TELEGRAM_APP_TOKEN: TOKEN,
      TELEGRAM_BOT_TOKEN: TOKEN,
    });
    await expectRefused(connections);
    await db.close();
  });

  it("refuses an app token for the same bot as the configured main token", async () => {
    const { db, connections } = await setup(
      { BOTT_TELEGRAM_APP_TOKEN: TOKEN },
      { mainTelegramToken: `12345:${"b".repeat(35)}` },
    );
    await expectRefused(connections);
    await db.close();
  });

  it("refuses an injected link bot that is the main bot", async () => {
    const server = telegramServer();
    const { db, connections } = await setup(
      {},
      { mainTelegramToken: TOKEN, telegram: new TelegramLinks(TOKEN, server.fetcher) },
    );
    await expectRefused(connections);
    await db.close();
  });

  it("accepts a link bot that differs from the main bot", async () => {
    const { db, connections } = await setup(
      { BOTT_TELEGRAM_APP_TOKEN: TOKEN },
      { mainTelegramToken: `999:${"c".repeat(35)}` },
    );
    expect(connections.configured("telegram")).toBe(true);
    await db.close();
  });

  it("links a private chat by one-time code and sends there with approval", async () => {
    const { db, store, bot, server, credentials, connections } = await setup();
    const caller = { account: "a", session: "s" };
    expect(APPS.telegram).toBe(telegram);
    expect(telegram.tools[0]).toMatchObject({ readOnly: false, review: true });
    const { url } = await connections.connect(caller, "telegram");
    expect(url.startsWith("https://t.me/bott_link_bot?start=")).toBe(true);
    const code = new URL(url).searchParams.get("start") as string;

    server.updates.push(
      start(1, 500, `/start ${code}`, { from: { id: 500, is_bot: true } }),
      start(2, -9, `/start ${code}`),
      start(3, 600, "/start wrong-code"),
      start(4, 700, `/start ${code}`),
    );
    expect(await connections.confirmTelegram(caller)).toEqual({ connected: true });
    expect(JSON.parse((await credentials.get("a", "app", "telegram")) as string)).toEqual({
      chat_id: 700,
      bot_id: 12345,
    });
    await expect(connections.connect(caller, "telegram")).rejects.toMatchObject({ status: 409 });

    await connections.grant(caller, "telegram", bot.id, { enabled: true });
    const apps = new BotApps(store, connections.runner("a"));
    expect(await apps.enabled(bot.id)).toEqual(["telegram"]);
    const out = await apps.call(bot, "telegram_send_message", { text: "Hello" });
    expect(out.content[0]).toEqual({
      type: "text",
      text: `${UNTRUSTED}${JSON.stringify({ message_id: 77 })}`,
    });
    expect(server.sent[0]?.json).toEqual({
      chat_id: 700,
      text: "Writer: Hello",
      link_preview_options: { is_disabled: true },
    });

    server.failNext();
    expect((await apps.call(bot, "telegram_send_message", { text: "Again" })).content[0]).toEqual({
      type: "text",
      text: "Telegram may or may not have delivered it. Look at the chat before sending again.",
    });
    expect(await connections.disconnect(caller, "telegram")).toEqual({
      connected: false,
      providerRevoked: false,
    });
    expect(await connections.connected("a", "telegram")).toBe(false);
    await db.close();
  });

  it("a code links only within ten minutes and only once", async () => {
    let now = 0;
    const server = telegramServer();
    const { TelegramLinks } = await import("../../src/apps/telegram.ts");
    const links = new TelegramLinks(TOKEN, server.fetcher, () => now);
    const url = await links.begin("a");
    const code = new URL(url).searchParams.get("start");
    server.updates.push(start(1, 42, `/start ${code}`));
    const saved: [string, number][] = [];
    now += 601;
    await links.confirm("a", async (owner, chat) => {
      saved.push([owner, chat]);
    });
    expect(saved).toEqual([]);
    expect(new TelegramLinks("not-a-token").ready).toBe(false);
  });

  it("without a link the tool asks the person to link Telegram", async () => {
    const runner = new AppRunner({
      env: {},
      accessToken: async () => "t",
      available: async () => true,
    });
    await expect(runner.run("telegram_send_message", { text: "x" })).rejects.toThrow(
      "Link Telegram from a signed-in account",
    );
  });
});
