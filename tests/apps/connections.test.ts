import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BotApps } from "../../src/apps/access.ts";
import { AppConnections, type Caller, ConnectionError } from "../../src/apps/connections.ts";
import { MemoryAttempts, MemoryCredentials, MemoryFlows } from "../../src/apps/credentials.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import type { Database } from "../../src/db/database.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";
import { fakeFetch, type Handler, json, status } from "../support/fakeFetch.ts";

const ENV = {
  BOTT_GITHUB_CLIENT_ID: "gh-id",
  BOTT_GITHUB_CLIENT_SECRET: "gh-secret",
  BOTT_GMAIL_CLIENT_ID: "gm-id",
  BOTT_GMAIL_CLIENT_SECRET: "gm-secret",
};
const GOOGLE_TOKEN = "POST https://oauth2.googleapis.com/token";
const GITHUB_TOKEN = "POST https://github.com/login/oauth/access_token";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** Pulls state, challenge and the rest out of an authorization URL. */
const queryOf = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function setup(routes: Record<string, Handler> = {}, env: Record<string, string> = ENV) {
    const { db } = database(kind);
    open.push(db);
    let now = 1_800_000_000;
    const clock = () => now;
    const store = await Store.open(db, "main", { clock });
    const credentials = new MemoryCredentials();
    const fetcher = fakeFetch(routes);
    const connections = new AppConnections({
      credentials,
      flows: new MemoryFlows(clock),
      attempts: new MemoryAttempts(clock),
      storeFor: async () => store,
      origin: "https://bott.test",
      fetch: fetcher,
      env,
      clock,
    });
    const caller: Caller = { account: "acct", session: "browser-1" };
    const bot = await store.createBot({ name: "Writer", role: "Drafts text" });
    const advance = (seconds: number) => {
      now += seconds;
    };
    return { store, credentials, fetcher, connections, caller, bot, advance };
  }

  it("starts OAuth with a single-use state bound to the browser session", async () => {
    const { connections, caller, credentials, fetcher } = await setup({
      [GITHUB_TOKEN]: () => json({ access_token: "gho_1", token_type: "bearer" }),
    });
    const { url } = await connections.connect(caller, "github");
    expect(url.startsWith("https://github.com/login/oauth/authorize?")).toBe(true);
    const q = queryOf(url);
    expect(q.client_id).toBe("gh-id");
    expect(q.redirect_uri).toBe("https://bott.test/auth/apps/github/callback");
    expect(q.code_challenge_method).toBe("S256");
    expect(q.state).toHaveLength(43);

    const other: Caller = { account: "acct", session: "browser-2" };
    await expect(
      connections.callback(other, "github", { state: q.state, code: "c" }),
    ).rejects.toThrow("The app sign-in timed out or was turned down");
    await expect(
      connections.callback(caller, "github", { state: "x".repeat(43), code: "c" }),
    ).rejects.toThrow("The app sign-in timed out or was turned down");

    expect(await connections.callback(caller, "github", { state: q.state, code: "c" })).toBe(
      "/?apps=1",
    );
    const exchange = fetcher.seen.at(-1);
    expect(exchange?.form.get("code")).toBe("c");
    expect(exchange?.form.get("client_secret")).toBe("gh-secret");
    const verifier = exchange?.form.get("code_verifier") ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(q.code_challenge);
    expect(JSON.parse((await credentials.get("acct", "app", "github")) as string)).toEqual({
      access: "gho_1",
      refresh: null,
      expires: null,
    });
    await expect(
      connections.callback(caller, "github", { state: q.state, code: "c" }),
    ).rejects.toThrow("The app sign-in timed out or was turned down");
  });

  it("refuses short states, unknown apps and missing client settings", async () => {
    const { connections, caller } = await setup({}, { BOTT_GITHUB_CLIENT_ID: "only-id" });
    await expect(connections.connect(caller, "github")).rejects.toMatchObject({ status: 409 });
    await expect(connections.connect(caller, "nothing")).rejects.toMatchObject({ status: 404 });
    await expect(connections.callback(caller, "github", { state: "short" })).rejects.toMatchObject({
      status: 400,
      message: "This sign-in link is not valid. Connect the app again.",
    });
  });

  it("asks Google for offline access and checks the granted scopes", async () => {
    let scope = "openid";
    const { connections, caller } = await setup({
      [GOOGLE_TOKEN]: () =>
        json({ access_token: "ya29", refresh_token: "1//r", expires_in: 3600, scope }),
    });
    const first = queryOf((await connections.connect(caller, "gmail")).url);
    expect(first).toMatchObject({ scope: GMAIL_SCOPE, access_type: "offline", prompt: "consent" });
    await expect(
      connections.callback(caller, "gmail", { state: first.state, code: "c" }),
    ).rejects.toMatchObject({
      status: 502,
      message: "Connecting gmail failed. Connect it again.",
    });

    scope = `${GMAIL_SCOPE} openid`;
    const second = queryOf((await connections.connect(caller, "gmail")).url);
    await connections.callback(caller, "gmail", { state: second.state, code: "c" });
    expect(await connections.connected("acct", "gmail")).toBe(true);
  });

  it("renews a token near expiry and a refused one, and drops a revoked grant", async () => {
    let issued = 0;
    let revoked = false;
    const { connections, caller, store, bot, credentials, fetcher, advance } = await setup({
      [GOOGLE_TOKEN]: (req) => {
        if (req.form.get("grant_type") === "refresh_token" && revoked) {
          return status(400, { error: "invalid_grant" });
        }
        issued += 1;
        return json({
          access_token: `ya29-${issued}`,
          expires_in: 3600,
          scope: GMAIL_SCOPE,
          ...(issued === 1 ? { refresh_token: "1//r" } : {}),
        });
      },
    });
    const q = queryOf((await connections.connect(caller, "gmail")).url);
    await connections.callback(caller, "gmail", { state: q.state, code: "c" });
    await connections.grant(caller, "gmail", bot.id, { enabled: true });
    expect(await connections.token("acct", "gmail")).toBe("ya29-1");

    advance(3590);
    expect(await connections.token("acct", "gmail")).toBe("ya29-2");
    const saved = JSON.parse((await credentials.get("acct", "app", "gmail")) as string);
    expect(saved.refresh).toBe("1//r");
    expect(await connections.token("acct", "gmail", "ya29-2")).toBe("ya29-3");
    expect(fetcher.seen.filter((s) => s.form.get("grant_type") === "refresh_token")).toHaveLength(
      2,
    );

    revoked = true;
    advance(3600);
    await expect(connections.token("acct", "gmail")).rejects.toThrow(
      "gmail needs to be connected again",
    );
    expect(await credentials.get("acct", "app", "gmail")).toBeNull();
    expect(await store.pluginsFor(bot.id)).toEqual([]);
    await expect(connections.token("acct", "gmail")).rejects.toThrow(
      "gmail is not connected. Connect it in Apps.",
    );
  });

  it("an unreadable saved token asks for a new connection", async () => {
    const { connections, credentials } = await setup();
    const broken = {
      get: async () => {
        throw new Error("sealed value does not open");
      },
      put: credentials.put.bind(credentials),
      delete: credentials.delete.bind(credentials),
    };
    const other = new AppConnections({ ...connections.opts, credentials: broken });
    expect(await other.connected("acct", "github")).toBe(true);
    await expect(other.token("acct", "github")).rejects.toThrow(
      "The saved github connection cannot be read. Connect it again.",
    );
  });

  it("grants need a connected app, a lasting bot and a strict body", async () => {
    const { connections, caller, store, bot, credentials } = await setup();
    await expect(
      connections.grant(caller, "github", bot.id, { enabled: true }),
    ).rejects.toMatchObject({
      status: 409,
    });
    await credentials.put(
      "acct",
      "app",
      "github",
      JSON.stringify({ access: "t", refresh: null, expires: null }),
    );
    for (const body of [null, { enabled: "yes" }, { enabled: true, extra: 1 }]) {
      await expect(connections.grant(caller, "github", bot.id, body)).rejects.toMatchObject({
        status: 400,
      });
    }
    const scout = await store.createBot({ name: "Scout", role: "Looks", temporary: true });
    await expect(
      connections.grant(caller, "github", scout.id, { enabled: true }),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(await connections.grant(caller, "github", bot.id, { enabled: true })).toEqual({
      enabled: true,
    });
    expect(await store.pluginsFor(bot.id)).toEqual(["github"]);
    const signedOut: Caller = { ...caller, signedIn: async () => false };
    await expect(
      connections.grant(signedOut, "github", bot.id, { enabled: false }),
    ).rejects.toBeInstanceOf(ConnectionError);

    const listed = await connections.list(caller);
    expect(listed.map((a) => a.id).slice(0, 2)).toEqual(["github", "gmail"]);
    expect(listed[0]).toMatchObject({
      configured: true,
      connected: true,
      saved: true,
      keyAuth: false,
    });
    expect(listed[0]?.bots).toContainEqual({ id: bot.id, name: "Writer", enabled: true });
  });

  it("disconnecting clears grants and asks the provider to revoke", async () => {
    const { connections, caller, store, bot, credentials, fetcher } = await setup({
      "DELETE https://api.github.com/applications/gh-id/grant": () =>
        new Response(null, { status: 204 }),
      "POST https://oauth2.googleapis.com/revoke": () => status(400),
    });
    await credentials.put(
      "acct",
      "app",
      "github",
      JSON.stringify({ access: "gho", refresh: null, expires: null }),
    );
    await credentials.put(
      "acct",
      "app",
      "gmail",
      JSON.stringify({ access: "ya", refresh: "r", expires: 1 }),
    );
    await store.setPlugin(bot.id, "github", true);
    expect(await connections.disconnect(caller, "github")).toEqual({
      connected: false,
      providerRevoked: true,
    });
    const revoke = fetcher.seen.at(-1);
    expect(revoke?.json).toEqual({ access_token: "gho" });
    expect(revoke?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("gh-id:gh-secret").toString("base64")}`,
    );
    expect(await store.pluginsFor(bot.id)).toEqual([]);
    expect(await credentials.get("acct", "app", "github")).toBeNull();

    expect(await connections.disconnect(caller, "gmail")).toEqual({
      connected: false,
      providerRevoked: false,
    });
    expect(fetcher.seen.at(-1)?.form.get("token")).toBe("r");
    expect(await credentials.get("acct", "app", "gmail")).toBeNull();
  });

  it("an account runner uses the account's connection for its bots", async () => {
    const { connections, store, bot, credentials } = await setup({
      "GET https://api.github.com/repos/o/r": (req) =>
        json({ full_name: req.headers.get("authorization") }),
    });
    const apps = new BotApps(store, connections.runner("acct"));
    await store.setPlugin(bot.id, "github", true);
    expect(await apps.enabled(bot.id)).toEqual([]);
    await credentials.put(
      "acct",
      "app",
      "github",
      JSON.stringify({ access: "gho_a", refresh: null, expires: null }),
    );
    expect(await apps.enabled(bot.id)).toEqual(["github"]);
    const out = await apps.call(bot, "github_get_repository", { repo: "o/r" });
    expect(out.content[0]).toEqual({
      type: "text",
      text: `${UNTRUSTED}${JSON.stringify({ full_name: "Bearer gho_a" })}`,
    });
  });
});

describe("started flows", () => {
  it("expire after ten minutes and keep only digests", async () => {
    let now = 100;
    const flows = new MemoryFlows(() => now);
    await flows.start("a", "github", "browser", "state-1", "verifier");
    expect(
      JSON.stringify([...(flows as unknown as { flows: Map<string, unknown> }).flows]),
    ).not.toMatch(/browser|state-1/);
    now += 601;
    expect(await flows.consume("a", "github", "browser", "state-1")).toBeNull();
    await flows.start("a", "github", "browser", "state-2", "v2");
    await flows.forget("a", "github");
    expect(await flows.consume("a", "github", "browser", "state-2")).toBeNull();
  });

  it("allow five attempts in five minutes", async () => {
    let now = 0;
    const attempts = new MemoryAttempts(() => now);
    for (let i = 0; i < 5; i++) expect(await attempts.attempt("a")).toBe(true);
    expect(await attempts.attempt("a")).toBe(false);
    expect(await attempts.attempt("b")).toBe(true);
    now += 301;
    expect(await attempts.attempt("a")).toBe(true);
  });
});
