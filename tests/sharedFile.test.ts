/**
 * A database file written by the gateway that ran before this one, opened here after the switch.
 * The file holds bots with profiles and notes, jobs in several states, inbox and routes,
 * approvals, tasks, delegations, web runs, memory facts, spend counts, and an account with
 * sealed credentials. Every check runs on a fresh copy, so the fixture never changes.
 */

import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccountStore } from "../src/accounts/store.ts";
import { AppConnections } from "../src/apps/connections.ts";
import { TelegramLinks } from "../src/apps/telegram.ts";
import { profile } from "../src/bots/profiles.ts";
import type { Database, Row } from "../src/db/database.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
import { SqliteDatabase } from "../src/db/sqlite.ts";
import { FactStore } from "../src/memory/facts.ts";
import { runRunner } from "../src/runner.ts";
import type { RuntimeConfig } from "../src/runtime/sessions.ts";
import { nextRun } from "../src/schedule/when.ts";
import { WEB_CHAT } from "../src/store/store.ts";
import { createApp } from "../src/web/app.ts";
import { Gateway } from "../src/web/gateway.ts";
import { upgradedCopy } from "./db/olderFile.ts";
import { KEY } from "./support/accounts.ts";
import { type Backend, backends, FakeD1 } from "./support/fakeD1.ts";
import { fakeProvider } from "./support/fakeProvider.ts";
import { MemorySink } from "./support/memorySink.ts";
import { reply } from "./web/support.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/shared-instance.sqlite3", import.meta.url));
const INSTANCE = "parity-home";
const REALM = "realm-parity";
const ACTOR = 1;
/** When the file was written: every row is stamped within a minute after this. */
const WRITTEN = 1_795_000_000;
const NOW = WRITTEN + 60;
const PROJECT = "/srv/bott/project";
const TOKEN = "a-token-long-enough-for-tests";
const TELEGRAM = `777:${"a".repeat(32)}`;

/** Tables the runner has no reason to touch; they must read the same before and after it. */
const SETTLED = [
  "bots",
  "bot_profiles",
  "bot_plugins",
  "bot_memory",
  "skill_files",
  "memory_facts",
  "accounts",
  "credentials",
  "model_requests",
  "model_spend",
  "web_runs",
  "web_run_events",
  "session_owners",
  "session_status",
  "job_event_receipts",
];

/**
 * The file as written, then copies of it stepped back to older schemas and upgraded here before
 * the same checks run, so an upgraded file must behave like one written at 21.
 */
const SOURCES = [SCHEMA_VERSION, 20, 13, 3, 1];

describe.each(SOURCES)("a database file written before the switch, from schema %i", (version) => {
  let source = FIXTURE;
  let upgradeFolder: string | null = null;
  beforeAll(async () => {
    if (version === SCHEMA_VERSION) return;
    upgradeFolder = mkdtempSync(join(tmpdir(), "shared-upgraded-"));
    source = await upgradedCopy(upgradeFolder, version);
  });
  afterAll(() => {
    if (upgradeFolder) rmSync(upgradeFolder, { recursive: true, force: true });
  });

  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  function folder(): string {
    const root = mkdtempSync(join(tmpdir(), "shared-file-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
  }

  /** A copy of the file, opened as it is, or loaded into a hosted database with the same rows. */
  function copy(kind: Backend = "sqlite"): { db: Database; root: string } {
    const root = folder();
    const path = join(root, "gateway.sqlite3");
    copyFileSync(source, path);
    if (kind === "sqlite") {
      const db = new SqliteDatabase(path);
      cleanups.unshift(() => db.close());
      return { db, root };
    }
    const fake = new FakeD1();
    const hosted = fake.connection;
    hosted.prepare("ATTACH DATABASE ? AS written").run(path);
    const made = hosted
      .prepare("SELECT type,name,sql FROM written.sqlite_master WHERE sql IS NOT NULL")
      .all() as { type: string; name: string; sql: string }[];
    for (const item of made.filter((m) => m.type === "table" && m.name !== "sqlite_sequence")) {
      hosted.exec(item.sql);
      hosted.exec(`INSERT INTO main.${item.name} SELECT * FROM written.${item.name}`);
    }
    for (const item of made.filter((m) => m.type === "index")) hosted.exec(item.sql);
    hosted.exec("DETACH DATABASE written");
    cleanups.push(() => {
      hosted.close();
    });
    return { db: fake.database(), root };
  }

  function runtime(root: string, hosted = false): RuntimeConfig {
    return {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: hosted ? null : join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
    };
  }

  async function gateway(db: Database, root: string, texts: string[] = [], hosted = false) {
    const provider = fakeProvider(texts.map((text) => reply(text)));
    const opened = await Gateway.open({
      db,
      instance: INSTANCE,
      runtime: runtime(root, hosted),
      providers: () => provider,
      clock: () => NOW,
      hosted,
    });
    cleanups.unshift(() => opened.close());
    const handler = createApp({ auth: { mode: "token", token: TOKEN, gateway: opened } });
    const get = async (path: string) => {
      const response = await handler(
        new Request(`http://127.0.0.1${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      );
      expect(response.status, path).toBe(200);
      return response.json();
    };
    return { gateway: opened, get };
  }

  async function botId(db: Database, name: string): Promise<string> {
    const rows = await db.query("SELECT id FROM bots WHERE instance=? AND name=?", [
      INSTANCE,
      name,
    ]);
    return String(rows[0]?.id);
  }

  async function snapshot(db: Database): Promise<Record<string, Row[]>> {
    const tables: Record<string, Row[]> = {};
    for (const table of SETTLED) tables[table] = await db.query(`SELECT * FROM ${table}`);
    return tables;
  }

  it("opens at the current schema without upgrading or recreating anything", async () => {
    const { db } = copy();
    const before = await db.query("SELECT name FROM sqlite_master ORDER BY name");
    const { gateway: opened } = await gateway(db, folder());
    expect((await db.query("PRAGMA user_version"))[0]?.user_version).toBe(SCHEMA_VERSION);
    expect(await db.query("SELECT name FROM sqlite_master ORDER BY name")).toEqual(
      expect.arrayContaining(before),
    );
    expect(await db.query("SELECT id FROM schema_migrations")).toEqual([
      { id: `gateway-${SCHEMA_VERSION}` },
    ]);
    expect((await opened.store.bots({ temporary: true })).filter((b) => b.chief)).toHaveLength(1);
  });

  it.each(backends)(
    "lists the bots with their profiles, grants and chat, hiding the temporary one (%s)",
    async (kind) => {
      const { db, root } = copy(kind);
      const { gateway: opened, get } = await gateway(db, root);
      const researcher = await botId(db, "Researcher");
      const bots = (await get("/api/bots")) as Record<string, unknown>[];
      expect(bots.map((b) => [b.name, b.chief, b.selected])).toEqual([
        ["Chief of Staff", true, true],
        ["Researcher", false, false],
        ["Writer", false, false],
      ]);
      expect(bots[1]).toMatchObject({
        role: "Finds and checks sources",
        instructions: "Cite every claim with a link.",
        style: "thoughtful",
        voice: "Calm and exact.",
        color: "#12ab34",
        shape: "diamond",
        greeting: "Hello, I check sources.",
      });
      expect(bots[2]).toMatchObject({
        style: "upbeat",
        voice: "",
        shape: "square",
        greeting: null,
      });
      expect(await profile(opened.store, researcher)).toMatchObject({ color: "#12ab34" });
      expect(await opened.store.pluginsFor(researcher)).toEqual(["github", "web_search"]);
      expect(await opened.store.pluginsFor(await botId(db, "Writer"))).toEqual(["gmail"]);
      expect(await get(`/api/bots/${researcher}/messages`)).toEqual([
        { role: "assistant", text: "Hello, I check sources." },
        { role: "user", text: "Find the tide tables for Goa." },
      ]);
      expect(await get("/api/bots/unread-counts")).toEqual({ [researcher]: 1 });
    },
  );

  it.each(backends)(
    "reads the notes and skills kept in the database by a hosted gateway (%s)",
    async (kind) => {
      const { db, root } = copy(kind);
      const { get } = await gateway(db, root, [], true);
      const researcher = await botId(db, "Researcher");
      expect(await get(`/api/bots/${researcher}/memory`)).toEqual({
        "PREFERENCES.md": "Prefers metric units.\n",
        "KNOWLEDGE.md": "The owner lives in Goa.\n",
      });
      const skill = (await get(`/api/bots/${researcher}/skills/tides`)) as {
        files: Record<string, string>;
      };
      expect(skill.files).toEqual({
        "SKILL.md":
          "---\nname: tides\ndescription: Reads tide tables\n---\nLook up the port first.\n",
        "data/ports.txt": "Panaji\nVasco\n",
      });
    },
  );

  it.each(backends)(
    "reads jobs with the statuses, last runs and next runs they were left with (%s)",
    async (kind) => {
      const { db, root } = copy(kind);
      const { gateway: opened, get } = await gateway(db, root);
      const listed = (await get("/api/jobs")) as { automation: boolean; jobs: Row[] };
      expect(listed.automation).toBe(true);
      const jobs = await opened.store.jobs({ history: true });
      const byTask = Object.fromEntries(jobs.map((job) => [job.task, job]));
      expect(jobs).toHaveLength(9);
      expect(byTask["Check the inbox."]).toMatchObject({
        spec: "every:3600",
        status: "active",
        running: false,
        nextRun: WRITTEN + 3624,
        lastStatus: null,
      });
      expect(byTask["Morning briefing."]).toMatchObject({ spec: "daily:07:30", status: "active" });
      expect(byTask["Water the plants reminder."]).toMatchObject({ status: "paused" });
      expect(byTask["Old reminder."]).toMatchObject({ status: "cancelled", nextRun: null });
      expect(byTask["Send the weekly summary."]).toMatchObject({
        spec: "once",
        status: "done",
        nextRun: null,
        lastStatus: "completed",
        lastAnswer: "Summary sent.",
      });
      const refreshed = byTask["Refresh the tide data."];
      expect(refreshed).toMatchObject({ status: "active", lastStatus: "failed", running: false });
      // The next run was worked out from the claim; the same rule gives the same time here.
      expect(refreshed?.nextRun).toBe(nextRun("every:1800", refreshed?.lastRun as number));
      expect(byTask["Thank the payer."]).toMatchObject({
        spec: "event:invoice.paid",
        nextRun: null,
      });
      expect(byTask["Stale check."]).toMatchObject({ missed: "skip" });
      // The page lists every job, ended ones included.
      expect(listed.jobs.map((job) => job.status).sort()).toEqual([
        "active",
        "active",
        "active",
        "active",
        "active",
        "active",
        "cancelled",
        "done",
        "paused",
      ]);
    },
  );

  it.each(backends)(
    "reads the inbox, approvals, tasks, delegations and web runs (%s)",
    async (kind) => {
      const { db, root } = copy(kind);
      const { gateway: opened, get } = await gateway(db, root);
      expect((await opened.store.items()).map((item) => [item.text, item.status])).toEqual([
        ["What is the weather tomorrow?", "pending"],
        ["And low tide?", "prompt"],
      ]);
      // Approval cards live with the run that asked; a stopped process leaves none to answer.
      expect(await get("/api/approvals")).toEqual([]);
      const decided = await db.query(
        "SELECT id,decision,source FROM approvals WHERE instance=? ORDER BY id",
        [INSTANCE],
      );
      expect(decided.map((row) => [row.id, row.decision, row.source])).toEqual([
        ["approval-1", "allowed", "web"],
        ["approval-2", "denied", "web"],
        ["approval-3", null, null],
      ]);
      expect((await opened.store.tasks()).map((t) => [t.goal, t.status, t.answer])).toEqual([
        ["Draft a thank-you note.", "running", null],
        ["Post the summary.", "failed", ""],
        ["Summarise the tide report.", "completed", "Tides are mild this week."],
      ]);
      const tasks = (await get("/api/tasks")) as Row[];
      expect(tasks.map((t) => [t.status, t.bot])).toEqual([
        ["running", "Writer"],
        ["failed", "Writer"],
        ["completed", "Researcher"],
      ]);
      const delegations = await db.query(
        "SELECT task,status,answer FROM delegations WHERE instance=? ORDER BY id",
        [INSTANCE],
      );
      expect(delegations).toEqual([
        { task: "Check the ferry times.", status: "completed", answer: "Ferries run hourly." },
        { task: "Write a long essay.", status: "timed_out", answer: "" },
      ]);
      const recent = (await get("/api/runs?recent=1")) as Row[];
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({
        status: "completed",
        answer: "High tide at Panaji is at 06:40.",
        finished: WRITTEN + 14,
        usage: { requests: 2, input: 120, output: 80 },
      });
      const active = (await get("/api/runs")) as Row[];
      expect(active.map((run) => run.status)).toEqual(["queued"]);
      const activity = (await get(`/api/runs/${recent[0]?.id}/activity`)) as Row[];
      expect(activity.map((event) => [event.type, event.tool, event.failed])).toEqual([
        ["tool_started", "web_search", false],
        ["tool_finished", "web_search", false],
      ]);
    },
  );

  it.each(backends)(
    "carries on with the messages and web run that were still waiting (%s)",
    async (kind) => {
      const { db, root } = copy(kind);
      const provider = fakeProvider([reply("Sunny."), reply("Low tide is at 12:50.")]);
      const opened = await Gateway.open({
        db,
        instance: INSTANCE,
        runtime: runtime(root, true),
        providers: () => provider,
        clock: () => NOW,
        hosted: true,
      });
      cleanups.unshift(() => opened.close());
      expect(await opened.dispatcher.tick()).toBe(2);
      await opened.dispatcher.idle();
      const queued = await db.query(
        "SELECT r.id,i.status FROM web_runs r JOIN inbox i ON i.instance=r.instance " +
          "AND i.id=r.inbox WHERE r.instance=? AND i.text='And low tide?'",
        [INSTANCE],
      );
      expect(queued[0]?.status).toBe("completed");
      const run = await opened.journal.get(String(queued[0]?.id), ACTOR);
      expect(run).toMatchObject({ status: "completed", answer: "Low tide is at 12:50." });
      const kinds = (await opened.journal.events(String(queued[0]?.id), 0)).map((e) => e.kind);
      expect(kinds[0]).toBe("run_queued");
      expect(kinds).toContain("run_started");
      expect(kinds.at(-1)).toBe("run_finished");
      // The earlier messages the browser sent were used once and are gone.
      expect(await db.query("SELECT * FROM run_context")).toEqual([]);
      const asked = provider.requests.map((request) => JSON.stringify(request.messages));
      expect(asked.some((text) => text.includes("Find tide tables."))).toBe(true);
      const pending = await db.query("SELECT status FROM inbox WHERE instance=? AND text=?", [
        INSTANCE,
        "What is the weather tomorrow?",
      ]);
      expect(pending).toEqual([{ status: "completed" }]);
    },
  );

  it.each(backends)(
    "opens sealed model keys and app credentials with the same master key (%s)",
    async (kind) => {
      const { db, root } = copy(kind);
      const { gateway: opened } = await gateway(db, root);
      const accounts = await AccountStore.open(db, REALM, KEY, { clock: () => NOW });
      const [account] = await accounts.allAccounts();
      expect(account).toMatchObject({
        email: "owner@example.com",
        domain: "example.com",
        provider: "anthropic",
        model: "claude-parity",
      });
      const id = String(account?.id);
      expect(await accounts.credential(id, "model", "anthropic")).toBe("sk-parity-sealed-key");
      expect(await accounts.credential(id, "model", "openai")).toBe("sk-parity-openai");
      expect(await accounts.names(id, "app")).toEqual(["github", "granola", "telegram"]);
      const connections = new AppConnections({
        credentials: {
          get: (a, kind, name) => accounts.credential(a, kind, name),
          put: (a, kind, name, value) => accounts.putCredential(a, kind, name, value),
          delete: (a, kind, name) => accounts.deleteCredential(a, kind, name),
        },
        flows: {
          start: async () => {},
          consume: async () => null,
          forget: async () => {},
        },
        storeFor: async () => opened.store,
        origin: "https://bott.example",
        telegram: new TelegramLinks(TELEGRAM),
        mainTelegramToken: `999:${"b".repeat(32)}`,
        env: { BOTT_GITHUB_CLIENT_ID: "id", BOTT_GITHUB_CLIENT_SECRET: "secret" },
        clock: () => NOW,
      });
      expect(await connections.token(id, "github")).toBe("gho_parity");
      expect(await connections.token(id, "granola")).toBe("grn_parity_key");
      expect(await connections.connected(id, "telegram")).toBe(true);
      expect(JSON.parse(String(await accounts.credential(id, "app-client", "wispr")))).toEqual({
        callback: "https://bott.example/auth/apps/wispr/callback",
        client_id: "wc-1",
      });
      // A different key does not open them.
      const wrong = await AccountStore.open(db, REALM, `${Buffer.alloc(32, 7).toString("base64")}`);
      await expect(wrong.credential(id, "model", "anthropic")).rejects.toThrow();
    },
  );

  it.each(backends)(
    "reads memory facts in every state, with tags, conflicts and history (%s)",
    async (kind) => {
      const { db } = copy(kind);
      const facts = new FactStore({ db, instance: INSTANCE, clock: () => NOW });
      const scope = { project: PROJECT, owner: ACTOR };
      const active = await facts.facts(scope, { kind: "fact" });
      expect(active.map((f) => [f.text, f.tags, f.source])).toEqual([
        ["The owner works in Margao.", ["work"], "extracted"],
        ["The owner lives in Goa.", ["fact"], "explicit"],
      ]);
      expect((await facts.facts(scope, { kind: "episode" })).map((f) => f.text)).toEqual([
        "Planned a weekend trip.",
      ]);
      const conflicts = await facts.facts(scope, { statuses: ["conflicted"] });
      expect(conflicts.map((f) => [f.text, f.conflict, f.confidence])).toEqual([
        ["The owner prefers black tea.", 3, 0.6],
        ["The owner likes green tea.", 3, 0.8],
      ]);
      const forgotten = await facts.facts(scope, { statuses: ["retracted"] });
      expect(forgotten.map((f) => f.text)).toEqual(["The owner owns a red scooter."]);
      // Settling the conflict works on the stored rows.
      await facts.keep(4, scope);
      expect((await facts.facts(scope, { kind: "fact" })).map((f) => f.text)).toContain(
        "The owner prefers black tea.",
      );
    },
  );

  it("keeps earlier chats as history but starts a new session instead of resuming one", async () => {
    const { db, root } = copy();
    const { gateway: opened, get } = await gateway(db, root, ["Hello again."]);
    const history = (await get("/api/messages")) as Row[];
    expect(history.map((m) => [m.direction, m.text])).toEqual([
      ["in", "Plan a weekend in Goa."],
      ["out", "Here is a two day plan for Goa."],
      ["in", "Book the ferry."],
      ["in", "Never mind."],
      ["in", "What is the weather tomorrow?"],
    ]);
    expect(await opened.store.saved("old-chat")).toMatchObject({
      title: "Trip plan",
      provider: "anthropic",
      model: "claude-old",
    });
    // The earlier transcript is still on disk where its route points, in its own format.
    const earlier = join(root, "old-chat.jsonl");
    writeFileSync(earlier, '{"type":"session","id":"old-chat"}\n');
    await db.run("UPDATE routes SET session_file=? WHERE instance=? AND session='old-chat'", [
      earlier,
      INSTANCE,
    ]);
    const route = await opened.store.conversation(WEB_CHAT, ACTOR);
    expect(route.session).toBe("old-chat");
    const answer = await opened.sessions.prompt(route, "Hello again?");
    expect(answer.text).toBe("Hello again.");
    const after = await opened.store.getRoute(route.id);
    expect(after?.session).not.toBe("old-chat");
    expect(after?.sessionFile).not.toBe(earlier);
    expect(readFileSync(earlier, "utf8")).toBe('{"type":"session","id":"old-chat"}\n');
    const kept = await db.query("SELECT count(*) AS n FROM messages WHERE instance=? AND route=?", [
      INSTANCE,
      route.id,
    ]);
    expect(Number(kept[0]?.n)).toBeGreaterThanOrEqual(5);
  });

  it("runs due work once and settles what was left, without corrupting other rows", async () => {
    const { db, root } = copy();
    const { gateway: opened } = await gateway(db, root, ["Done.", "Done."]);
    const before = await snapshot(db);
    const sink = new MemorySink();
    await runRunner({
      store: opened.store,
      sessions: opened.sessions,
      sink,
      instance: INSTANCE,
      once: true,
      poll: 0.005,
    });
    const jobs = Object.fromEntries(
      (await opened.store.jobs({ history: true })).map((job) => [job.task, job]),
    );
    expect(jobs["Tidy the notes."]).toMatchObject({
      status: "active",
      running: false,
      lastStatus: "completed",
      lastRun: NOW,
      nextRun: NOW + 600,
    });
    expect(jobs["Stale check."]).toMatchObject({
      status: "active",
      running: false,
      lastStatus: "missed",
      nextRun: NOW + 3600,
    });
    expect(jobs["Thank the payer."]).toMatchObject({ running: false, lastStatus: "completed" });
    expect(jobs["Check the inbox."]).toMatchObject({ nextRun: WRITTEN + 3624, lastStatus: null });
    const wakeups = await db.query("SELECT status,claimed FROM job_wakeups WHERE instance=?", [
      INSTANCE,
    ]);
    expect(wakeups).toEqual([{ status: "completed", claimed: NOW }]);
    const delegated = await db.query(
      "SELECT task,status FROM delegations WHERE instance=? ORDER BY id",
      [INSTANCE],
    );
    expect(delegated.at(-1)).toEqual({ task: "Thank the payer.", status: "completed" });
    // Work the stopped gateway left running is settled the way it would have settled it.
    const tasks = await opened.store.tasks();
    expect(tasks[0]).toMatchObject({ goal: "Draft a thank-you note.", status: "interrupted" });
    const approval = await db.query(
      "SELECT decision,source FROM approvals WHERE instance=? AND id='approval-3'",
      [INSTANCE],
    );
    expect(approval).toEqual([{ decision: "denied", source: "restart" }]);
    expect((await opened.store.items()).map((item) => item.status)).toEqual(["pending", "prompt"]);
    expect(sink.sent.map((m) => m.text).sort()).toEqual([
      "Job #7 (Writer), completed:\nDone.",
      "Job #8 (Chief of Staff), completed:\nDone.",
    ]);
    expect(await snapshot(db)).toEqual(before);
    expect(await db.query("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(await db.query("PRAGMA foreign_key_check")).toEqual([]);
  });
});
