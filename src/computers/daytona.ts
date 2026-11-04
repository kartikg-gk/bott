import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Daytona, Sandbox } from "@daytonaio/sdk";
import type { RunOptions, RunResult, Workspace } from "../agent/tools/workspace.ts";
import { ComputerError } from "./docker.ts";
import { checked, posixFiles, SCRIPTS, type Shell } from "./posix.ts";
import { quote } from "./shell.ts";

/** Where the bot works inside its sandbox. */
export const SANDBOX_ROOT = "/home/daytona/workspace";
/** Where a copy of the bot's memory notes is placed inside its sandbox. */
export const SANDBOX_MEMORY = "/home/daytona/memory";
/** A sandbox nobody uses for this long stops itself; its files stay. */
export const IDLE_MINUTES = 15;
/** Extra time the gateway waits beyond a command's own deadline. */
const EXEC_GRACE_MS = 10_000;
const PREPARE_SECONDS = 60;
const FILE_SECONDS = 30;

export interface DaytonaOptions {
  name: string;
  /** Labels the sandbox, so an account's sandboxes can be told apart by gateway. */
  instance: string;
  /** The bot's memory notes on this machine, copied up when the sandbox starts. */
  memoryDir: string;
  snapshot: string | null;
  target: string | null;
  archiveMinutes: number;
  /** Defaults to DAYTONA_API_KEY. */
  apiKey?: string;
  /** Defaults to the service's own address, or DAYTONA_API_URL. */
  apiUrl?: string;
}

type Sdk = typeof import("@daytonaio/sdk");

let loaded: Promise<Sdk> | undefined;
/** The SDK is heavy, so it is loaded only when a sandbox is first needed. */
function sdk(): Promise<Sdk> {
  loaded ??= import("@daytonaio/sdk");
  return loaded;
}

const started = (sandbox: Sandbox) => String(sandbox.state ?? "").toLowerCase() === "started";

/**
 * A persistent Daytona sandbox per bot. It keeps its files between runs and stops itself when
 * idle; each use starts it again if it did. The gateway's environment never reaches it.
 */
export function daytonaComputer(opts: DaytonaOptions): Workspace {
  let client: Daytona | undefined;
  let sandbox: Sandbox | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  /** Runs `step` after every earlier one, so starts and stops never overlap. */
  function locked<T>(step: () => Promise<T>): Promise<T> {
    const next = chain.then(step, step);
    chain = next.catch(() => {});
    return next;
  }

  async function connect(purpose: string): Promise<{ api: Sdk; daytona: Daytona }> {
    const apiKey = opts.apiKey ?? process.env.DAYTONA_API_KEY;
    if (!apiKey) throw new ComputerError(`Set DAYTONA_API_KEY to ${purpose}`);
    const api = await sdk();
    client ??= new api.Daytona({
      apiKey,
      ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
      ...(opts.target ? { target: opts.target } : {}),
    });
    return { api, daytona: client };
  }

  async function disconnect(): Promise<void> {
    const current = client;
    client = sandbox = undefined;
    await current?.[Symbol.asyncDispose]().catch(() => {});
  }

  async function exec(box: Sandbox, command: string, seconds: number) {
    return box.process.executeCommand(command, SANDBOX_ROOT, undefined, seconds);
  }

  async function start(): Promise<Sandbox> {
    const { api, daytona } = await connect("run bots on Daytona");
    let box: Sandbox;
    try {
      box = await daytona.get(opts.name);
      // Sandboxes are kept off the network; one made before that rule is closed off now.
      if (box.networkBlockAll === false) await box.updateNetworkSettings({ networkBlockAll: true });
      if (!started(box)) await box.start();
    } catch (err) {
      if (!(err instanceof api.DaytonaNotFoundError)) throw err;
      box = await daytona.create({
        name: opts.name,
        ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
        networkBlockAll: true,
        autoStopInterval: IDLE_MINUTES,
        autoArchiveInterval: opts.archiveMinutes,
        labels: { bott: opts.instance },
      });
    }
    await box.setAutoArchiveInterval(opts.archiveMinutes);
    const made = await exec(
      box,
      `mkdir -p ${quote(SANDBOX_ROOT)} ${quote(SANDBOX_MEMORY)}`,
      PREPARE_SECONDS,
    );
    if (made.exitCode !== 0) throw new ComputerError("The bot workspace could not be set up");
    const names = await readdir(opts.memoryDir).catch(() => [] as string[]);
    for (const file of names.filter((n) => n.endsWith(".md"))) {
      const data = await readFile(join(opts.memoryDir, file));
      await box.fs.uploadFile(data, `${SANDBOX_MEMORY}/${file}`);
    }
    sandbox = box;
    return box;
  }

  /** The started sandbox, starting it again when it stopped itself while idle. */
  function ready(): Promise<Sandbox> {
    return locked(async () => {
      if (!sandbox) return start();
      await sandbox.refreshData();
      if (!started(sandbox)) await sandbox.start();
      return sandbox;
    });
  }

  const sh: Shell = async (script, args) => {
    const box = await ready();
    const line = `sh -c ${quote(script)} sh ${args.map(quote).join(" ")}`;
    const result = await exec(box, line, FILE_SECONDS);
    return { code: result.exitCode, stdout: Buffer.from(result.result ?? "", "utf8") };
  };
  const files = posixFiles(sh, SANDBOX_ROOT);

  return {
    root: SANDBOX_ROOT,
    memoryPath: SANDBOX_MEMORY,
    realpath: files.realpath,
    stat: files.stat,
    list: files.list,
    // Contents travel through the file service, so bytes arrive as they are.
    async readFile(path) {
      checked((await sh(SCRIPTS.check, [path])).code, path, "read");
      return (await ready()).fs.downloadFile(path);
    },
    async writeFile(path, data) {
      checked((await sh(SCRIPTS.parent, [path])).code, path, "write");
      await (await ready()).fs.uploadFile(Buffer.from(data), path);
    },
    async run(command: string, run: RunOptions): Promise<RunResult> {
      const box = await ready();
      const seconds = Math.max(1, Math.ceil(run.timeoutMs / 1000));
      let timer: NodeJS.Timeout | undefined;
      let onAbort = () => {};
      const late = new Promise<RunResult>((resolve) => {
        const give = (timedOut: boolean) =>
          resolve({ code: null, stdout: "", stderr: "", timedOut });
        timer = setTimeout(() => give(true), run.timeoutMs + EXEC_GRACE_MS);
        onAbort = () => give(false);
        run.signal.addEventListener("abort", onAbort, { once: true });
        if (run.signal.aborted) onAbort();
      });
      const done = exec(box, command, seconds).then(
        (r): RunResult => ({
          code: r.exitCode,
          stdout: r.result ?? "",
          stderr: "",
          timedOut: false,
        }),
        async (err: unknown): Promise<RunResult> => {
          const api = await sdk();
          if (err instanceof api.DaytonaTimeoutError) {
            return { code: null, stdout: "", stderr: "", timedOut: true };
          }
          throw err;
        },
      );
      // A command that settles after its deadline is no longer anyone's concern.
      done.catch(() => {});
      try {
        return await Promise.race([done, late]);
      } finally {
        clearTimeout(timer);
        run.signal.removeEventListener("abort", onAbort);
      }
    },
    stop() {
      return locked(async () => {
        if (!sandbox) return;
        try {
          await sandbox.refreshData();
          if (started(sandbox)) await sandbox.stop();
        } finally {
          await disconnect();
        }
      });
    },
    remove() {
      return locked(async () => {
        const { api, daytona } = await connect("remove this sandbox");
        try {
          await daytona.delete(await daytona.get(opts.name));
        } catch (err) {
          if (!(err instanceof api.DaytonaNotFoundError)) throw err;
        } finally {
          await disconnect();
        }
      });
    },
  };
}
