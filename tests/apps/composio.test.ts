import { afterEach, describe, expect, it } from "vitest";
import { BotApps, LOAD_PLUGIN } from "../../src/apps/access.ts";
import {
  COMPOSIO_KEY,
  ComposioAccounts,
  MAX_TOOLS,
  readTool,
  toolkitOf,
  toolkitOfTool,
} from "../../src/apps/composio.ts";
import type { Caller } from "../../src/apps/connections.ts";
import { ConnectionError } from "../../src/apps/connections.ts";
import { MemoryAttempts, MemoryCredentials } from "../../src/apps/credentials.ts";
import { MAX_OUTPUT, UNTRUSTED } from "../../src/apps/http.ts";
import { AppRunner } from "../../src/apps/registry.ts";
import type { Database } from "../../src/db/database.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";
import { fakeFetch, type Handler, json, status } from "../support/fakeFetch.ts";

const BASE = "https://composio.test/api/v3.1";
const at = (method: string, path: string) => `${method} ${BASE}${path}`;

const SEND = {
  slug: "SLACK_SEND_MESSAGE",
  name: "Send message",
  description: "Posts a message to a channel",
  input_parameters: {
    type: "object",
    properties: { channel: { type: "string" }, text: { type: "string" } },
    required: ["channel", "text"],
  },
  tags: ["important"],
};
const LIST = {
  slug: "SLACK_LIST_CHANNELS",
  description: "Lists channels",
  input_parameters: { type: "object", properties: { limit: { type: "integer" } } },
  tags: ["readOnlyHint", "important"],
};

/** A fake Composio that keeps connected accounts in memory, keyed by id. */
function composio(extra: Record<string, Handler> = {}) {
  const accounts = new Map<string, { status: string; user: string; toolkit: string }>();
  let next = 1;
  const routes: Record<string, Handler> = {
    [at("GET", "/auth_configs")]: (req) =>
      req.headers.get("x-api-key") === "ck_good"
        ? json({ items: [] })
        : status(401, { message: "bad key" }),
    [at("POST", "/auth_configs")]: (req) =>
      json({ toolkit: req.json.toolkit, auth_config: { id: `ac_${req.json.toolkit.slug}` } }),
    [at("POST", "/connected_accounts/link")]: (req) => {
      const id = `ca_${next++}`;
      const toolkit = String(req.json.auth_config_id).slice(3);
      accounts.set(id, { status: "INITIATED", user: req.json.user_id, toolkit });
      return json({
        redirect_url: `https://connect.composio.test/${id}`,
        connected_account_id: id,
      });
    },
    [at("GET", "/tools")]: () => json({ items: [SEND, LIST], next_cursor: null }),
    [at("POST", "/tools/execute/SLACK_SEND_MESSAGE")]: (req) =>
      json({ successful: true, data: { echoed: req.json }, error: null }),
    [at("POST", "/tools/execute/SLACK_LIST_CHANNELS")]: () =>
      json({ successful: true, data: { blob: "x".repeat(MAX_OUTPUT * 2) }, error: null }),
    ...extra,
  };
  const fetcher = fakeFetch(
    new Proxy(routes, {
      get(target, key: string) {
        if (key in target) return target[key];
        const found = /^(GET|DELETE) .*\/connected_accounts\/(ca_\d+)$/.exec(key);
        if (!found) return undefined;
        const id = found[2] as string;
        return () => {
          const account = accounts.get(id);
          if (!account) return status(404);
          if (found[1] === "DELETE") {
            accounts.delete(id);
            return json({ success: true });
          }
          return json({
            id,
            status: account.status,
            user_id: account.user,
            toolkit: { slug: account.toolkit },
          });
        };
      },
    }),
  );
  return { fetcher, accounts };
}

describe("composio names", () => {
  it("maps grants and tool slugs to toolkits", () => {
    expect(toolkitOf("composio:slack")).toBe("slack");
    expect(toolkitOf("composio:gmail")).toBeUndefined();
    expect(toolkitOf("slack")).toBeUndefined();
    expect(toolkitOfTool("SLACK_SEND_MESSAGE")).toBe("slack");
    expect(toolkitOfTool("MICROSOFT_TEAMS_POST")).toBe("microsoft_teams");
    expect(toolkitOfTool("GMAIL_SEND_EMAIL")).toBeUndefined();
    expect(toolkitOfTool("github_create_issue")).toBeUndefined();
  });

  it("treats a tool as a write unless Composio marks it read-only", () => {
    expect(readTool(SEND, "slack")?.readOnly).toBe(false);
    expect(readTool(LIST, "slack")?.readOnly).toBe(true);
    expect(readTool({ ...SEND, slug: "bad slug" }, "slack")).toBeUndefined();
    expect(readTool({ ...SEND, is_deprecated: true }, "slack")).toBeUndefined();
  });
});

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function setup(env: Record<string, string> = { [COMPOSIO_KEY]: "ck_good" }) {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main", { clock: () => 1_800_000_000 });
    const credentials = new MemoryCredentials();
    const fake = composio();
    const accounts = new ComposioAccounts({
      credentials,
      attempts: new MemoryAttempts(() => 1_800_000_000),
      storeFor: async () => store,
      origin: "https://bott.test",
      fetch: fake.fetcher,
      env,
      base: BASE,
    });
    const caller: Caller = { account: "acct-1", session: "browser-1" };
    const bot = await store.createBot({ name: "Writer", role: "Drafts text" });
    const apps = new BotApps(store, new AppRunner({ env: {} }), accounts.forAccount("acct-1"));
    return { store, credentials, fake, accounts, caller, bot, apps };
  }

  /** Connects Slack and lets Composio finish the sign-in. */
  async function connected(s: Awaited<ReturnType<typeof setup>>) {
    const started = await s.accounts.connect(s.caller, "slack");
    const remote = s.fake.accounts.get(started.connectedAccountId);
    if (remote) remote.status = "ACTIVE";
    return started;
  }

  it("is not offered without the server key", async () => {
    const s = await setup({});
    expect(await s.accounts.list(s.caller)).toEqual({ configured: false, toolkits: [] });
    await expect(s.accounts.connect(s.caller, "slack")).rejects.toMatchObject({ status: 404 });
    expect(s.fake.fetcher.seen).toHaveLength(0);
  });

  it("starts hosted sign-in for the account and keeps only the sealed id", async () => {
    const s = await setup();
    const started = await s.accounts.connect(s.caller, "slack");
    expect(started.url).toBe(`https://connect.composio.test/${started.connectedAccountId}`);
    const link = s.fake.fetcher.seen.find((r) => r.url.pathname.endsWith("/link"));
    expect(link?.json).toEqual({
      auth_config_id: "ac_slack",
      user_id: "acct-1",
      callback_url: "https://bott.test/?apps=composio&toolkit=slack",
    });
    expect(link?.headers.get("x-api-key")).toBe("ck_good");
    expect(await s.credentials.get("acct-1", "composio", "slack")).toBe(
      JSON.stringify({ id: started.connectedAccountId }),
    );
    expect(await s.accounts.status(s.caller, "slack")).toEqual({
      connected: false,
      status: "INITIATED",
    });
  });

  it("refuses unknown toolkits and services bott has its own app for", async () => {
    const s = await setup();
    for (const name of ["gmail", "github", "nope"]) {
      await expect(s.accounts.connect(s.caller, name)).rejects.toBeInstanceOf(ConnectionError);
    }
  });

  it("grants a bot only once the connection is active", async () => {
    const s = await setup();
    const started = await s.accounts.connect(s.caller, "slack");
    const on = { enabled: true };
    await expect(s.accounts.grant(s.caller, "slack", s.bot.id, on)).rejects.toMatchObject({
      status: 409,
    });
    const remote = s.fake.accounts.get(started.connectedAccountId);
    if (remote) remote.status = "ACTIVE";
    expect(await s.accounts.grant(s.caller, "slack", s.bot.id, on)).toEqual(on);
    expect(await s.store.pluginsFor(s.bot.id)).toEqual(["composio:slack"]);
    const listed = await s.accounts.list(s.caller);
    const slack = listed.toolkits.find((t) => t.id === "slack");
    expect(slack?.saved).toBe(true);
    expect(slack?.bots).toContainEqual({ id: s.bot.id, name: "Writer", enabled: true });
    expect(slack?.bots.filter((b) => b.enabled)).toHaveLength(1);
    await expect(s.accounts.grant(s.caller, "slack", "nobody", on)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("does not trust a connection that belongs to another user", async () => {
    const s = await setup();
    const started = await s.accounts.connect(s.caller, "slack");
    const remote = s.fake.accounts.get(started.connectedAccountId);
    if (remote) Object.assign(remote, { status: "ACTIVE", user: "someone-else" });
    expect(await s.accounts.status(s.caller, "slack")).toEqual({
      connected: false,
      status: "MISMATCH",
    });
  });

  it("disconnecting removes the remote account, the saved id and every grant", async () => {
    const s = await setup();
    const started = await connected(s);
    await s.accounts.grant(s.caller, "slack", s.bot.id, { enabled: true });
    expect(await s.accounts.disconnect(s.caller, "slack")).toEqual({
      connected: false,
      providerRevoked: true,
    });
    expect(s.fake.accounts.has(started.connectedAccountId)).toBe(false);
    expect(await s.credentials.get("acct-1", "composio", "slack")).toBeNull();
    expect(await s.store.pluginsFor(s.bot.id)).toEqual([]);
  });

  it("connecting again replaces the old remote account", async () => {
    const s = await setup();
    const first = await connected(s);
    await s.accounts.connect(s.caller, "slack");
    expect(s.fake.accounts.has(first.connectedAccountId)).toBe(false);
  });

  it("bots see the toolkit by name and load its tools on demand", async () => {
    const s = await setup();
    await connected(s);
    await s.accounts.grant(s.caller, "slack", s.bot.id, { enabled: true });
    expect(await s.apps.enabled(s.bot.id)).toEqual(["composio:slack"]);
    expect(s.apps.loader(["composio:slack"]).name).toBe(LOAD_PLUGIN);
    expect(s.fake.fetcher.seen.some((r) => r.url.pathname.endsWith("/tools"))).toBe(false);
    const loaded = await s.apps.load(s.bot.id, { name: "composio:slack" });
    expect(loaded.tools.map((t) => [t.name, t.readOnly])).toEqual([
      ["SLACK_SEND_MESSAGE", false],
      ["SLACK_LIST_CHANNELS", true],
    ]);
    expect(loaded.tools[0]?.input.safeParse({ channel: "c" }).success).toBe(false);
    expect(s.apps.owns("SLACK_SEND_MESSAGE")).toBe(true);
  });

  it("a toolkit not granted cannot be loaded or run", async () => {
    const s = await setup();
    await connected(s);
    const loaded = await s.apps.load(s.bot.id, { name: "composio:slack" });
    expect(loaded.tools).toEqual([]);
    const out = await s.apps.call(s.bot, "SLACK_SEND_MESSAGE", { channel: "c", text: "t" });
    expect(out.isError).toBe(true);
    expect(s.fake.fetcher.seen.some((r) => r.url.pathname.includes("/execute/"))).toBe(false);
  });

  it("runs a tool for the account's connection and marks the reply as data", async () => {
    const s = await setup();
    const started = await connected(s);
    await s.accounts.grant(s.caller, "slack", s.bot.id, { enabled: true });
    const out = await s.apps.call(s.bot, "SLACK_SEND_MESSAGE", { channel: "c", text: "hi" });
    expect(out.isError).toBeFalsy();
    const body = (out.content[0] as { text: string }).text;
    expect(body.startsWith(UNTRUSTED)).toBe(true);
    const sent = s.fake.fetcher.seen.find((r) => r.url.pathname.includes("/execute/"));
    expect(sent?.json).toEqual({
      connected_account_id: started.connectedAccountId,
      user_id: "acct-1",
      arguments: { channel: "c", text: "hi" },
    });
    const big = await s.apps.call(s.bot, "SLACK_LIST_CHANNELS", {});
    const bigText = (big.content[0] as { text: string }).text;
    expect(bigText.length).toBeLessThan(MAX_OUTPUT + 200);
    expect(bigText.endsWith("[Truncated]")).toBe(true);
  });

  it("refuses arguments that do not fit the tool's schema", async () => {
    const s = await setup();
    await connected(s);
    await s.accounts.grant(s.caller, "slack", s.bot.id, { enabled: true });
    const out = await s.apps.call(s.bot, "SLACK_SEND_MESSAGE", { channel: "c" });
    expect(out.isError).toBe(true);
    expect(s.fake.fetcher.seen.some((r) => r.url.pathname.includes("/execute/"))).toBe(false);
  });

  it("passes on a failed call only as labelled outside text", async () => {
    const s = await setup();
    await connected(s);
    await s.accounts.grant(s.caller, "slack", s.bot.id, { enabled: true });
    const fake = composio({
      [at("POST", "/tools/execute/SLACK_SEND_MESSAGE")]: () =>
        json({ successful: false, data: null, error: "channel_not_found" }),
    });
    const other = new ComposioAccounts({
      credentials: s.credentials,
      storeFor: async () => s.store,
      origin: "https://bott.test",
      fetch: fake.fetcher,
      env: { [COMPOSIO_KEY]: "ck_good" },
      base: BASE,
    });
    const apps = new BotApps(s.store, new AppRunner({ env: {} }), other.forAccount("acct-1"));
    const out = await apps.call(s.bot, "SLACK_SEND_MESSAGE", { channel: "c", text: "t" });
    expect(out.isError).toBe(true);
    const words = (out.content[0] as { text: string }).text;
    expect(words).toContain(UNTRUSTED);
    expect(words).toContain("channel_not_found");
  });

  it("keeps at most the tool cap from a large toolkit", async () => {
    const many = Array.from({ length: MAX_TOOLS + 40 }, (_, i) => ({
      ...SEND,
      slug: `SLACK_TOOL_${i}`,
    }));
    const s = await setup();
    await connected(s);
    await s.accounts.grant(s.caller, "slack", s.bot.id, { enabled: true });
    const fake = composio({ [at("GET", "/tools")]: () => json({ items: many }) });
    const other = new ComposioAccounts({
      credentials: s.credentials,
      storeFor: async () => s.store,
      origin: "https://bott.test",
      fetch: fake.fetcher,
      env: { [COMPOSIO_KEY]: "ck_good" },
      base: BASE,
    });
    const apps = new BotApps(s.store, new AppRunner({ env: {} }), other.forAccount("acct-1"));
    const loaded = await apps.load(s.bot.id, { name: "composio:slack" });
    expect(loaded.tools).toHaveLength(MAX_TOOLS);
  });
});
