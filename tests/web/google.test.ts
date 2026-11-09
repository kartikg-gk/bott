import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleLogin } from "../../src/accounts/google.ts";
import { AccountModels } from "../../src/accounts/models.ts";
import { AccountStore } from "../../src/accounts/store.ts";
import type { ModelProvider } from "../../src/agent/providers/types.ts";
import type { Database } from "../../src/db/database.ts";
import { ensureSchema } from "../../src/db/schema.ts";
import type { LimitsConfig } from "../../src/limits/limits.ts";
import { AccountGateways } from "../../src/web/accounts.ts";
import { createApp } from "../../src/web/app.ts";
import { KEY } from "../support/accounts.ts";
import { backends, database } from "../support/fakeD1.ts";
import { Gate, gated, readEvents, reply, toolCall } from "./support.ts";

const ORIGIN = "http://localhost:8765";
const SECRET = "s".repeat(43);

describe.each(backends)("%s backend", (kind) => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function setup(
    provider: ModelProvider | null,
    opts: { proxySecret?: string; limits?: Partial<LimitsConfig> } = {},
  ) {
    const { db } = database(kind);
    cleanups.push(() => db.close());
    const root = mkdtempSync(join(tmpdir(), "google-web-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    // Daily counts live in the gateway's own tables.
    await ensureSchema(db);
    const store = await AccountStore.open(db, "realm", KEY);
    const login = new GoogleLogin(store, {
      origin: ORIGIN,
      clientId: "client",
      clientSecret: "secret",
      emails: ["alice@example.test", "bob@example.test"],
      domains: [],
    });
    const gateways = new AccountGateways({
      store,
      login,
      stateDir: root,
      hosted: kind === "d1",
      db: db as Database,
      policy: "auto",
      model: "m",
      idleSeconds: 60,
      ...(provider ? { fixed: () => provider } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
    });
    cleanups.push(() => gateways.close());
    const models = new AccountModels(store, { busy: (id) => gateways.busy(id) });
    const handler = createApp({
      auth: { mode: "google", login, models, gateway: (account) => gateways.gateway(account) },
      proxySecret: opts.proxySecret,
      page: "<html>page</html>",
    });
    const session = async (name: string) =>
      store.signIn(`${name}-subject`, `${name}@example.test`, null);
    const call = (
      path: string,
      init: RequestInit & { json?: unknown; token?: string; origin?: boolean } = {},
    ) => {
      const headers = new Headers(init.headers);
      if (!headers.has("host")) headers.set("host", "localhost:8765");
      if (init.token) headers.set("cookie", `gateway_session=${init.token}`);
      if (init.origin ?? (init.method && init.method !== "GET")) headers.set("origin", ORIGIN);
      const { json, token: _t, origin: _o, ...rest } = init;
      return handler(
        new Request(`${ORIGIN}${path}`, {
          ...rest,
          headers,
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        }),
      );
    };
    return { store, gateways, session, call };
  }

  it("asks for sign-in before the API and says who is signed in", async () => {
    const { session, call } = await setup(gated([]));
    expect((await call("/")).status).toBe(200);
    expect(await (await call("/auth/session")).json()).toEqual({ mode: "google", email: null });
    expect((await call("/api/runs")).status).toBe(401);
    const token = await session("alice");
    expect(await (await call("/auth/session", { token })).json()).toEqual({
      mode: "google",
      email: "alice@example.test",
    });
    expect((await call("/api/runs", { token })).status).toBe(200);
  });

  it("refuses other hosts and writes from other origins", async () => {
    const { session, call } = await setup(gated([]));
    const token = await session("alice");
    expect((await call("/api/runs", { token, headers: { host: "evil.test" } })).status).toBe(403);
    const noOrigin = await call("/api/runs", {
      token,
      method: "POST",
      origin: false,
      json: { text: "x" },
    });
    expect(noOrigin.status).toBe(403);
  });

  it("gives each account its own gateway and keeps their runs apart", async () => {
    const { session, call, gateways } = await setup(gated([reply("for alice")]));
    const alice = await session("alice");
    const bob = await session("bob");
    const created = await call("/api/runs", { token: alice, method: "POST", json: { text: "hi" } });
    expect(created.status).toBe(202);
    const { id } = (await created.json()) as { id: string };
    expect((await call(`/api/runs/${id}`, { token: bob })).status).toBe(404);
    const records = await readEvents(await call(`/api/runs/${id}/events`, { token: alice }), (r) =>
      r.some((e) => e.type === "run_finished"),
    );
    expect(records.at(-1)).toMatchObject({ answer: "for alice" });
    expect(gateways.runtimes.all()).toHaveLength(2);
    expect(await (await call("/api/account/model", { token: alice })).json()).toEqual({
      provider: null,
      model: null,
      keys: [],
    });
  });

  it("waits for a model choice when accounts bring their own", async () => {
    const { session, call } = await setup(null);
    const token = await session("alice");
    const refused = await call("/api/messages", { token, method: "POST", json: { text: "hi" } });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toMatch(/model/);
  });

  it("ends a run's stream once the person signs out", async () => {
    const gate = new Gate();
    const { session, call, store } = await setup(gated([reply("late")], { 0: gate }));
    const token = await session("alice");
    const { id } = (await (
      await call("/api/runs", { token, method: "POST", json: { text: "slow" } })
    ).json()) as { id: string };
    const stream = await call(`/api/runs/${id}/events`, { token });
    await gate.reached;
    await store.signOut(token);
    gate.release();
    const records = await readEvents(stream, () => false);
    expect(records.some((r) => r.type === "run_finished")).toBe(false);
  });

  it("holds each run to the per-run request limit", async () => {
    const provider = gated([toolCall("Read", { path: "a.txt" }), reply("never reached")]);
    const { session, call } = await setup(provider, { limits: { requestsPerRun: 1 } });
    const token = await session("alice");
    const { id } = (await (
      await call("/api/runs", { token, method: "POST", json: { text: "two calls" } })
    ).json()) as { id: string };
    const records = await readEvents(await call(`/api/runs/${id}/events`, { token }), (r) =>
      r.some((e) => e.type === "run_finished"),
    );
    expect(records.at(-1)).toMatchObject({ status: "failed" });
    expect(String(records.at(-1)?.answer)).toMatch(/limit/);
    expect(provider.requests).toHaveLength(1);
  });

  it("takes requests only through the trusted proxy when a secret is set", async () => {
    const { session, call } = await setup(gated([]), { proxySecret: SECRET });
    const token = await session("alice");
    expect((await call("/api/runs", { token })).status).toBe(403);
    expect((await call("/api/runs", { token, headers: { "x-bott-proxy": "wrong" } })).status).toBe(
      403,
    );
    const doubled = new Headers({ "x-bott-proxy": SECRET });
    doubled.append("x-bott-proxy", SECRET);
    expect((await call("/api/runs", { token, headers: doubled })).status).toBe(403);
    // Behind the proxy the host may be rewritten.
    const through = await call("/api/runs", {
      token,
      headers: { "x-bott-proxy": SECRET, host: "internal:3000" },
    });
    expect(through.status).toBe(200);
  });
});

it("refuses a proxy secret that is too weak", () => {
  expect(() =>
    createApp({
      auth: { mode: "token", token: "t".repeat(20), gateway: {} as never },
      proxySecret: "short",
    }),
  ).toThrow(/43 to 128/);
});
