import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleLogin } from "../../src/accounts/google.ts";
import { AccountModels } from "../../src/accounts/models.ts";
import { AccountStore, VALIDATION_LIMIT } from "../../src/accounts/store.ts";
import { BotApps } from "../../src/apps/access.ts";
import { AppConnections } from "../../src/apps/connections.ts";
import { ensureSchema } from "../../src/db/schema.ts";
import { AccountGateways } from "../../src/web/accounts.ts";
import { createApp } from "../../src/web/app.ts";
import { type AppsSeam, accountAppStores, connectedApps } from "../../src/web/apps.ts";
import { fresh } from "../../src/web/router.ts";
import { KEY } from "../support/accounts.ts";
import { backends, database } from "../support/fakeD1.ts";
import { gated } from "./support.ts";

describe.each(backends)("%s backend", (kind) => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function accounts() {
    const { db } = database(kind);
    cleanups.push(() => db.close());
    await ensureSchema(db);
    const store = await AccountStore.open(db, "realm", KEY);
    const token = await store.signIn("alice-subject", "alice@example.test", null);
    const account = (await store.session(token))?.id as string;
    return { db, store, token, account };
  }

  it("keeps app secrets sealed, connections single-use and key checks limited", async () => {
    const { store, account } = await accounts();
    const { credentials, flows, attempts } = accountAppStores(store);
    await credentials.put(account, "app", "github", "secret-token");
    expect(await credentials.get(account, "app", "github")).toBe("secret-token");
    const raw = await store.db.query("SELECT sealed FROM credentials");
    expect(Buffer.from(raw[0]?.sealed as Uint8Array).toString("utf8")).not.toContain("secret");
    await credentials.delete(account, "app", "github");
    expect(await credentials.get(account, "app", "github")).toBeNull();

    await flows.start(account, "github", "session-1", "state-1", "verifier-1");
    expect(await flows.consume(account, "github", "session-2", "state-1")).toBeNull();
    expect(await flows.consume(account, "github", "session-1", "state-1")).toBe("verifier-1");
    expect(await flows.consume(account, "github", "session-1", "state-1")).toBeNull();
    await flows.start(account, "github", "session-1", "state-2", "verifier-2");
    await flows.forget(account, "github");
    expect(await flows.consume(account, "github", "session-1", "state-2")).toBeNull();

    for (let n = 0; n < VALIDATION_LIMIT; n++) expect(await attempts.attempt(account)).toBe(true);
    expect(await attempts.attempt(account)).toBe(false);
  });

  it("hands each account's gateway to the apps seam and adds its routes", async () => {
    const { db, store, token } = await accounts();
    const root = mkdtempSync(join(tmpdir(), "apps-web-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const attached: string[] = [];
    const apps: AppsSeam = {
      attach: (gateway, account) => {
        attached.push(`${account?.email}:${gateway.store.ctx.instance}`);
      },
      routes: (router) => {
        router.add("GET", "/api/apps", async (ctx) => fresh({ for: ctx.account?.email }));
      },
    };
    const login = new GoogleLogin(store, {
      origin: "http://localhost:8765",
      clientId: "c",
      clientSecret: "s",
      emails: ["alice@example.test"],
      domains: [],
    });
    const gateways = new AccountGateways({
      store,
      login,
      stateDir: root,
      hosted: true,
      db,
      policy: "auto",
      model: "m",
      idleSeconds: 60,
      fixed: () => gated([]),
      apps,
    });
    cleanups.push(() => gateways.close());
    const handler = createApp({
      auth: {
        mode: "google",
        login,
        models: new AccountModels(store),
        gateway: (account) => gateways.gateway(account),
      },
      apps,
    });
    const response = await handler(
      new Request("http://localhost:8765/api/apps", {
        headers: { host: "localhost:8765", cookie: `gateway_session=${token}` },
      }),
    );
    expect(await response.json()).toEqual({ for: "alice@example.test" });
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatch(/^alice@example\.test:[0-9a-f]{32}$/);
  });

  it("connects an app through the page and the provider's redirect, then lets a bot use it", async () => {
    const { db, store, token } = await accounts();
    const root = mkdtempSync(join(tmpdir(), "apps-live-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const origin = "http://localhost:8765";
    const login = new GoogleLogin(store, {
      origin,
      clientId: "c",
      clientSecret: "s",
      emails: ["alice@example.test"],
      domains: [],
    });
    let gateways: AccountGateways | undefined;
    const tokenReplies: string[] = [];
    const connections = new AppConnections({
      ...accountAppStores(store),
      storeFor: async (id) => {
        const account = (await store.allAccounts()).find((a) => a.id === id);
        if (!account || !gateways) throw new Error("no such account");
        return (await gateways.gateway(account)).store;
      },
      origin,
      env: { BOTT_GITHUB_CLIENT_ID: "gh-id", BOTT_GITHUB_CLIENT_SECRET: "gh-secret" },
      fetch: async (input) => {
        tokenReplies.push(String(input));
        return new Response(JSON.stringify({ access_token: "gh-token", token_type: "bearer" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    const apps = connectedApps(connections);
    gateways = new AccountGateways({
      store,
      login,
      stateDir: root,
      hosted: true,
      db,
      policy: "auto",
      model: "m",
      idleSeconds: 60,
      fixed: () => gated([]),
      apps,
    });
    const live = gateways;
    cleanups.push(() => live.close());
    const handler = createApp({
      auth: {
        mode: "google",
        login,
        models: new AccountModels(store),
        gateway: (account) => live.gateway(account),
      },
      apps,
    });
    const send = (path: string, init: RequestInit = {}) =>
      handler(
        new Request(`${origin}${path}`, {
          ...init,
          headers: { host: "localhost:8765", cookie: `gateway_session=${token}`, ...init.headers },
        }),
      );

    const account = (await store.session(token)) as NonNullable<
      Awaited<ReturnType<typeof store.session>>
    >;
    const gateway = await live.gateway(account);
    expect(gateway.sessions.apps).toBeInstanceOf(BotApps);
    const bot = (await gateway.store.bots())[0];
    if (!bot) throw new Error("no bot");

    const refused = await send(`/api/apps/github/bots/${bot.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ enabled: true }),
    });
    expect(refused.status).toBe(409);

    const started = await send("/api/apps/github/connect", { method: "POST", headers: { origin } });
    expect(started.status).toBe(200);
    const link = new URL(((await started.json()) as { url: string }).url);
    expect(link.searchParams.get("redirect_uri")).toBe(`${origin}/auth/apps/github/callback`);
    const state = link.searchParams.get("state") as string;

    const back = await send(`/auth/apps/github/callback?state=${state}&code=abc`);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe("/?apps=1");
    expect(tokenReplies).toEqual(["https://github.com/login/oauth/access_token"]);
    const again = await send(`/auth/apps/github/callback?state=${state}&code=abc`);
    expect(again.status).toBe(400);

    const granted = await send(`/api/apps/github/bots/${bot.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ enabled: true }),
    });
    expect(await granted.json()).toEqual({ enabled: true });
    expect(await gateway.sessions.apps?.enabled(bot.id)).toEqual(["github"]);

    const listed = (await (await send("/api/apps")).json()) as { id: string; connected: boolean }[];
    expect(listed.find((app) => app.id === "github")?.connected).toBe(true);
  });
});
