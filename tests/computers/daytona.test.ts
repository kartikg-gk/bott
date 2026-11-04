import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileTools } from "../../src/agent/tools/files.ts";
import type { RunOptions, Workspace } from "../../src/agent/tools/workspace.ts";
import { textOf } from "../../src/agent/transcript.ts";
import {
  daytonaComputer,
  IDLE_MINUTES,
  SANDBOX_MEMORY,
  SANDBOX_ROOT,
} from "../../src/computers/daytona.ts";
import { SCRIPTS } from "../../src/computers/posix.ts";
import { FakeDaytona } from "../support/fakeDaytona.ts";

let fake: FakeDaytona;
let base: string;
const made: Workspace[] = [];

beforeEach(async () => {
  fake = new FakeDaytona();
  await fake.start();
  base = mkdtempSync(join(tmpdir(), "daytona-"));
  mkdirSync(join(base, "memory"));
  writeFileSync(join(base, "memory", "KNOWLEDGE.md"), "# Knowledge\nfact\n");
  writeFileSync(join(base, "memory", "notes.txt"), "not a note file");
});
afterEach(async () => {
  // Stopping lets go of each client's connections.
  await Promise.allSettled(made.splice(0).map((ws) => ws.stop()));
  await fake.close();
  rmSync(base, { recursive: true, force: true });
});

function computer(overrides: { apiKey?: string; network?: "open" | "closed" } = {}) {
  const ws = daytonaComputer({
    name: "bott-bot-main-abc",
    instance: "main",
    memoryDir: join(base, "memory"),
    snapshot: "bott-snapshot",
    target: "us",
    archiveMinutes: 60,
    network: "open",
    apiKey: "test-key",
    apiUrl: fake.url,
    ...overrides,
  });
  made.push(ws);
  return ws;
}

const opts = (signal = new AbortController().signal): RunOptions => ({
  timeoutMs: 30_000,
  signal,
  env: {},
});

describe("daytona computer", () => {
  it("needs an API key before it contacts anyone", async () => {
    const saved = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      const ws = computer({ apiKey: "" });
      await expect(ws.run("x", opts())).rejects.toThrow(
        "DAYTONA_API_KEY is not set, so the bot's sandbox cannot be reached",
      );
      await expect(ws.remove()).rejects.toThrow(
        "DAYTONA_API_KEY is not set, so the sandbox cannot be deleted and the bot is kept",
      );
      expect(fake.seen).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.DAYTONA_API_KEY = saved;
    }
  });

  it("creates a sandbox on first use, copies the notes up and runs there", async () => {
    const commands: { command: string; cwd: string | undefined }[] = [];
    fake.executor = (command, cwd) => {
      commands.push({ command, cwd });
      return { exitCode: 0, result: command.startsWith("echo") ? "hi\n" : "" };
    };
    const ws = computer();
    expect(ws.root).toBe(SANDBOX_ROOT);
    expect(ws.memoryPath).toBe(SANDBOX_MEMORY);

    expect(await ws.run("echo hi", opts())).toEqual({
      code: 0,
      stdout: "hi\n",
      stderr: "",
      timedOut: false,
    });
    const sandbox = fake.sandboxes.get("bott-bot-main-abc");
    expect(sandbox).toMatchObject({
      snapshot: "bott-snapshot",
      networkBlockAll: false,
      autoStopInterval: IDLE_MINUTES,
      autoArchiveInterval: 60,
    });
    expect(sandbox?.labels.bott).toBe("main");
    expect(commands[0]?.command).toBe(`mkdir -p '${SANDBOX_ROOT}' '${SANDBOX_MEMORY}'`);
    expect(commands.at(-1)).toEqual({ command: "echo hi", cwd: SANDBOX_ROOT });
    const files = fake.files.get(sandbox?.id as string);
    expect(files?.get(`${SANDBOX_MEMORY}/KNOWLEDGE.md`)?.toString()).toBe("# Knowledge\nfact\n");
    expect(files?.has(`${SANDBOX_MEMORY}/notes.txt`)).toBe(false);
  });

  it("makes a closed sandbox when the network setting is closed", async () => {
    await computer({ network: "closed" }).run("true", opts());
    expect(fake.sandboxes.get("bott-bot-main-abc")?.networkBlockAll).toBe(true);
  });

  it("opens the network of an existing sandbox when the setting is open", async () => {
    fake.add({ name: "bott-bot-main-abc", state: "started", networkBlockAll: true });
    await computer().run("true", opts());
    expect(fake.sandboxes.get("bott-bot-main-abc")?.networkBlockAll).toBe(false);
  });

  it("starts an existing sandbox instead of making another, and closes its network", async () => {
    fake.add({ name: "bott-bot-main-abc", state: "stopped", networkBlockAll: false });
    await computer({ network: "closed" }).run("true", opts());
    expect(fake.calls()).not.toContain("POST /sandbox");
    expect(fake.calls()).toContain("POST /sandbox/sb-1/start");
    expect(fake.sandboxes.get("bott-bot-main-abc")).toMatchObject({
      state: "started",
      networkBlockAll: true,
      autoArchiveInterval: 60,
    });
  });

  it("starts again after the sandbox stopped itself while idle", async () => {
    const ws = computer();
    await ws.run("true", opts());
    (fake.sandboxes.get("bott-bot-main-abc") as { state: string }).state = "stopped";
    await ws.run("true", opts());
    expect(fake.sandboxes.get("bott-bot-main-abc")?.state).toBe("started");
    expect(fake.calls().filter((c) => c === "POST /sandbox")).toHaveLength(1);
  });

  it("gives up waiting on a command when the run is stopped", async () => {
    fake.executor = (command) =>
      command.startsWith("sleep") ? new Promise(() => {}) : { exitCode: 0, result: "" };
    const ws = computer();
    const stop = new AbortController();
    const running = ws.run("sleep 100", opts(stop.signal));
    setTimeout(() => stop.abort(), 50);
    expect(await running).toMatchObject({ code: null, timedOut: false });
  });

  it("stops keeping files, and removes the sandbox", async () => {
    const ws = computer();
    await ws.stop();
    expect(fake.seen).toEqual([]);
    await ws.run("true", opts());
    await ws.stop();
    expect(fake.sandboxes.get("bott-bot-main-abc")?.state).toBe("stopped");
    await ws.remove();
    expect(fake.sandboxes.has("bott-bot-main-abc")).toBe(false);
    await expect(ws.remove()).resolves.toBeUndefined();
  });
});

/** Splits `sh -c 'script' sh 'a' 'b'` back into the script and its arguments. */
function words(command: string): string[] {
  return [...command.matchAll(/'((?:[^']|''')*)'/g)].map((m) =>
    (m[1] as string).replaceAll("'''", "'"),
  );
}

describe("daytona files", () => {
  it("are confined to the workspace and travel through the file service", async () => {
    fake.executor = (command, _cwd, sandbox) => {
      if (!command.startsWith("sh -c")) return { exitCode: 0, result: "" };
      const [script, ...args] = words(command);
      const stored = fake.files.get(sandbox.id) as Map<string, Buffer>;
      if (script === SCRIPTS.realpath) {
        return {
          exitCode: 0,
          result: `${args[0]}\n${posix.resolve(args[0] as string, args[1] as string)}`,
        };
      }
      if (script === SCRIPTS.check) {
        const path = args[0] as string;
        if (stored.has(path)) return { exitCode: 0, result: "" };
        const folder = [...stored.keys()].some((k) => k.startsWith(`${path}/`));
        return { exitCode: folder ? 4 : 3, result: "" };
      }
      if (script === SCRIPTS.parent) return { exitCode: 0, result: "" };
      return { exitCode: 1, result: "unexpected script" };
    };
    const tools = fileTools(computer());
    const run = (name: string, input: unknown) =>
      (tools.find((t) => t.name === name) as (typeof tools)[number]).run(input, {
        signal: new AbortController().signal,
      });

    const wrote = await run("Write", { path: "notes/a.txt", content: "hello\nthere\n" });
    expect(wrote.isError).toBeUndefined();
    const sandbox = fake.sandboxes.get("bott-bot-main-abc") as { id: string };
    const stored = fake.files.get(sandbox.id);
    expect(stored?.get(`${SANDBOX_ROOT}/notes/a.txt`)?.toString()).toBe("hello\nthere\n");

    expect(textOf((await run("Read", { path: "notes/a.txt" })).content)).toBe("1\thello\n2\tthere");
    const outside = await run("Read", { path: "../../../etc/passwd" });
    expect(textOf(outside.content)).toBe("Path is outside the workspace: ../../../etc/passwd");
    const missing = await run("Read", { path: "nope.txt" });
    expect(textOf(missing.content)).toBe(
      `Cannot read nope.txt: ${SANDBOX_ROOT}/nope.txt does not exist`,
    );
    const folder = await run("Read", { path: "notes" });
    expect(textOf(folder.content)).toBe(`Cannot read notes: ${SANDBOX_ROOT}/notes is not a file`);
  });
});
