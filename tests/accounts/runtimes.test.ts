import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AccountRuntime, AccountRuntimes } from "../../src/accounts/runtimes.ts";
import { AccountStore } from "../../src/accounts/store.ts";
import type { ModelProvider } from "../../src/agent/providers/types.ts";
import type { Bot } from "../../src/bots/bots.ts";
import type { Profile } from "../../src/bots/profiles.ts";
import type { Database } from "../../src/db/database.ts";
import { ensureSchema } from "../../src/db/schema.ts";
import { KEY } from "../support/accounts.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

const bot = { id: "chief" } as Bot;
const profile = {} as Profile;

async function firstRequest(provider: ModelProvider) {
  for await (const _ of provider.stream({
    model: "ignored",
    system: "",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    signal: new AbortController().signal,
  })) {
    // Each request is refused; only what was sent matters here.
  }
}

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function fresh(opts: { hosted?: boolean; allowed?: string[] } = {}) {
    const { db } = database(kind);
    open.push(db);
    await ensureSchema(db);
    const stateDir = mkdtempSync(join(tmpdir(), "accounts-"));
    dirs.push(stateDir);
    const store = await AccountStore.open(db, "realm-1", KEY);
    const sent: { model: unknown; auth: string | null }[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = (await request.json()) as { model?: unknown };
      sent.push({ model: body.model, auth: request.headers.get("authorization") });
      return new Response("no", { status: 400 });
    };
    const created: AccountRuntime[] = [];
    const allowed = new Set(opts.allowed ?? ["alice@x.test", "bob@x.test"]);
    const runtimes = new AccountRuntimes({
      stateDir,
      hosted: opts.hosted ?? false,
      store,
      login: { permitted: (email) => allowed.has(email) },
      providerOptions: { fetch, retry: false },
      limits: { db, config: {} },
      create: async (runtime) => {
        created.push(runtime);
        return { runtime };
      },
    });
    const account = async (subject: string) =>
      (await store.session(await store.signIn(subject, `${subject}@x.test`, null))) as NonNullable<
        Awaited<ReturnType<AccountStore["session"]>>
      >;
    return { db, store, runtimes, stateDir, sent, created, account };
  }

  it("gives each account its own instance, folders and saved model", async () => {
    const { store, runtimes, stateDir, sent, account } = await fresh();
    const alice = await account("alice");
    const bob = await account("bob");
    await store.setModel(alice.id, "openai", "alice-model", "alice-key");
    await store.setModel(bob.id, "openrouter", "bob-model", "bob-key");
    const a = (await runtimes.get(alice)).runtime;
    const b = (await runtimes.get(bob)).runtime;
    expect(a.instance).toBe(alice.id);
    expect(a.stateDir).toBe(join(stateDir, "web-users", alice.id));
    expect(a.projectDir).toBe(join(a.stateDir, "workspace"));
    expect(a.sessionsDir).toBe(join(a.stateDir, "sessions"));
    expect(a.databasePath).toBe(join(a.stateDir, "gateway.sqlite3"));
    expect(existsSync(a.projectDir)).toBe(true);
    expect(b.projectDir).not.toBe(a.projectDir);
    await firstRequest(a.providers(bot, profile));
    await firstRequest(b.providers(bot, profile));
    expect(sent).toEqual([
      { model: "alice-model", auth: "Bearer alice-key" },
      { model: "bob-model", auth: "Bearer bob-key" },
    ]);
  });

  it("builds an account's runtime once", async () => {
    const { runtimes, created, account } = await fresh();
    const alice = await account("alice");
    const [first, second] = await Promise.all([runtimes.get(alice), runtimes.get(alice)]);
    expect(first).toBe(second);
    expect(created).toHaveLength(1);
    expect(runtimes.all()).toEqual([first]);
  });

  it("keeps transcripts in the database when hosted", async () => {
    const { runtimes, account } = await fresh({ hosted: true });
    expect((await runtimes.get(await account("alice"))).runtime.sessionsDir).toBeNull();
  });

  it("uses a fixed provider factory when one is given", async () => {
    const made = await fresh();
    const fixed = () => ({ id: "fixed", stream: async function* () {} }) as ModelProvider;
    const runtimes = new AccountRuntimes({
      stateDir: made.stateDir,
      hosted: false,
      store: made.store,
      login: { permitted: () => true },
      fixed,
      limits: { db: made.db, config: {} },
      create: (runtime) => runtime,
    });
    const runtime = await runtimes.get(await made.account("alice"));
    expect(runtime.providers(bot, profile).id).toBe("fixed");
  });

  it("reopens allowed accounts at start so their scheduled work can run", async () => {
    const { runtimes, created, account } = await fresh({ allowed: ["alice@x.test"] });
    const alice = await account("alice");
    await account("bob");
    await runtimes.start();
    expect(created.map((runtime) => runtime.instance)).toEqual([alice.id]);
  });

  it("refuses an account ID that is not a UUID", async () => {
    const { runtimes, account } = await fresh();
    const alice = await account("alice");
    await expect(runtimes.get({ ...alice, id: "../escape" })).rejects.toThrow("Invalid account ID");
  });
});

describe.each(backends)("%s backend, with limits", (kind: Backend) => {
  const open: Database[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("counts each account's requests under its own instance on the gateway database", async () => {
    const { db } = database(kind);
    open.push(db);
    await ensureSchema(db);
    const stateDir = mkdtempSync(join(tmpdir(), "accounts-"));
    dirs.push(stateDir);
    const store = await AccountStore.open(db, "realm-1", KEY);
    const sent: unknown[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      sent.push(((await new Request(input, init).json()) as { model?: unknown }).model);
      return new Response("no", { status: 400 });
    };
    const runtimes = new AccountRuntimes({
      stateDir,
      hosted: true,
      store,
      login: { permitted: () => true },
      providerOptions: { fetch, retry: false },
      limits: { db, config: { requestsPerDay: 1 } },
      create: (runtime) => runtime,
    });
    const signIn = async (subject: string) => {
      const account = await store.session(await store.signIn(subject, `${subject}@x.test`, null));
      if (!account) throw new Error("no account");
      await store.setModel(account.id, "openai", `${subject}-model`, `${subject}-key`);
      return runtimes.get(account);
    };
    const alice = await signIn("alice");
    const bob = await signIn("bob");
    await alice.limits.operation(() => firstRequest(alice.providers(bot, profile)));
    await expect(
      alice.limits.operation(() => firstRequest(alice.providers(bot, profile))),
    ).rejects.toThrow("The daily request limit is used up");
    await bob.limits.operation(() => firstRequest(bob.providers(bot, profile)));
    expect(sent).toEqual(["alice-model", "bob-model"]);
    const rows = await db.query("SELECT instance, count FROM model_requests ORDER BY instance");
    expect(rows.map((row) => [row.instance, Number(row.count)]).sort()).toEqual(
      [
        [alice.instance, 1],
        [bob.instance, 1],
      ].sort(),
    );
  });

  it("meters a fixed provider factory too", async () => {
    const { db } = database(kind);
    open.push(db);
    await ensureSchema(db);
    const stateDir = mkdtempSync(join(tmpdir(), "accounts-"));
    dirs.push(stateDir);
    const store = await AccountStore.open(db, "realm-1", KEY);
    const fixed = (): ModelProvider => ({ id: "fixed", stream: async function* () {} });
    const runtimes = new AccountRuntimes({
      stateDir,
      hosted: true,
      store,
      login: { permitted: () => true },
      fixed,
      limits: { db, config: { requestsPerRun: 1 } },
      create: (runtime) => runtime,
    });
    const account = await store.session(await store.signIn("alice", "alice@x.test", null));
    const runtime = await runtimes.get(account as NonNullable<typeof account>);
    await expect(
      runtime.limits.operation(async () => {
        await firstRequest(runtime.providers(bot, profile));
        await firstRequest(runtime.providers(bot, profile));
      }),
    ).rejects.toThrow("The request limit for this run is used up.");
  });
});
