import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider, ProviderRequest } from "../../src/agent/providers/types.ts";
import { localWorkspace, type Workspace } from "../../src/agent/tools/workspace.ts";
import { emptyUsage } from "../../src/agent/transcript.ts";
import { botRoot } from "../../src/bots/bots.ts";
import type { ComputerFactory } from "../../src/computers/index.ts";
import { computerSettings } from "../../src/computers/settings.ts";
import type { Database } from "../../src/db/database.ts";
import { type RuntimeConfig, SessionManager } from "../../src/runtime/sessions.ts";
import { Store } from "../../src/store/store.ts";
import { type Backend, backends, database } from "../support/fakeD1.ts";

function provider(seen: ProviderRequest[]): ModelProvider {
  return {
    id: "fake",
    async *stream(req) {
      seen.push(req);
      yield { type: "start", model: "m" };
      yield {
        type: "end",
        entry: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          model: "m",
          usage: emptyUsage(),
          stop: "end",
        },
      };
    },
  };
}

/** Computers that keep what was asked of them. */
function fakeComputers() {
  const made: { botId: string; ws: Workspace; stopped: number; removed: number }[] = [];
  const factory: ComputerFactory = (_settings, place) => {
    const entry = {
      botId: place.bot.id,
      stopped: 0,
      removed: 0,
      ws: undefined as unknown as Workspace,
    };
    entry.ws = {
      ...localWorkspace(place.hostRoot),
      memoryPath: "/bot/memory",
      async stop() {
        entry.stopped++;
      },
      async remove() {
        entry.removed++;
      },
    };
    made.push(entry);
    return entry.ws;
  };
  return { factory, made };
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

  async function setup(executor: "local" | "docker" | "daytona") {
    const { db } = database(kind);
    open.push(db);
    const store = await Store.open(db, "main", { clock: () => 1_800_000_000 });
    const root = mkdtempSync(join(tmpdir(), "computers-"));
    folders.push(root);
    const config: RuntimeConfig = {
      stateDir: join(root, "state"),
      projectDir: join(root, "project"),
      sessionsDir: join(root, "sessions"),
      policy: "auto",
      model: "m",
      idleSeconds: 60,
      computer: computerSettings(
        executor === "docker" ? { executor, dockerImage: "debian:bookworm-slim" } : { executor },
      ),
    };
    const seen: ProviderRequest[] = [];
    const computers = fakeComputers();
    const sessions = new SessionManager(config, store, () => provider(seen), computers.factory);
    managers.push(sessions);
    return { store, config, sessions, seen, computers };
  }

  it("only this machine is unsandboxed", async () => {
    expect((await setup("local")).sessions.sandboxed).toBe(false);
    expect((await setup("docker")).sessions.sandboxed).toBe(true);
    expect((await setup("daytona")).sessions.sandboxed).toBe(true);
  });

  it("gives each bot one computer and shows where its notes are", async () => {
    const { store, sessions, seen, computers } = await setup("docker");
    const chief = { ...(await store.chief()), chief: true };
    expect(sessions.workspaceFor(chief)).toBe(sessions.workspaceFor(chief));
    await sessions.prompt(await store.conversation(1, 1), "hi");
    expect(computers.made).toHaveLength(1);
    expect(seen[0]?.system).toContain("Your memory files are in /bot/memory.");
  });

  it("stops every computer when it closes", async () => {
    const { store, sessions, computers } = await setup("docker");
    sessions.workspaceFor({ ...(await store.chief()), chief: true });
    await sessions.close();
    expect(computers.made[0]?.stopped).toBe(1);
  });

  it("removing a temporary bot removes its computer, rows and folder", async () => {
    const { store, config, sessions, computers } = await setup("docker");
    const helper = await store.createBot({ name: "Helper", role: "helps", temporary: true });
    sessions.workspaceFor(helper);
    mkdirSync(join(botRoot(config.stateDir, helper), "memory"), { recursive: true });

    expect(await sessions.removeBot(helper.id)).toBe(true);
    expect(computers.made[0]?.removed).toBe(1);
    expect(await store.bot(helper.id)).toBeNull();
    expect(existsSync(botRoot(config.stateDir, helper))).toBe(false);
    expect(await sessions.removeBot(helper.id)).toBe(false);
  });

  it("a kept bot and the chief keep their computers", async () => {
    const { store, sessions, computers } = await setup("docker");
    const kept = await store.createBot({ name: "Kept", role: "stays" });
    await expect(sessions.removeBot(kept.id)).rejects.toThrow(
      "Only a temporary bot can be removed",
    );
    await expect(sessions.removeBot((await store.chief()).id)).rejects.toThrow(
      "The chief of staff cannot be removed",
    );
    expect(computers.made.every((m) => m.removed === 0)).toBe(true);
  });
});
