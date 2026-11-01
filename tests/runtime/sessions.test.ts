import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelProvider,
  ProviderRequest,
  StreamEvent,
} from "../../src/agent/providers/types.ts";
import { THINKING_BUDGETS } from "../../src/agent/thinking.ts";
import { emptyUsage, textOf } from "../../src/agent/transcript.ts";
import { type Bot, botRoot } from "../../src/bots/bots.ts";
import { rememberSession, savedSession } from "../../src/bots/profiles.ts";
import type { Database } from "../../src/db/database.ts";
import { Lease } from "../../src/db/leases.ts";
import { type RuntimeConfig, SessionManager } from "../../src/runtime/sessions.ts";
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

/** Answers every call with the next scripted text and keeps who asked. */
function scripted(...texts: string[]) {
  const requests: { bot: string; req: ProviderRequest }[] = [];
  const factory = (bot: Bot): ModelProvider => ({
    id: "fake",
    async *stream(req) {
      requests.push({ bot: bot.name, req });
      const text = texts.shift();
      if (text === undefined) throw new Error("no scripted reply left");
      yield* reply(text);
    },
  });
  return { factory, requests };
}

const said = (req: ProviderRequest) => req.messages.map((m) => textOf(m.content));

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const folders: string[] = [];
  const managers: SessionManager[] = [];
  let now = 1_800_000_000;
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  async function setup(hosted = false) {
    const { db } = database(kind);
    open.push(db);
    now = 1_800_000_000;
    const store = await Store.open(db, "main", { clock: () => now });
    const root = mkdtempSync(join(tmpdir(), "sessions-"));
    folders.push(root);
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: hosted ? null : join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
    };
    const manager = (factory: (bot: Bot) => ModelProvider) => {
      const made = new SessionManager(config, store, factory);
      managers.push(made);
      return made;
    };
    return { store, config, manager };
  }

  function writeNotes(stateDir: string, bot: Pick<Bot, "id">, note: string, skill: string) {
    const memory = join(botRoot(stateDir, bot), "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "PREFERENCES.md"), `# Preferences\n${note}\n`);
    const folder = join(botRoot(stateDir, bot), "skills", skill);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "SKILL.md"),
      `---\nname: ${skill}\ndescription: How to ${skill}\n---\nSteps for ${skill}.\n`,
    );
  }

  it("a route gets one session and reuses it", async () => {
    const { store, config, manager } = await setup();
    const { factory, requests } = scripted("hello", "again");
    const sessions = manager(factory);
    const route = await store.conversation(1, 1);
    const first = await sessions.sessionFor(route);
    expect(await sessions.sessionFor(route)).toBe(first);

    const answer = await sessions.prompt(route, "hi");
    expect(answer).toEqual({ text: "hello", outcome: "completed" });
    const kept = await store.getRoute(route.id);
    expect(kept?.session).toBeTruthy();
    expect(kept?.sessionFile).toBe(join(config.sessionsDir as string, `${kept?.session}.jsonl`));
    expect(existsSync(kept?.sessionFile as string)).toBe(true);
    expect((await store.saved(kept?.session as string))?.sessionFile).toBe(kept?.sessionFile);

    expect(await sessions.sessionFor(route)).toBe(first);
    const events: string[] = [];
    await sessions.prompt(route, "more", { onEvent: (e) => events.push(e.type) });
    expect(events).toContain("message_update");
    expect(events.at(-1)).toBe("agent_settled");
    expect(said(requests[1]?.req as ProviderRequest)).toEqual(["hi", "hello", "more"]);
    expect((await sessions.state(route)).sessionId).toBe(kept?.session);
  });

  it("a session reloads its transcript after the manager restarts", async () => {
    const { store, manager } = await setup();
    const { factory, requests } = scripted("first answer", "second answer");
    const before = manager(factory);
    const route = await store.conversation(1, 1);
    await before.prompt(route, "remember this");
    const session = (await store.getRoute(route.id))?.session;
    await before.close();

    const after = manager(factory);
    expect(await after.prompt(route, "what did I say?")).toEqual({
      text: "second answer",
      outcome: "completed",
    });
    expect((await store.getRoute(route.id))?.session).toBe(session);
    expect(said(requests[1]?.req as ProviderRequest)).toEqual([
      "remember this",
      "first answer",
      "what did I say?",
    ]);
  });

  it("the chief and another bot see their own notes and skills", async () => {
    const { store, config, manager } = await setup();
    const chief = (await store.bot((await store.chief()).id)) as Bot;
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    writeNotes(config.stateDir, chief, "Likes tea", "brew");
    writeNotes(config.stateDir, writer, "Likes coffee", "draft");
    await store.setPlugin(writer.id, "gmail", true);
    const { factory, requests } = scripted("from chief", "from writer");
    const sessions = manager(factory);

    const mine = await store.conversation(1, 1);
    const theirs = await store.switchBot(await store.conversation(2, 2), writer.id);
    await sessions.prompt(mine, "hello chief");
    await sessions.prompt(theirs, "hello writer");

    const [asChief, asWriter] = requests.map((r) => r);
    expect(asChief?.bot).toBe(chief.name);
    expect(asChief?.req.system).toContain("You are Chief of Staff");
    expect(asChief?.req.system).toContain("Likes tea");
    expect(asChief?.req.system).toContain("- brew: How to brew");
    expect(asChief?.req.system).not.toContain("Likes coffee");
    expect(asChief?.req.system).not.toContain("draft");
    expect(asWriter?.bot).toBe("Writer");
    expect(asWriter?.req.system).toContain("You are Writer. Purpose: Drafts text");
    expect(asWriter?.req.system).toContain("Likes coffee");
    expect(asWriter?.req.system).toContain("- draft: How to draft");
    expect(asWriter?.req.system).toContain("gmail");
    expect(asWriter?.req.system).not.toContain("Likes tea");
    expect(asWriter?.req.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["Read", "Bash", "load_skill"]),
    );
    expect(existsSync(join(botRoot(config.stateDir, writer), "workspace"))).toBe(true);
  });

  it("switching bot gives the route that bot's session", async () => {
    const { store, manager } = await setup();
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const { factory, requests } = scripted("chief one", "writer one", "chief two");
    const sessions = manager(factory);
    const route = await store.conversation(1, 1);
    await sessions.prompt(route, "to chief");
    const chiefSession = (await store.getRoute(route.id))?.session;

    const switched = await sessions.switchBot(route, writer);
    expect(switched.bot).toBe(writer.id);
    expect(switched.session).toBeNull();
    await sessions.prompt(route, "to writer");
    expect(requests[1]?.bot).toBe("Writer");
    expect(said(requests[1]?.req as ProviderRequest)).toEqual(["to writer"]);
    expect((await store.getRoute(route.id))?.session).not.toBe(chiefSession);

    await sessions.switchBot(route, await store.chief());
    expect((await store.getRoute(route.id))?.session).toBe(chiefSession);
    await sessions.prompt(route, "back again");
    expect(requests[2]?.bot).toBe("Chief of Staff");
    expect(said(requests[2]?.req as ProviderRequest)).toEqual([
      "to chief",
      "chief one",
      "back again",
    ]);
  });

  it("delegate runs on the other bot and returns its answer", async () => {
    const { store, manager } = await setup();
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const { factory, requests } = scripted("draft ready", "second draft");
    const sessions = manager(factory);
    const route = await store.conversation(1, 1);

    expect(await sessions.delegate(route, writer, "draft a note")).toBe("draft ready");
    expect(requests[0]?.bot).toBe("Writer");
    expect(requests[0]?.req.system).toContain("You are Writer.");
    const file = await savedSession(store, writer.id);
    expect(file && existsSync(file)).toBe(true);
    expect((await store.getRoute(route.id))?.session).toBeNull();

    expect(await sessions.delegate(route, writer, "once more")).toBe("second draft");
    expect(said(requests[1]?.req as ProviderRequest)).toEqual([
      "draft a note",
      "draft ready",
      "once more",
    ]);
    await expect(sessions.delegate(route, await store.chief(), "loop")).rejects.toThrow(
      /cannot delegate back/,
    );
  });

  it("a bot hold that cannot be released keeps the run's outcome", async () => {
    const { store, manager } = await setup();
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const sessions = manager(scripted("hello", "draft ready", "again").factory);
    const route = await store.conversation(1, 1);
    const release = vi
      .spyOn(Lease.prototype, "release")
      .mockRejectedValue(new Error("network went away"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await sessions.prompt(route, "hi")).toEqual({ text: "hello", outcome: "completed" });
      expect(await sessions.delegate(route, writer, "draft a note")).toBe("draft ready");
      expect(release).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(sessions.isBusy(writer.id)).toBe(false);
      expect(sessions.isBusy((await store.chief()).id)).toBe(false);
    } finally {
      release.mockRestore();
      warn.mockRestore();
    }
    // The hold left in the database runs out by itself.
    now += 61;
    expect(await sessions.prompt(route, "more")).toEqual({ text: "again", outcome: "completed" });
  });

  it("the bot lock is released after an approval expires", async () => {
    const { store, config, manager } = await setup();
    config.policy = "ask";
    config.approvalSeconds = 1;
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const write: StreamEvent[] = [
      { type: "start", model: "m" },
      {
        type: "end",
        entry: {
          role: "assistant",
          content: [
            { type: "call", id: "c1", name: "Write", input: { path: "a.txt", content: "x" } },
          ],
          model: "m",
          usage: emptyUsage(),
          stop: "end",
        },
      },
    ];
    const turns = [write, reply("could not write"), reply("second task done")];
    const sessions = manager(() => ({
      id: "fake",
      async *stream() {
        const next = turns.shift();
        if (!next) throw new Error("no scripted reply left");
        yield* next;
      },
    }));
    const route = await store.conversation(1, 1);
    // Nobody answers the approval while the store clock moves on.
    const ticking = setInterval(() => {
      now += 1;
    }, 50);
    try {
      expect(await sessions.delegate(route, writer, "write a note")).toBe("could not write");
    } finally {
      clearInterval(ticking);
    }
    expect(existsSync(join(sessions.workspaceFor(writer).root, "a.txt"))).toBe(false);
    expect(sessions.isBusy(writer.id)).toBe(false);
    expect(await sessions.delegate(route, writer, "something else")).toBe("second task done");
  });

  it("writing a skill or note file asks the person, even under auto", async () => {
    const { store, config, manager } = await setup();
    config.approvalSeconds = 1;
    const chief = (await store.bot((await store.chief()).id)) as Bot;
    const write: StreamEvent[] = [
      { type: "start", model: "m" },
      {
        type: "end",
        entry: {
          role: "assistant",
          content: [
            {
              type: "call",
              id: "c1",
              name: "Write",
              input: { path: "tools/SKILL.md", content: "x" },
            },
          ],
          model: "m",
          usage: emptyUsage(),
          stop: "end",
        },
      },
    ];
    const turns = [write, reply("left it")];
    const sessions = manager(() => ({
      id: "fake",
      async *stream() {
        const next = turns.shift();
        if (!next) throw new Error("no scripted reply left");
        yield* next;
      },
    }));
    const route = await store.conversation(1, 1);
    const asked: string[] = [];
    const ticking = setInterval(() => {
      now += 1;
    }, 50);
    try {
      await sessions.prompt(route, "save a skill", {
        onEvent: (e) => {
          if (e.type === "approval_requested") asked.push(e.tool);
        },
      });
    } finally {
      clearInterval(ticking);
    }
    expect(asked).toEqual(["Write"]);
    expect(existsSync(join(sessions.workspaceFor(chief).root, "tools", "SKILL.md"))).toBe(false);
  });

  it("a conversation's own thinking level wins over the server's", async () => {
    const { store, config, manager } = await setup();
    config.thinking = "low";
    const { factory, requests } = scripted("one", "two");
    const sessions = manager(factory);
    const first = await store.conversation(1, 1);
    await sessions.prompt(first, "hi");
    const second = await store.conversation(2, 2);
    await store.persistRoute(second, { thinking: "max" });
    await sessions.prompt(second, "hi");
    expect(requests.map((r) => r.req.thinking)).toEqual([
      { budgetTokens: THINKING_BUDGETS.low },
      { budgetTokens: THINKING_BUDGETS.max },
    ]);
  });

  it("idle sessions are closed after idleSeconds", async () => {
    const { store, manager } = await setup(true);
    const { factory, requests } = scripted("noted", "still here");
    const sessions = manager(factory);
    const route = await store.conversation(1, 1);
    await sessions.prompt(route, "keep this");
    const first = await sessions.sessionFor(route);
    expect((await store.getRoute(route.id))?.sessionFile).toBeNull();

    now += 30;
    sessions.sweep();
    expect(await sessions.sessionFor(route)).toBe(first);

    now += 61;
    sessions.sweep();
    const second = await sessions.sessionFor(route);
    expect(second).not.toBe(first);
    await sessions.prompt(route, "and now?");
    expect(said(requests[1]?.req as ProviderRequest)).toEqual(["keep this", "noted", "and now?"]);
  });
  const EARLIER =
    '{"type":"session","version":3,"id":"old"}\n{"type":"message","message":{"role":"user","content":"hi"}}\n';

  function earlierFile(dir: string, id: string): string {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, EARLIER);
    return file;
  }

  it("an earlier-format session file is left untouched and a new session starts", async () => {
    const { store, config, manager } = await setup();
    const { factory, requests } = scripted("fresh start");
    const sessions = manager(factory);
    const old = earlierFile(config.sessionsDir as string, "old");
    const route = await store.persistRoute(await store.conversation(1, 1), {
      session: "old",
      sessionFile: old,
    });

    expect(await sessions.prompt(route, "hello")).toEqual({
      text: "fresh start",
      outcome: "completed",
    });
    expect(said(requests[0]?.req as ProviderRequest)).toEqual(["hello"]);
    expect(readFileSync(old, "utf8")).toBe(EARLIER);
    const now = await store.getRoute(route.id);
    expect(now?.session).not.toBe("old");
    expect(now?.sessionFile).toBe(join(config.sessionsDir as string, `${now?.session}.jsonl`));
    expect((await store.saved(now?.session as string))?.sessionFile).toBe(now?.sessionFile);
    expect((await store.saved("old"))?.sessionFile).toBe(old);
  });

  it("delegating to a bot with an earlier saved session starts a new one", async () => {
    const { store, config, manager } = await setup();
    const writer = await store.createBot({ name: "Writer", role: "Drafts text" });
    const old = earlierFile(config.sessionsDir as string, "writer-old");
    await rememberSession(store, writer.id, { sessionFile: old });
    const { factory, requests } = scripted("done");
    const sessions = manager(factory);
    const route = await store.conversation(1, 1);

    expect(await sessions.delegate(route, writer, "tidy up")).toBe("done");
    expect(said(requests[0]?.req as ProviderRequest)).toEqual(["tidy up"]);
    expect(readFileSync(old, "utf8")).toBe(EARLIER);
    const saved = await savedSession(store, writer.id);
    expect(saved).not.toBe(old);
    expect(saved && existsSync(saved)).toBe(true);
  });

  it("fresh keeps an earlier-format file", async () => {
    const { store, config, manager } = await setup();
    const sessions = manager(scripted().factory);
    const old = earlierFile(config.sessionsDir as string, "old");
    const route = await store.persistRoute(await store.conversation(1, 1), {
      session: "old",
      sessionFile: old,
    });

    const cleared = await sessions.fresh(route);
    expect(cleared).toMatchObject({ session: null, sessionFile: null });
    expect(readFileSync(old, "utf8")).toBe(EARLIER);
  });
});
