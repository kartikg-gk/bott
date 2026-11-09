import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider, StreamEvent } from "../../src/agent/providers/types.ts";
import { emptyUsage } from "../../src/agent/transcript.ts";
import type { Bot } from "../../src/bots/bots.ts";
import type { Database } from "../../src/db/database.ts";
import { type RuntimeConfig, SessionManager } from "../../src/runtime/sessions.ts";
import { answerTeamCall, jobTools, teamTools } from "../../src/runtime/team.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

function reply(text: string): StreamEvent[] {
  return [
    { type: "start", model: "m" },
    { type: "text_delta", text },
    {
      type: "end",
      entry: {
        role: "assistant",
        content: [{ type: "text", text }],
        model: "m",
        usage: emptyUsage(),
        stop: "end",
      },
    },
  ];
}

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const folders: string[] = [];
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  async function setup(...texts: string[]) {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main", { clock: () => 1_800_000_000 });
    const root = mkdtempSync(join(tmpdir(), "team-"));
    folders.push(root);
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
    };
    const seen: { bot: string; tools: string[] }[] = [];
    const factory = (bot: Bot): ModelProvider => ({
      id: "fake",
      async *stream(req) {
        seen.push({ bot: bot.name, tools: req.tools.map((t) => t.name) });
        const next = texts.shift();
        if (next === undefined) throw new Error("no scripted reply left");
        yield* reply(next);
      },
    });
    const sessions = new SessionManager(config, store, factory);
    managers.push(sessions);
    const route = await store.conversation(1, 1);
    const ctx = { store, sessions, route, actor: 1 };
    const call = async (name: string, input: unknown) => {
      const out = await answerTeamCall(ctx, { id: "c", name, input });
      const first = out.content[0];
      const text = first?.type === "text" ? first.text : "";
      return { text, isError: out.isError === true };
    };
    return { db, store, sessions, route, seen, call };
  }

  it("only the chief is offered team tools", async () => {
    const { store, sessions, seen } = await setup("one", "two");
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    await sessions.prompt(await store.conversation(1, 1), "hi");
    const theirs = await store.switchBot(await store.conversation(2, 2), writer.id);
    await sessions.prompt(theirs, "hi");
    const names = teamTools().map((t) => t.name);
    expect(names).toEqual([
      "list_bots",
      "create_bot",
      "update_bot",
      "delegate_task",
      "spawn_agent",
      "spawn_writer_agent",
      "list_tasks",
      "check_task",
      "cancel_task",
    ]);
    expect(seen[0]?.tools).toEqual(expect.arrayContaining(names));
    for (const name of names) expect(seen[1]?.tools).not.toContain(name);
    const approval = Object.fromEntries(teamTools().map((t) => [t.name, !t.readOnly]));
    expect(approval).toMatchObject({ create_bot: true, update_bot: true, delegate_task: false });
  });

  it("changes that outlast the run always ask the person, whatever the policy", () => {
    const reviewed = [...teamTools(), ...jobTools()]
      .filter((t) => t.review === true)
      .map((t) => t.name);
    expect(reviewed.sort()).toEqual([
      "cancel_scheduled_job",
      "create_bot",
      "schedule_job",
      "update_bot",
    ]);
  });

  it("create_bot then list_bots shows it", async () => {
    const { call } = await setup();
    expect((await call("create_bot", { name: "Writer", description: "Drafts text" })).text).toBe(
      "Created Writer.",
    );
    const listed = JSON.parse((await call("list_bots", {})).text);
    expect(listed).toEqual([
      expect.objectContaining({ name: "Chief of Staff", you: true }),
      { name: "Writer", description: "Drafts text", you: false },
    ]);
    const again = await call("create_bot", { name: "writer", description: "Other" });
    expect(again).toEqual({ text: "A bot named writer already exists", isError: true });
    expect((await call("update_bot", { name: "Writer", instructions: "Be brief" })).text).toContain(
      "Updated Writer",
    );
    expect((await call("update_bot", { name: "Nobody" })).isError).toBe(true);
    expect((await call("create_bot", { name: "" })).isError).toBe(true);
  });

  it("delegate_task runs on the named bot and records the delegation", async () => {
    const { db, call, store } = await setup("draft ready");
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const out = await call("delegate_task", { bot_name: "writer", task: "draft a note" });
    expect(JSON.parse(out.text)).toEqual({
      bot: "Writer",
      status: "completed",
      answer: "draft ready",
    });
    const rows = await db.query("SELECT bot,task,status,answer FROM delegations");
    expect(rows).toEqual([
      { bot: writer.id, task: "draft a note", status: "completed", answer: "draft ready" },
    ]);
    const chief = await call("delegate_task", { bot_name: "Chief of Staff", task: "x" });
    expect(chief.isError).toBe(true);
  });

  it("a second delegation to a busy bot is refused", async () => {
    const { call, store, route, db } = await setup("never used");
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    expect(await store.beginDelegation(route, writer.id, "first")).not.toBeNull();
    const out = await call("delegate_task", { bot_name: "Writer", task: "second" });
    expect(out).toEqual({ text: "Writer is busy with another task.", isError: true });
    const rows = await db.query("SELECT task,status FROM delegations");
    expect(rows).toEqual([{ task: "first", status: "running" }]);
  });

  it("a failed delegation is recorded with its failure status", async () => {
    const { db, call, store } = await setup();
    await store.createBot({ name: "Writer", role: "Drafts text" });
    const out = await call("delegate_task", { bot_name: "Writer", task: "go" });
    expect(JSON.parse(out.text).status).toBe("failed");
    expect((await db.query("SELECT status FROM delegations"))[0]?.status).toBe("failed");
  });

  it("check_task and cancel_task act on a task", async () => {
    const { call, store, route } = await setup();
    const id = await store.addTask({
      chat: route.chat,
      user: route.user,
      actor: 1,
      thread: route.thread,
      bot: (await store.chief()).id,
      goal: "look into it",
      policy: "deny",
      followUp: false,
    });
    expect(JSON.parse((await call("list_tasks", {})).text)).toEqual([
      { id, status: "running", goal: "look into it" },
    ]);
    expect(JSON.parse((await call("check_task", { task_id: id })).text)).toEqual({
      id,
      status: "running",
      answer: "",
    });
    expect((await call("cancel_task", { task_id: id })).text).toBe("Cancelling.");
    expect((await store.task(id))?.status).toBe("cancelled");
    expect((await call("cancel_task", { task_id: id })).isError).toBe(true);
    expect((await call("check_task", { task_id: 999 })).text).toBe(
      "There is no task with that number",
    );
  });
});
