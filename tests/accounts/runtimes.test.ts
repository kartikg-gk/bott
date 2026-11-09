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
      create: async (runtime) => {
        created.push(runtime);
        return { runtime };
      },
    });
    const account = async (subject: string) =>
      (await store.session(await store.signIn(subject, `${subject}@x.test`, null))) as NonNullable<
        Awaited<ReturnType<AccountStore["session"]>>
      >;
    return { store, runtimes, stateDir, sent, created, account };
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
