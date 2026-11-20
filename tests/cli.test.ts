import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("runs one task with a bot and prints the answer and what it used", async () => {
    const state = folder();
    const env = { BOTT_STATE_DIR: state, BOTT_WEB_TOKEN: TOKEN };
    expect(await main(["init"], io(env).io)).toBe(0);
    const usage = { input: 12, output: 3, cacheRead: 0, cacheWrite: 0 };
    const providers = () => gated([reply("all tidy", usage as never)]);
    const plain = io(env, { providers });
    expect(await main(["task", "tidy the notes"], plain.io)).toBe(0);
    expect(plain.lines[0]).toBe("all tidy");
    expect(plain.text()).toMatch(/completed \| input 12 \| output 3/);

    const asJson = io(env, { providers: () => gated([reply("done")]) });
    expect(await main(["task", "again", "--json"], asJson.io)).toBe(0);
    expect(JSON.parse(asJson.lines[0] as string)).toMatchObject({
      status: "completed",
      answer: "done",
      usage: { model_messages: 1 },
    });

    const piped = io(env, {
      providers: () => gated([reply("read it")]),
      stdin: async () => "from a pipe",
    });
    expect(await main(["task", "-"], piped.io)).toBe(0);
    expect(piped.lines[0]).toBe("read it");

    for (const args of [["task"], ["task", "/stop"], ["task", "x", "--bot", "Nobody"]]) {
      const refused = io(env, { providers });
      expect(await main(args, refused.io)).not.toBe(0);
    }
    const slow = io(env, { providers });
    expect(await main(["task", "x", "--deadline", "0"], slow.io)).toBe(1);
    expect(slow.text()).toMatch(/deadline/);
  });

  it("lists, adds and removes skill folders, shared or for one bot", async () => {
    const state = folder();
    const env = { BOTT_STATE_DIR: state, BOTT_WEB_TOKEN: TOKEN };
    expect(await main(["init"], io(env).io)).toBe(0);
    const source = folder();
    const skill = join(source, "brew");
    mkdirSync(skill);
    writeFileSync(join(skill, "SKILL.md"), "---\nname: brew\ndescription: Make tea\n---\nBoil.\n");

    expect(await main(["skills", "add", skill], io(env).io)).toBe(0);
    expect(existsSync(join(state, "skills", "brew", "SKILL.md"))).toBe(true);
    const listed = io(env);
    expect(await main(["skills"], listed.io)).toBe(0);
    const shared = JSON.parse(listed.text()) as { name: string; managed: boolean }[];
    expect(shared).toContainEqual({ name: "brew", description: "Make tea", managed: true });

    const chief = io(env);
    expect(await main(["skills", "add", skill, "--bot", "Chief of Staff"], chief.io)).toBe(0);
    const forBot = io(env);
    expect(await main(["skills", "list", "--bot", "Chief of Staff"], forBot.io)).toBe(0);
    const names = (JSON.parse(forBot.text()) as { name: string }[]).map((s) => s.name);
    expect(names.filter((name) => name === "brew")).toHaveLength(1);

    expect(await main(["skills", "remove", "brew"], io(env).io)).toBe(0);
    expect(existsSync(join(state, "skills", "brew"))).toBe(false);
    expect(await main(["skills", "remove", "brew"], io(env).io)).toBe(1);
    expect(await main(["skills", "add"], io(env).io)).toBe(1);
    expect(await main(["skills", "list", "--bot", "Nobody"], io(env).io)).toBe(1);
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
    expect(found.text()).toBe(
      "SQLite answers; it holds schema gateway-21, and this build expects gateway-21",
    );
  });

  it("imports only into D1", async () => {
    const run = io({ BOTT_STATE_DIR: folder() });
    expect(await main(["db", "import", "--from", "old.sqlite3"], run.io)).toBe(1);
    expect(run.text()).toMatch(/CLOUDFLARE_D1_DATABASE_ID/);
  });

  it("moves every account only from the state folder, and only into D1", async () => {
    const local = io({ BOTT_STATE_DIR: folder() });
    expect(await main(["db", "import", "--accounts"], local.io)).toBe(1);
    expect(local.text()).toMatch(/CLOUDFLARE_D1_DATABASE_ID/);
    const d1 = {
      BOTT_STATE_DIR: folder(),
      CLOUDFLARE_API_TOKEN: "t",
      CLOUDFLARE_ACCOUNT_ID: "a",
      CLOUDFLARE_D1_DATABASE_ID: "d",
    };
    const both = io(d1);
    expect(await main(["db", "import", "--accounts", "--from", "x.sqlite3"], both.io)).toBe(1);
    expect(both.text()).toMatch(/leave out --from/);
    const check = io(d1);
    expect(await main(["db", "check", "--accounts"], check.io)).toBe(1);
    expect(check.text()).toMatch(/takes no --from or --accounts/);
    const help = io({});
    await main(["help"], help.io);
    expect(help.text()).toMatch(/db import --accounts/);
  });
});
