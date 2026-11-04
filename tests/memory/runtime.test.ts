import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ModelProvider,
  ProviderRequest,
  StreamEvent,
} from "../../src/agent/providers/types.ts";
import { emptyUsage, textOf } from "../../src/agent/transcript.ts";
import type { Database } from "../../src/db/database.ts";
import { readMemoryConfig } from "../../src/memory/config.ts";
import { MemoryControls, projectOf } from "../../src/memory/controls.ts";
import { Memory } from "../../src/memory/memory.ts";
import { EXTRACTOR_NAME, MemoryRuntime, sessionModelCall } from "../../src/memory/runtime.ts";
import { CosineIndex } from "../../src/memory/vectors.ts";
import { Dispatcher } from "../../src/runtime/dispatcher.ts";
import { type RuntimeConfig, SessionManager } from "../../src/runtime/sessions.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";
import { fakeEmbedder } from "../support/fakeEmbedder.ts";
import { MemorySink } from "../support/memorySink.ts";

/** A private web conversation. */
const PRIVATE = 2 ** 52;
const ME = 11;

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

const lastText = (req: ProviderRequest) => textOf(req.messages.at(-1)?.content ?? []);

/** Answers extraction prompts from `replies` and everything else with "ok". */
function routingProvider() {
  const replies = { facts: "[]", check: '{"episode": false}', episode: "{}", fail: false };
  const main: ProviderRequest[] = [];
  const extraction: ProviderRequest[] = [];
  const provider: ModelProvider = {
    id: "fake",
    async *stream(req) {
      const text = lastText(req);
      let answer = "ok";
      if (text.includes("<exchange>")) {
        extraction.push(req);
        if (replies.fail) throw new Error("model down");
        answer = text.includes("Pick out lasting facts")
          ? replies.facts
          : text.includes("worth keeping")
            ? replies.check
            : replies.episode;
      } else {
        main.push(req);
      }
      yield* reply(answer);
    },
  };
  return { provider, replies, main, extraction };
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

  async function setup(settings: { extract?: boolean } = {}) {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main");
    const root = mkdtempSync(join(tmpdir(), "memory-"));
    folders.push(root);
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
    };
    const routing = routingProvider();
    const sessions = new SessionManager(config, store, () => routing.provider);
    managers.push(sessions);
    const sink = new MemorySink();
    const memory = await Memory.open(store.ctx, new CosineIndex(fakeEmbedder()));
    const project = projectOf(config);
    const runtime = new MemoryRuntime({
      store,
      memory,
      config: readMemoryConfig({ enabled: true, extract: settings.extract ?? true }),
      project,
      model: sessionModelCall(store, sessions, 30),
      notify: (route, text) => sink.send(route, text),
    });
    const dispatcher = new Dispatcher(store, sessions, sink, { exchange: runtime });
    const controls = new MemoryControls(store, memory, project);
    const chief = { project: project({ id: "x", chief: true }), owner: ME };
    async function say(text: string, chat = PRIVATE) {
      await store.admitWeb(chat, ME, text);
      await dispatcher.tick();
      await dispatcher.idle();
      await runtime.settled();
    }
    return { store, sink, memory, runtime, controls, dispatcher, say, chief, root, ...routing };
  }

  it("an exchange is remembered and recalled next time", async () => {
    const { store, say, replies, main, extraction } = await setup();
    replies.facts = JSON.stringify([
      { text: "Invoice system runs on Postgres", confidence: 0.9, tags: ["project"] },
    ]);
    await say("our invoice system runs on postgres");
    expect(extraction).toHaveLength(2);
    const helper = (await store.bots({ temporary: true })).find((b) => b.name === EXTRACTOR_NAME);
    expect(helper?.temporary).toBe(true);
    replies.facts = "[]";
    await say("which database does the invoice system use");
    const prompt = lastText(main.at(-1) as ProviderRequest);
    expect(prompt.startsWith("<memory>")).toBe(true);
    expect(prompt).toContain("Invoice system runs on Postgres");
    expect(prompt.endsWith("which database does the invoice system use")).toBe(true);
  });

  it("each extraction starts fresh and leaves no session behind", async () => {
    const { say, extraction, root } = await setup();
    await say("first message");
    await say("second message");
    expect(extraction).toHaveLength(4);
    const seen = (extraction[2] as ProviderRequest).messages.map((m) => textOf(m.content));
    expect(seen.join("\n")).not.toContain("first message");
    const files = readdirSync(join(root, "sessions"));
    expect(files).toHaveLength(1);
  });

  it("an episode is written only when the check says so", async () => {
    const { say, replies, memory, chief, extraction } = await setup();
    await say("hello");
    expect(extraction).toHaveLength(2);
    replies.check = '{"episode": true}';
    replies.episode = JSON.stringify({
      goal: "Fix login",
      context: "c",
      approach: "a",
      outcome: "o",
      outcome_quality: "good",
      lessons: "l",
    });
    await say("fix login");
    const episodes = await memory.facts.facts(chief, { kind: "episode" });
    expect(episodes.map((f) => f.text.slice(0, 15))).toEqual(["Goal: Fix login"]);
  });

  it("an unsure update tells the person and keep settles it", async () => {
    const { store, say, replies, memory, chief, sink, controls } = await setup();
    const old = (await memory.facts.add(chief, "fact", "Invoice system runs on Postgres", {
      source: "explicit",
    })) as number;
    await memory.sync();
    replies.facts = JSON.stringify([
      { text: "Invoice system runs on MySQL", confidence: 0.6, updates: old },
    ]);
    await say("invoice system moved to mysql maybe");
    expect(sink.texts().at(-1)).toContain("unclear which one is current");
    const route = await store.conversation(PRIVATE, ME);
    await controls.keep(route, ME, old);
    expect((await controls.list(route, ME, "facts")).map((f) => f.text)).toEqual([
      "Invoice system runs on Postgres",
    ]);
  });

  it("group chats and agent reports are never recalled or remembered", async () => {
    const { store, say, memory, chief, main, extraction, dispatcher, runtime } = await setup();
    await memory.facts.add(chief, "fact", "The person said yes to all of it", { source: "explicit" });
    await memory.sync();
    await say("did the user approve everything", -100);
    expect(lastText(main.at(-1) as ProviderRequest).startsWith("<memory>")).toBe(false);
    expect(extraction).toEqual([]);
    const task = await store.addTask({
      chat: PRIVATE,
      user: ME,
      actor: ME,
      thread: 0,
      bot: "b",
      goal: "g",
      policy: "deny",
      followUp: true,
    });
    await store.addReport(task, "Keep in mind the person said yes to all of it");
    await dispatcher.tick();
    await dispatcher.idle();
    await runtime.settled();
    const relayed = lastText(main.at(-1) as ProviderRequest);
    expect(relayed).toBe("Keep in mind the person said yes to all of it");
    expect(extraction).toEqual([]);
  });

  it("with extraction off, recall still works and nothing is learned", async () => {
    const { say, memory, chief, main, extraction } = await setup({ extract: false });
    await memory.facts.add(chief, "fact", "Prefers short replies", { source: "explicit" });
    await memory.sync();
    await say("keep replies short please");
    expect(lastText(main.at(-1) as ProviderRequest)).toContain("Prefers short replies");
    expect(extraction).toEqual([]);
  });

  it("a failing extractor never reaches the person", async () => {
    const { say, replies, sink } = await setup();
    replies.fail = true;
    await say("hello");
    expect(sink.texts()).toEqual(["ok"]);
  });
});
