import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ModelProvider,
  ProviderRequest,
  StreamEvent,
} from "../../src/agent/providers/types.ts";
import { emptyUsage } from "../../src/agent/transcript.ts";
import type { Bot } from "../../src/bots/bots.ts";
import { BrowserRegistry } from "../../src/browser/registry.ts";
import { BotBrowser } from "../../src/browser/tools.ts";
import type { Database } from "../../src/db/database.ts";
import { type RuntimeConfig, SessionManager } from "../../src/runtime/sessions.ts";
import { Store } from "../../src/store/store.ts";
import { fakeCdp } from "../support/fakeCdp.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

const KEY = { accountId: "b".repeat(32), token: "token-for-tests" };

function turn(content: unknown[]): StreamEvent[] {
  return [
    { type: "start", model: "m" },
    {
      type: "end",
      entry: {
        role: "assistant",
        content: content as never,
        model: "m",
        usage: emptyUsage(),
        stop: "end",
      },
    },
  ];
}

const callTool = (name: string, input: unknown) =>
  turn([{ type: "call", id: `c-${name}`, name, input }]);
const text = (t: string) => turn([{ type: "text", text: t }]);

describe.each(backends)("%s backend", (kind: Backend) => {
  const open: Database[] = [];
  const folders: string[] = [];
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
    await Promise.all(open.splice(0).map((db) => db.close()));
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  async function setup(turns: StreamEvent[][], key: typeof KEY | null = KEY) {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main");
    const root = mkdtempSync(join(tmpdir(), "browser-"));
    folders.push(root);
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
    };
    const requests: ProviderRequest[] = [];
    const factory = (_bot: Bot): ModelProvider => ({
      id: "fake",
      async *stream(req) {
        requests.push(req);
        const next = turns.shift();
        if (!next) throw new Error("no scripted reply left");
        yield* next;
      },
    });
    const sessions = new SessionManager(config, store, factory);
    managers.push(sessions);
    const fake = fakeCdp();
    const registry = new BrowserRegistry({ open: fake.open, settleMs: 10 });
    sessions.browser = new BotBrowser(registry, "acct", async () => key);
    return { store, sessions, requests, fake, registry };
  }

  const toolNames = (req: ProviderRequest | undefined) => (req?.tools ?? []).map((t) => t.name);

  it("offers the browser tools when the account has a key", async () => {
    const { store, sessions, requests } = await setup([text("hi")]);
    await sessions.prompt(await store.conversation(1, 1), "hello", { run: "r1" });
    expect(toolNames(requests[0])).toEqual(
      expect.arrayContaining(["browser_open", "browser_snapshot", "browser_click", "browser_type"]),
    );
  });

  it("leaves them out without a key", async () => {
    const { store, sessions, requests } = await setup([text("hi")], null);
    await sessions.prompt(await store.conversation(1, 1), "hello", { run: "r1" });
    expect(toolNames(requests[0]).filter((n) => n.startsWith("browser_"))).toEqual([]);
  });

  it("opens the run's browser on first use and closes it when the run ends", async () => {
    const { store, sessions, fake, registry } = await setup([
      callTool("browser_open", { url: "https://a.test" }),
      callTool("browser_click", { control: 1 }),
      text("done"),
    ]);
    const answer = await sessions.prompt(await store.conversation(1, 1), "look", { run: "r1" });
    expect(answer.outcome).toBe("completed");
    expect(fake.browsers).toHaveLength(1);
    expect(fake.browsers[0]?.closed).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("a read-only background run gets only the reading tools", async () => {
    const { store, sessions, requests, fake } = await setup([
      callTool("browser_open", { url: "https://a.test" }),
      text("read it"),
    ]);
    const chief = await store.chief();
    const answer = await sessions.background(await store.conversation(1, 1), chief, "read", {
      readOnly: true,
      signal: new AbortController().signal,
      detached: true,
    });
    expect(answer.text).toBe("read it");
    const names = toolNames(requests[0]);
    expect(names).toContain("browser_open");
    expect(names).not.toContain("browser_click");
    expect(fake.browsers[0]?.closed).toBe(true);
  });

  it("closes an open browser when the manager closes", async () => {
    const { sessions, registry, fake } = await setup([]);
    await registry.use({ account: "acct", bot: "x", run: "kept" }, KEY);
    // A browser for a run the manager is not tracking stays with its own run.
    await sessions.close();
    expect(fake.browsers[0]?.closed).toBe(false);
    await registry.closeAll();
  });
});
