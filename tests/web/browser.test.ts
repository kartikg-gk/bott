import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleLogin } from "../../src/accounts/google.ts";
import { AccountModels } from "../../src/accounts/models.ts";
import { AccountStore } from "../../src/accounts/store.ts";
import type { ModelProvider } from "../../src/agent/providers/types.ts";
import { BrowserKeys } from "../../src/browser/keys.ts";
import { BrowserRegistry } from "../../src/browser/registry.ts";
import type { Database } from "../../src/db/database.ts";
import { ensureSchema } from "../../src/db/schema.ts";
import { AccountGateways } from "../../src/web/accounts.ts";
import { createApp } from "../../src/web/app.ts";
import { KEY } from "../support/accounts.ts";
import { fakeCdp } from "../support/fakeCdp.ts";
import { backends, database } from "../support/fakeD1.ts";
import { Gate, gated, readEvents, reply, toolCall } from "./support.ts";

const ORIGIN = "http://localhost:8765";
const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";
const CF_TOKEN = "cloudflare-token-for-tests";

describe.each(backends)("%s backend", (kind) => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(provider: ModelProvider) {
    const { db } = database(kind);
    cleanups.push(() => db.close());
    const root = mkdtempSync(join(tmpdir(), "browser-web-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    await ensureSchema(db);
    const store = await AccountStore.open(db, "realm", KEY);
    const login = new GoogleLogin(store, {
      origin: ORIGIN,
      clientId: "client",
      clientSecret: "secret",
      emails: ["alice@example.test", "bob@example.test"],
      domains: [],
    });
    const checks: string[] = [];
    const keys = new BrowserKeys(store, {
      fetch: async (input) => {
        checks.push(String(input));
        return new Response("[]", { status: 200 });
      },
    });
    const cdp = fakeCdp();
    const registry = new BrowserRegistry({ open: cdp.open, settleMs: 10 });
    cleanups.push(() => registry.closeAll());
    const gateways = new AccountGateways({
      store,
      login,
      stateDir: root,
      hosted: kind === "d1",
      db: db as Database,
      policy: "auto",
      model: "m",
      idleSeconds: 60,
      fixed: () => provider,
      browsers: { registry, keys },
    });
    cleanups.push(() => gateways.close());
    const handler = createApp({
      auth: {
        mode: "google",
        login,
        models: new AccountModels(store),
        browser: keys,
        gateway: (account) => gateways.gateway(account),
      },
    });
    const session = (name: string) => store.signIn(`${name}-s`, `${name}@example.test`, null);
    const call = (path: string, token: string, init: { method?: string; json?: unknown } = {}) => {
      const headers = new Headers({ host: "localhost:8765", cookie: `gateway_session=${token}` });
      if (init.method && init.method !== "GET") headers.set("origin", ORIGIN);
      return handler(
        new Request(`${ORIGIN}${path}`, {
          method: init.method ?? "GET",
          headers,
          ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        }),
      );
    };
    return { call, session, cdp, checks };
  }

  it("saves, shows and removes the account's Browser Run key", async () => {
    const { call, session, checks } = await setup(gated([]));
    const alice = await session("alice");
    expect(await (await call("/api/account/browser", alice)).json()).toEqual({
      saved: false,
      accountId: null,
    });
    const put = await call("/api/account/browser", alice, {
      method: "PUT",
      json: { accountId: CF_ACCOUNT, token: CF_TOKEN },
    });
    expect(put.status).toBe(200);
    const shown = await put.text();
    expect(JSON.parse(shown)).toEqual({ saved: true, accountId: CF_ACCOUNT });
    expect(shown).not.toContain(CF_TOKEN);
    expect(checks).toHaveLength(1);
    // Another account sees nothing of it.
    const bob = await session("bob");
    expect(await (await call("/api/account/browser", bob)).json()).toMatchObject({ saved: false });
    const removed = await call("/api/account/browser", alice, { method: "DELETE" });
    expect(await removed.json()).toEqual({ saved: false, accountId: null });
  });

  it("shows a running run's browser and closes it when the run ends", async () => {
    const gate = new Gate();
    const provider = gated(
      [toolCall("browser_open", { url: "https://a.test" }), reply("looked"), reply("unused")],
      { 1: gate },
    );
    const { call, session, cdp } = await setup(provider);
    const alice = await session("alice");
    await call("/api/account/browser", alice, {
      method: "PUT",
      json: { accountId: CF_ACCOUNT, token: CF_TOKEN },
    });
    const created = await call("/api/runs", alice, { method: "POST", json: { text: "look" } });
    const { id } = (await created.json()) as { id: string };
    await gate.reached;

    const view = await call(`/api/runs/${id}/browser`, alice);
    expect(view.status).toBe(200);
    expect(await view.json()).toEqual({
      engine: "kitesurf",
      image: { type: "image/jpeg", data: "SU1BR0U=" },
    });
    expect((await call(`/api/runs/${id}/browser?mode=sideways`, alice)).status).toBe(400);
    const bob = await session("bob");
    expect((await call(`/api/runs/${id}/browser`, bob)).status).toBe(404);

    gate.release();
    await readEvents(await call(`/api/runs/${id}/events`, alice), (r) =>
      r.some((e) => e.type === "run_finished"),
    );
    expect(cdp.browsers[0]?.closed).toBe(true);
    expect((await call(`/api/runs/${id}/browser`, alice)).status).toBe(404);
  });

  it("gives a Live View link for a Chromium browser", async () => {
    const gate = new Gate();
    const provider = gated(
      [toolCall("browser_open", { url: "https://a.test", engine: "chromium" }), reply("ok")],
      { 1: gate },
    );
    const { call, session } = await setup(provider);
    const alice = await session("alice");
    await call("/api/account/browser", alice, {
      method: "PUT",
      json: { accountId: CF_ACCOUNT, token: CF_TOKEN },
    });
    const created = await call("/api/runs", alice, { method: "POST", json: { text: "look" } });
    const { id } = (await created.json()) as { id: string };
    await gate.reached;
    const view = await call(`/api/runs/${id}/browser?mode=devtools`, alice);
    expect(await view.json()).toEqual({
      engine: "chromium",
      mode: "devtools",
      url: "https://live.example/view?mode=devtools",
      expiresInMs: 300_000,
    });
    gate.release();
    await readEvents(await call(`/api/runs/${id}/events`, alice), (r) =>
      r.some((e) => e.type === "run_finished"),
    );
  });
});
