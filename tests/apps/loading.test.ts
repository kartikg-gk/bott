import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Policy } from "../../src/agent/policy.ts";
import type {
  ModelProvider,
  ProviderRequest,
  StreamEvent,
} from "../../src/agent/providers/types.ts";
import { AgentSession, type HostTool, type SessionEvent } from "../../src/agent/session.ts";
import { emptyUsage, type ModelEntry } from "../../src/agent/transcript.ts";
import { BotApps } from "../../src/apps/access.ts";
import { AppRunner } from "../../src/apps/registry.ts";
import type { Database } from "../../src/db/database.ts";
import { type RuntimeConfig, SessionManager } from "../../src/runtime/sessions.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";
import { fakeFetch, json } from "../support/fakeFetch.ts";
import { fakeProvider } from "../support/fakeProvider.ts";
import { notes } from "../support/notesApp.ts";

function reply(blocks: ModelEntry["content"]): StreamEvent[] {
  return [
    { type: "start", model: "m" },
    {
      type: "end",
      entry: { role: "assistant", content: blocks, model: "m", usage: emptyUsage(), stop: "end" },
    },
  ];
}
const say = (text: string) => reply([{ type: "text", text }]);
const use = (id: string, name: string, input: unknown) =>
  reply([{ type: "call", id, name, input }]);

const hosted = (name: string, readOnly: boolean, review = false): HostTool => ({
  name,
  description: name,
  input: z.object({}).strict(),
  readOnly,
  review,
});

async function settle(session: AgentSession, approve: boolean): Promise<SessionEvent[]> {
  const seen: SessionEvent[] = [];
  for await (const event of session.events()) {
    seen.push(event);
    if (event.type === "approval_requested") {
      await session.request("respond_to_approval", {
        approvalId: event.approvalId,
        allow: approve,
      });
    }
    if (event.type === "agent_settled") break;
  }
  return seen;
}

describe("host tools added mid-conversation", () => {
  async function run(policy: Policy, tool: HostTool, approve = true) {
    const provider = fakeProvider([use("c1", tool.name, {}), say("done")]);
    const answered: string[] = [];
    const session = await AgentSession.open({
      id: "s",
      providers: { fake: provider },
      provider: "fake",
      model: "m",
      system: "",
      policy,
      answerHostTool: async (call) => {
        answered.push(call.name);
        return { content: [{ type: "text", text: "ok" }] };
      },
    });
    session.addHostTools([tool]);
    session.addHostTools([tool]);
    await session.request("prompt", { message: "go" });
    const events = await settle(session, approve);
    const asked = events.filter((e) => e.type === "approval_requested").length;
    const names = provider.requests[0]?.tools.map((t) => t.name);
    return { answered, asked, names };
  }

  it("are offered once and a read runs without asking", async () => {
    const out = await run("ask", hosted("notes_read", true));
    expect(out).toEqual({ answered: ["notes_read"], asked: 0, names: ["notes_read"] });
  });

  it("a write follows the policy", async () => {
    expect((await run("ask", hosted("notes_write", false))).asked).toBe(1);
    expect(await run("auto", hosted("notes_write", false))).toMatchObject({ asked: 0 });
  });

  it("a reviewed write asks even when other tools run unattended", async () => {
    expect(await run("auto", hosted("notes_send", false, true))).toMatchObject({
      answered: ["notes_send"],
      asked: 1,
    });
    expect(await run("engine", hosted("notes_send", false, true), false)).toMatchObject({
      answered: [],
      asked: 1,
    });
    expect(await run("deny", hosted("notes_send", false, true))).toMatchObject({
      answered: [],
      asked: 0,
    });
  });
});

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const folders: string[] = [];
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it("a bot loads a granted app by name and then uses its tools", async () => {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main", { clock: () => 1_800_000_000 });
    const root = mkdtempSync(join(tmpdir(), "apps-"));
    folders.push(root);
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
    };
    const script = [
      use("c1", "load_plugin", { name: "notes" }),
      use("c2", "notes_read", { id: "1" }),
      say("read it"),
    ];
    const requests: ProviderRequest[] = [];
    const offered: string[][] = [];
    const factory = (): ModelProvider => ({
      id: "fake",
      async *stream(req) {
        requests.push(req);
        offered.push(req.tools.map((t) => t.name).filter((n) => /plugin|notes/.test(n)));
        const next = script.shift();
        if (!next) throw new Error("no scripted reply left");
        yield* next;
      },
    });
    const fetcher = fakeFetch({ "GET https://notes.test/notes_read/1": () => json({ n: 1 }) });
    const sessions = new SessionManager(config, store, factory);
    managers.push(sessions);
    sessions.apps = new BotApps(
      store,
      new AppRunner({ apps: { notes }, env: { NOTES_KEY: "k" }, fetch: fetcher }),
    );
    const chief = await store.chief();
    await store.setPlugin(chief.id, "notes", true);
    const route = await store.conversation(1, 1);

    const answer = await sessions.prompt(route, "read note 1");
    expect(answer.text).toBe("read it");
    expect(offered[0]).toEqual(["load_plugin"]);
    expect(offered[1]).toEqual(["load_plugin", "notes_read", "notes_write", "notes_send"]);
    expect(requests[0]?.system).toContain("You may use these apps: notes.");
    const results = requests[2]?.messages.filter((m) => m.role === "tool") ?? [];
    expect(JSON.stringify(results)).toContain('\\"n\\":1');
    expect(fetcher.seen.map((s) => s.url.pathname)).toEqual(["/notes_read/1"]);
  });

  it("a bot without grants is given no loader", async () => {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main", { clock: () => 1_800_000_000 });
    const root = mkdtempSync(join(tmpdir(), "apps-"));
    folders.push(root);
    const requests: ProviderRequest[] = [];
    const sessions = new SessionManager(
      {
        stateDir: join(root, "state"),
        projectDir: join(root, "project"),
        sessionsDir: null,
        policy: "auto",
        model: "m",
        idleSeconds: 60,
      },
      store,
      () => ({
        id: "fake",
        async *stream(req) {
          requests.push(req);
          yield* say("hi");
        },
      }),
    );
    managers.push(sessions);
    sessions.apps = new BotApps(store, new AppRunner({ apps: { notes }, env: {} }));
    const chief = await store.chief();
    await store.setPlugin(chief.id, "notes", true);
    await sessions.prompt(await store.conversation(1, 1), "hi");
    expect(requests[0]?.tools.map((t) => t.name)).not.toContain("load_plugin");
    expect(requests[0]?.system).not.toContain("# Apps");
  });
});
