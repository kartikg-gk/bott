import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  associatedData,
  MASTER_KEY_VARIABLE,
  masterKey,
  SealError,
} from "../../src/accounts/sealing.ts";
import { AccountStore, VALIDATION_LIMIT } from "../../src/accounts/store.ts";
import type { Database } from "../../src/db/database.ts";
import { SqliteDatabase } from "../../src/db/sqlite.ts";
import { KEY } from "../support/accounts.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/sealed-accounts.sqlite3", import.meta.url));

describe("master key", () => {
  it("reads 32 bytes of base64 from the environment", () => {
    expect(masterKey({ [MASTER_KEY_VARIABLE]: KEY })).toHaveLength(32);
    expect(masterKey({ [MASTER_KEY_VARIABLE]: Buffer.alloc(32, 7).toString("base64") })).toEqual(
      Buffer.alloc(32, 7),
    );
  });

  it.each([undefined, "", "short", Buffer.alloc(31).toString("base64"), `${KEY.slice(0, -1)}`])(
    "refuses %s",
    (value) => {
      expect(() => masterKey({ [MASTER_KEY_VARIABLE]: value })).toThrow(
        "BOTT_MASTER_KEY must encode 32 random bytes as base64",
      );
    },
  );

  it("binds sealed values to realm, account, kind and name in one fixed layout", () => {
    expect(new TextDecoder().decode(associatedData("r", "a", "model", 'open"ai'))).toBe(
      '["r", "a", "model", "open\\"ai"]',
    );
    expect(new TextDecoder().decode(associatedData("é", "a", "k", "\u007f"))).toBe(
      '["\\u00e9", "a", "k", "\\u007f"]',
    );
  });
});

describe("rows sealed earlier", () => {
  it("open in a file written by the earlier gateway", async () => {
    const db = new SqliteDatabase(":memory:");
    await db.run(`ATTACH DATABASE '${FIXTURE.replaceAll("'", "''")}' AS old`);
    const store = await AccountStore.open(db, "realm-fixture", KEY);
    const [row] = await db.query("SELECT id FROM old.accounts");
    for (const table of ["accounts", "credentials"]) {
      await db.run(`INSERT INTO ${table} SELECT * FROM old.${table}`);
    }
    const account = String(row?.id);
    expect(await store.account(account)).toMatchObject({
      email: "owner@example.test",
      provider: "anthropic",
      model: "fixture-model",
    });
    expect(await store.credential(account, "model", "anthropic")).toBe("sk-fixture-sealed-key");
    expect(JSON.parse(String(await store.credential(account, "app", "github")))).toEqual({
      access_token: "gh-fixture",
    });
    const wrongRealm = await AccountStore.open(db, "another-realm", KEY);
    await expect(wrongRealm.credential(account, "model", "anthropic")).rejects.toThrow(SealError);
    await db.close();
  });
});

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  let now = 1_800_000_000;
  const clock = () => now;
  afterEach(async () => {
    await Promise.all(open.splice(0).map((db) => db.close()));
  });

  async function fresh(): Promise<{ store: AccountStore; db: Database }> {
    const { db } = database(kind);
    open.push(db);
    now = 1_800_000_000;
    return { store: await AccountStore.open(db, "realm-1", KEY, { clock }), db };
  }

  async function signedIn(store: AccountStore, subject: string): Promise<string> {
    const token = await store.signIn(subject, `${subject}@example.com`, null);
    return String((await store.session(token))?.id);
  }

  it("creates the account tables with their earlier columns and can open twice", async () => {
    const { db } = await fresh();
    await AccountStore.open(db, "realm-1", KEY);
    const columns = async (table: string) =>
      (await db.query(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)).map(
        (row) => row.name,
      );
    expect(await columns("accounts")).toEqual([
      "id",
      "subject",
      "email",
      "domain",
      "provider",
      "model",
    ]);
    expect(await columns("flows")).toEqual(["state", "browser", "verifier", "nonce", "expires"]);
    expect(await columns("app_flows")).toEqual([
      "account",
      "app",
      "session",
      "state",
      "verifier",
      "expires",
    ]);
    expect(await columns("sessions")).toEqual(["token", "account", "expires"]);
    expect(await columns("credentials")).toEqual(["account", "kind", "name", "sealed"]);
    expect(await columns("attempts")).toEqual(["account", "attempted"]);
  });

  it("a sign-in flow is used once and only by its browser", async () => {
    const { store, db } = await fresh();
    await store.startFlow("s".repeat(43), "b".repeat(43), "verifier", "nonce");
    expect(await store.consumeFlow("s".repeat(43), "x".repeat(43))).toBeNull();
    expect(await store.consumeFlow("s".repeat(43), "b".repeat(43))).toEqual({
      verifier: "verifier",
      nonce: "nonce",
    });
    expect(await store.consumeFlow("s".repeat(43), "b".repeat(43))).toBeNull();
    const [row] = await db.query("SELECT count(*) AS n FROM flows");
    expect(Number(row?.n)).toBe(0);
  });

  it("a flow expires after ten minutes and a browser keeps one flow", async () => {
    const { store, db } = await fresh();
    await store.startFlow("s".repeat(43), "b".repeat(43), "v1", "n1");
    await store.startFlow("t".repeat(43), "b".repeat(43), "v2", "n2");
    expect(await store.consumeFlow("s".repeat(43), "b".repeat(43))).toBeNull();
    now += 601;
    expect(await store.consumeFlow("t".repeat(43), "b".repeat(43))).toBeNull();
    await store.startFlow("u".repeat(43), "c".repeat(43), "v3", "n3");
    const [row] = await db.query("SELECT count(*) AS n FROM flows");
    expect(Number(row?.n)).toBe(1);
  });

  it("refuses new flows past the cap", async () => {
    const { store, db } = await fresh();
    for (let i = 0; i < 1024; i++) {
      await db.run("INSERT INTO flows VALUES(?,?,?,?,?)", [
        new Uint8Array([i >> 8, i & 255, 1]),
        new Uint8Array([i >> 8, i & 255, 2]),
        "v",
        "n",
        now + 600,
      ]);
    }
    await expect(store.startFlow("s".repeat(43), "b".repeat(43), "v", "n")).rejects.toThrow(
      "Sign-in is handling other requests; retry in a moment.",
    );
  });

  it("signs in, finds the session and signs out", async () => {
    const { store, db } = await fresh();
    const token = await store.signIn("subject-1", "a@example.com", "example.com");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const account = await store.session(token);
    expect(account).toMatchObject({
      subject: "subject-1",
      email: "a@example.com",
      domain: "example.com",
    });
    expect(String(account?.id)).toMatch(/^[0-9a-f]{32}$/);
    const [saved] = await db.query("SELECT token FROM sessions");
    expect(saved?.token).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(saved?.token as Uint8Array).toString()).not.toContain(token);
    expect(await store.session(`${token}x`)).toBeNull();
    expect(await store.session(null)).toBeNull();
    await store.signOut(token);
    expect(await store.session(token)).toBeNull();
  });

  it("a second sign-in keeps the account and updates its email", async () => {
    const { store } = await fresh();
    const first = await store.session(await store.signIn("subject-1", "a@example.com", null));
    const second = await store.session(await store.signIn("subject-1", "b@example.com", "x.test"));
    expect(second?.id).toBe(first?.id);
    expect(second).toMatchObject({ email: "b@example.com", domain: "x.test" });
    expect(await store.allAccounts()).toHaveLength(1);
  });

  it("sessions end after twelve hours", async () => {
    const { store } = await fresh();
    const token = await store.signIn("subject-1", "a@example.com", null);
    now += 12 * 3600 - 1;
    expect(await store.session(token)).not.toBeNull();
    now += 1;
    expect(await store.session(token)).toBeNull();
  });

  it("sealed credentials are bound to their account", async () => {
    const { store, db } = await fresh();
    const first = await signedIn(store, "s1");
    const second = await signedIn(store, "s2");
    await store.setModel(first, "openai", "model-1", "secret-key");
    expect(await store.credential(first, "model", "openai")).toBe("secret-key");
    expect(await store.names(first, "model")).toEqual(["openai"]);
    expect(await store.account(first)).toMatchObject({ provider: "openai", model: "model-1" });
    const [row] = await db.query("SELECT sealed FROM credentials");
    const sealed = row?.sealed as Uint8Array;
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(sealed.length).toBe(12 + "secret-key".length + 16);
    expect(Buffer.from(sealed).toString()).not.toContain("secret-key");
    await db.run("INSERT INTO credentials VALUES(?,?,?,?)", [second, "model", "openai", sealed]);
    await expect(store.credential(second, "model", "openai")).rejects.toThrow(SealError);
    expect(await store.credential(first, "model", "anthropic")).toBeNull();
  });

  it("removing a model key clears the selection only for that provider", async () => {
    const { store } = await fresh();
    const account = await signedIn(store, "s1");
    await store.setModel(account, "openai", "m1", "k1");
    await store.setModel(account, "anthropic", "m2", "k2");
    await store.removeModelKey(account, "openai");
    expect(await store.account(account)).toMatchObject({ provider: "anthropic", model: "m2" });
    await store.removeModelKey(account, "anthropic");
    expect(await store.account(account)).toMatchObject({ provider: null, model: null });
    expect(await store.names(account, "model")).toEqual([]);
  });

  it("app flows are used once and removed with the app", async () => {
    const { store } = await fresh();
    const account = await signedIn(store, "s1");
    await store.putCredential(account, "app", "github", "token");
    await store.startAppFlow(account, "github", "session", "state", "verifier");
    expect(await store.consumeAppFlow(account, "github", "other", "state")).toBeNull();
    expect(await store.consumeAppFlow(account, "github", "session", "state")).toBe("verifier");
    expect(await store.consumeAppFlow(account, "github", "session", "state")).toBeNull();
    await store.startAppFlow(account, "github", "session", "state", "verifier");
    await store.removeApp(account, "github");
    expect(await store.consumeAppFlow(account, "github", "session", "state")).toBeNull();
    expect(await store.credential(account, "app", "github")).toBeNull();
  });

  it("validation attempts are capped per account in a rolling window", async () => {
    const { store } = await fresh();
    const account = await signedIn(store, "s1");
    const other = await signedIn(store, "s2");
    const results = [];
    for (let i = 0; i < VALIDATION_LIMIT; i++)
      results.push(await store.validationAttempt(account, 1000));
    expect(results.every(Boolean)).toBe(true);
    expect(await store.validationAttempt(account, 1000)).toBe(false);
    expect(await store.validationAttempt(other, 1000)).toBe(true);
    expect(await store.validationAttempt(account, 1299)).toBe(false);
    expect(await store.validationAttempt(account, 1300)).toBe(true);
  });
});
