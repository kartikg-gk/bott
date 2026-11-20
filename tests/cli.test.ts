import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type Io, main } from "../src/cli.ts";
import { readConfig } from "../src/config.ts";
import { SqliteDatabase } from "../src/db/sqlite.ts";
import { Store, WEB_CHAT } from "../src/store/store.ts";
import { gated, reply } from "./web/support.ts";

const TOKEN = "a-token-long-enough-for-tests";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "cli-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function io(env: Record<string, string>, extra: Partial<Io> = {}) {
  const lines: string[] = [];
  const value: Io = {
    env,
    cwd: folder(),
    out: (line) => lines.push(line),
    ...extra,
  };
  return { io: value, lines, text: () => lines.join("\n") };
}

describe("the command line", () => {
  it("names only its own commands and refuses others", async () => {
    const help = io({});
    expect(await main([], help.io)).toBe(2);
    for (const command of ["init", "run", "runner", "doctor", "db check", "db import"]) {
      expect(help.text()).toContain(command);
    }
    const other = io({});
    expect(await main(["start"], other.io)).toBe(2);
    expect(other.text()).toMatch(/Unknown command: start/);
    expect(await main(["db", "migrate"], io({}).io)).toBe(2);
    expect(await main(["db"], io({}).io)).toBe(2);
  });

  it("reports a bad setting by name and stops", async () => {
    const run = io({ BOTT_PORT: "nope" });
    expect(await main(["doctor"], run.io)).toBe(1);
    expect(run.text()).toMatch(/BOTT_PORT/);
  });

  it("sets up a local server once and keeps what it made", async () => {
    const state = folder();
    const first = io({ BOTT_STATE_DIR: state });
    expect(await main(["init"], first.io)).toBe(0);
    const file = join(first.io.cwd, ".env");
    const saved = parseEnv(readFileSync(file, "utf8"));
    expect(saved.BOTT_WEB_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(saved.BOTT_MASTER_KEY).toMatch(/^[A-Za-z0-9_-]{43}=$/);
    expect(first.text()).not.toContain(saved.BOTT_WEB_TOKEN as string);

    const db = new SqliteDatabase(join(state, "gateway.sqlite3"));
    const store = await Store.open(db, readConfig({ BOTT_STATE_DIR: state }).instance);
    expect(await store.bots()).toHaveLength(1);
    await db.close();

    writeFileSync(file, `${readFileSync(file, "utf8")}BOTT_MODEL=kept\n`);
    const again = io({ BOTT_STATE_DIR: state }, { cwd: first.io.cwd });
    expect(await main(["init"], again.io)).toBe(0);
    const after = parseEnv(readFileSync(file, "utf8"));
    expect(after.BOTT_WEB_TOKEN).toBe(saved.BOTT_WEB_TOKEN);
    expect(after.BOTT_MASTER_KEY).toBe(saved.BOTT_MASTER_KEY);
    expect(after.BOTT_MODEL).toBe("kept");
  });

  it("will not set up a hosted server", async () => {
    const run = io({ BOTT_HOSTED: "1", BOTT_INSTANCE: "a".repeat(32) });
    expect(await main(["init"], run.io)).toBe(1);
    expect(run.text()).toMatch(/hosted/i);
    expect(existsSync(join(run.io.cwd, ".env"))).toBe(false);
  });

  it("checks the settings without creating anything", async () => {
    const state = folder();
    const fresh = io({ BOTT_STATE_DIR: state });
    expect(await main(["doctor"], fresh.io)).toBe(1);
    expect(fresh.text()).toMatch(/BOTT_WEB_TOKEN/);
    expect(fresh.text()).toMatch(/bott init/);
    expect(existsSync(join(state, "gateway.sqlite3"))).toBe(false);

    const ready = {
      BOTT_STATE_DIR: state,
      BOTT_WEB_TOKEN: TOKEN,
      BOTT_PROVIDER: "openai",
      BOTT_MODEL: "m",
      OPENAI_API_KEY: "sk-test",
    };
    expect(await main(["init"], io(ready).io)).toBe(0);
    const checked = io(ready);
    expect(await main(["doctor"], checked.io)).toBe(0);
    expect(checked.text()).toMatch(/SQLite: answers, schema gateway-21/);
  });

  it("serves the page until it is told to stop", async () => {
    const stop = new AbortController();
    const run = io(
      { BOTT_STATE_DIR: folder(), BOTT_WEB_TOKEN: TOKEN, BOTT_PORT: "0" },
      { signal: stop.signal },
    );
    const finished = main(["run"], run.io);
    let address: string | undefined;
    for (let tries = 0; tries < 200 && !address; tries++) {
      address = /Serving on (http:\/\/\S+)/.exec(run.text())?.[1];
      if (!address) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!address) throw new Error(`the server did not start: ${run.text()}`);
    const session = await fetch(`${address}/auth/session`);
    expect(await session.json()).toEqual({ mode: "bearer", email: null });
    stop.abort();
    expect(await finished).toBe(0);
  });

  it("runs the jobs that are due once and lets the next runner in", async () => {
    const state = folder();
    const env = { BOTT_STATE_DIR: state, BOTT_WEB_TOKEN: TOKEN };
    expect(await main(["init"], io(env).io)).toBe(0);
    const db = new SqliteDatabase(join(state, "gateway.sqlite3"));
    const store = await Store.open(db, readConfig(env).instance);
    const chief = await store.chief();
    const route = await store.conversation(WEB_CHAT, 1);
    const job = await store.addJob({
      chat: route.chat,
      user: route.user,
      actor: 1,
      thread: route.thread,
      bot: chief.id,
      task: "say hello",
      spec: "every:3600",
      first: 1,
    });
    const providers = () => gated([reply("hello from the job")]);
    expect(await main(["runner", "--once"], io(env, { providers }).io)).toBe(0);
    const done = await store.job(job);
    expect(done?.lastStatus).toBe("completed");
    expect(done?.lastAnswer).toContain("hello from the job");
    expect(await main(["runner", "--once"], io(env, { providers }).io)).toBe(0);
    await db.close();
  });

  it("checks the database without making one", async () => {
    const state = folder();
    const missing = io({ BOTT_STATE_DIR: state });
    expect(await main(["db", "check"], missing.io)).toBe(1);
    expect(missing.text()).toMatch(/SQLite: no database at/);
    expect(existsSync(join(state, "gateway.sqlite3"))).toBe(false);
    expect(await main(["init"], io({ BOTT_STATE_DIR: state }).io)).toBe(0);
    const found = io({ BOTT_STATE_DIR: state });
    expect(await main(["db", "check"], found.io)).toBe(0);
    expect(found.text()).toBe("SQLite: answers, schema gateway-21 (this build expects gateway-21)");
  });

  it("imports only into D1", async () => {
    const run = io({ BOTT_STATE_DIR: folder() });
    expect(await main(["db", "import", "--from", "old.sqlite3"], run.io)).toBe(1);
    expect(run.text()).toMatch(/CLOUDFLARE_D1_DATABASE_ID/);
  });
});
