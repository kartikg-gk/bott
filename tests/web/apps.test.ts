import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GoogleLogin } from "../../src/accounts/google.ts";
import { AccountModels } from "../../src/accounts/models.ts";
import { AccountStore, VALIDATION_LIMIT } from "../../src/accounts/store.ts";
import { ensureSchema } from "../../src/db/schema.ts";
import { AccountGateways } from "../../src/web/accounts.ts";
import { createApp } from "../../src/web/app.ts";
import { type AppsSeam, accountAppStores } from "../../src/web/apps.ts";
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
});
