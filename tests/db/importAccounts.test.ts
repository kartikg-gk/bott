import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccountStore, openAccountStore } from "../../src/accounts/store.ts";
import { ensureSchema } from "../../src/db/schema.ts";
import { SqliteDatabase } from "../../src/db/sqlite.ts";
import { type Count, importAccounts } from "../../src/db/transfer.ts";
import { Store, WEB_CHAT } from "../../src/store/store.ts";
import { KEY } from "../support/accounts.ts";
import { backends, database } from "../support/fakeD1.ts";

const REALM = "a".repeat(32);
const OTHER_KEY = `${Buffer.alloc(32, 7).toString("base64")}`;

describe.each(backends)("moving every local account into a %s target", (kind) => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function target() {
    const { db } = database(kind);
    cleanups.push(() => db.close());
    return db;
  }

  /**
   * A local Google-mode state folder: the account file with two people and a sealed model key,
   * each with their own database file, notes and a job, plus the shared file holding their
   * spend. A third person signed in but never opened a gateway.
   */
  async function local() {
    const stateDir = mkdtempSync(join(tmpdir(), "accounts-move-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    const opened = await openAccountStore({
      hosted: false,
      stateDir,
      realm: REALM,
      env: { BOTT_MASTER_KEY: KEY },
    });
    const people = [];
    for (const name of ["ana", "ben", "cai"]) {
      await opened.store.signIn(`subject-${name}`, `${name}@example.com`, "example.com");
    }
    const accounts = await opened.store.allAccounts();
    for (const account of accounts) {
      await opened.store.putCredential(account.id, "model", "openai", `key-of-${account.email}`);
    }
    await opened.close();

    const shared = new SqliteDatabase(join(stateDir, "gateway.sqlite3"));
    await ensureSchema(shared);
    for (const account of accounts.slice(0, 2)) {
      const folder = join(stateDir, "web-users", account.id);
      const db = new SqliteDatabase(join(folder, "gateway.sqlite3"));
      const store = await Store.open(db, account.id);
      const chief = (await store.chief()).id;
      const route = await store.conversation(WEB_CHAT, 1);
      const job = await store.addJob({
        chat: route.chat,
        user: route.user,
        actor: 1,
        thread: route.thread,
        bot: chief,
        task: `tidy ${account.email}`,
        spec: "every:3600",
        first: 5e9,
      });
      await db.run("INSERT INTO leases VALUES(?,'someone',9e9)", [`runner-${account.id}`]);
      // A session parked under the chief, pointing at the route by its id.
      await db.run("INSERT INTO route_bots(route,bot,session) VALUES(?,?,'parked')", [
        route.id,
        chief,
      ]);
      await db.close();
      const notes = join(folder, "bots", chief, "memory");
      mkdirSync(notes, { recursive: true });
      writeFileSync(join(notes, "PREFERENCES.md"), `Notes for ${account.email}`, "utf8");
      await shared.run("INSERT INTO model_spend VALUES(?,?,?)", [account.id, "2026-11-20", 1500]);
      people.push({ account, chief, job });
    }
    await shared.close();
    return { stateDir, accounts, people };
  }

  const quiet = () => {};

  function move(stateDir: string, db: ReturnType<typeof target>, out: (line: string) => void) {
    return importAccounts({
      stateDir,
      sharedFile: join(stateDir, "gateway.sqlite3"),
      realm: REALM,
      key: KEY,
      target: db,
      out,
    });
  }

  it("copies the accounts, their sealed keys and each account's own rows", async () => {
    const { stateDir, accounts, people } = await local();
    const db = target();
    await move(stateDir, db, quiet);

    const moved = await db.query("SELECT id,subject,email FROM accounts ORDER BY email");
    expect(moved).toEqual(accounts.map(({ id, subject, email }) => ({ id, subject, email })));
    // The same key and instance open the copied keys, so they were never unsealed on the way.
    const hosted = await AccountStore.open(db, REALM, KEY);
    for (const account of accounts) {
      expect(await hosted.credential(account.id, "model", "openai")).toBe(
        `key-of-${account.email}`,
      );
    }
    // Both files numbered their first job and route 1. The first keeps its ids; the second
    // gets ids of its own, and the rows pointing at its routes follow them.
    const [first, second] = people;
    const ids = async (instance: string) =>
      (await db.query("SELECT id FROM jobs WHERE instance=?", [instance])).map((row) => row.id);
    expect(await ids(first?.account.id as string)).toEqual([first?.job]);
    expect(Number((await ids(second?.account.id as string))[0])).toBeGreaterThan(2 ** 32);
    for (const { account, chief } of people) {
      expect(await db.query("SELECT bot,task FROM jobs WHERE instance=?", [account.id])).toEqual([
        { bot: chief, task: `tidy ${account.email}` },
      ]);
      const pointed = await db.query(
        "SELECT route_bots.bot FROM route_bots JOIN routes ON routes.id=route_bots.route " +
          "WHERE routes.instance=?",
        [account.id],
      );
      expect(pointed).toEqual([{ bot: chief }]);
      expect(
        await db.query("SELECT bot,file,content FROM bot_memory WHERE instance=?", [account.id]),
      ).toEqual([{ bot: chief, file: "PREFERENCES.md", content: `Notes for ${account.email}` }]);
      expect(
        await db.query("SELECT micros FROM model_spend WHERE instance=?", [account.id]),
      ).toEqual([{ micros: 1500 }]);
    }
    expect(await db.query("SELECT * FROM leases")).toEqual([]);
    expect(await db.query("SELECT * FROM sessions")).toEqual([]);
  });

  it("copies nothing the second time and says so per account", async () => {
    const { stateDir, people } = await local();
    const db = target();
    await move(stateDir, db, quiet);
    const lines: string[] = [];
    const counts = await move(stateDir, db, (line) => lines.push(line));
    const added = (count: Count | undefined) => count?.copied ?? 0;
    expect(added(counts.accounts.get("accounts"))).toBe(0);
    expect(added(counts.accounts.get("credentials"))).toBe(0);
    for (const tables of counts.instances.values()) {
      for (const [table, count] of tables) expect(added(count), table).toBe(0);
    }
    expect(lines).toContain("accounts: added 0, skipped 3 present before");
    expect(lines).toContain(`${people[0]?.account.email} (${people[0]?.account.id}):`);
    expect(lines).toContain("  jobs: added 0, skipped 1 present before");
  });

  it("refuses keys that this master key and instance cannot open, writing nothing", async () => {
    const { stateDir } = await local();
    const db = target();
    await expect(
      importAccounts({
        stateDir,
        sharedFile: join(stateDir, "gateway.sqlite3"),
        realm: "b".repeat(32),
        key: KEY,
        target: db,
        out: quiet,
      }),
    ).rejects.toThrow(/do not open with this BOTT_MASTER_KEY and BOTT_INSTANCE/);
    await expect(
      importAccounts({
        stateDir,
        sharedFile: join(stateDir, "gateway.sqlite3"),
        realm: REALM,
        key: `${OTHER_KEY}`,
        target: db,
        out: quiet,
      }),
    ).rejects.toThrow(/do not open/);
    expect(
      await db.query("SELECT name FROM sqlite_master WHERE name IN ('accounts','bots')"),
    ).toEqual([]);
  });

  it("refuses a target where someone has another account or an instance has other bots", async () => {
    const { stateDir, people } = await local();
    const taken = target();
    await ensureSchema(taken);
    const hosted = await AccountStore.open(taken, REALM, KEY);
    await hosted.signIn("subject-ben", "ben@example.com", "example.com");
    await expect(move(stateDir, taken, quiet)).rejects.toThrow(
      /ben@example.com already has another account in the target/,
    );
    expect(await taken.query("SELECT email FROM accounts")).toEqual([{ email: "ben@example.com" }]);

    const busy = target();
    await Store.open(busy, people[0]?.account.id as string);
    await expect(move(stateDir, busy, quiet)).rejects.toThrow(/already has bots in the target/);
    expect(await busy.query("SELECT name FROM sqlite_master WHERE name='accounts'")).toEqual([]);
  });

  it("refuses a state folder without an account file", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "accounts-move-"));
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }));
    await expect(move(stateDir, target(), quiet)).rejects.toThrow(/no local accounts/);
  });
});
