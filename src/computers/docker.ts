import { mkdir } from "node:fs/promises";
import {
  capture,
  type RunOptions,
  type RunResult,
  type Workspace,
} from "../agent/tools/workspace.ts";
import { posixFiles, type Shell } from "./posix.ts";
import { quote } from "./shell.ts";

/** Where the bot's workspace folder is mounted inside its container. */
export const CONTAINER_ROOT = "/workspace";
/** Where the bot's memory notes are mounted, read-only, inside its container. */
export const MEMORY_MOUNT = "/bot/memory";

export interface CliResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
}

export interface CliOptions {
  stdin?: Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Most bytes kept per stream. */
  limit?: number;
}

/** Runs one `docker` command. */
export type DockerCli = (args: string[], opts?: CliOptions) => Promise<CliResult>;

/** Docker management commands get this long; creating a container may pull its image. */
const CLI_TIMEOUT_MS = 60_000;
const CREATE_TIMEOUT_MS = 300_000;
/** Extra time the host waits beyond a command's own deadline inside the container. */
const EXEC_GRACE_MS = 5_000;
/** File operations get this long, and a file read this many bytes. */
const FILE_TIMEOUT_MS = 60_000;
const FILE_LIMIT = 64_000_000;

/** The real `docker` program. Its environment is this process's, which it needs to reach Docker. */
export const dockerCli: DockerCli = async (args, opts = {}) => {
  const result = await capture("docker", args, {
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs ?? CLI_TIMEOUT_MS,
    signal: opts.signal,
    limit: opts.limit,
  });
  return { ...result, stderr: result.stderr.toString("utf8") };
};

export interface DockerOptions {
  name: string;
  image: string;
  /** The container's memory limit, in Docker's notation. */
  memory: string;
  /** The bot's workspace folder on this machine. */
  hostRoot: string;
  /** The bot's memory notes on this machine. */
  memoryDir: string;
  /** Whether the container may reach the network. */
  network: "open" | "closed";
  cli?: DockerCli;
}

export class ComputerError extends Error {}

/** A bind mount in `--mount` notation; a field holding a comma is quoted as CSV. */
function bind(source: string, target: string, readOnly: boolean): string {
  const field = (text: string) => (text.includes(",") ? `"${text.replaceAll('"', '""')}"` : text);
  return ["type=bind", field(`source=${source}`), `target=${target}`]
    .concat(readOnly ? ["readonly"] : [])
    .join(",");
}

/**
 * Gives a bot its own Docker container. The container is made the first time it is needed and
 * then kept: `stop` halts it with the workspace intact, and `remove` deletes it. Nothing from the
 * gateway's environment is passed in, and network access follows the setting.
 */
export function dockerComputer(opts: DockerOptions): Workspace {
  const cli = opts.cli ?? dockerCli;
  let starting: Promise<void> | undefined;
  /** Set once a start was tried, so stopping knows there may be something to stop. */
  let touched = false;

  /** A container's network is fixed when it is made, so one made otherwise must be recreated. */
  async function verifyNetwork(): Promise<void> {
    const found = await cli(["inspect", "--format", "{{.HostConfig.NetworkMode}}", opts.name]);
    if (found.code !== 0)
      throw new ComputerError(`Docker would not report the network mode of ${opts.name}`);
    const closed = found.stdout.toString("utf8").trim() === "none";
    if (closed !== (opts.network === "closed")) {
      throw new ComputerError(
        `${opts.name} was made with its network ${closed ? "closed" : "open"}, but the setting is ${opts.network}; delete it so it is made again`,
      );
    }
  }

  async function verifyMounts(): Promise<void> {
    const found = await cli(["inspect", "--format", "{{json .Mounts}}", opts.name]);
    if (found.code !== 0)
      throw new ComputerError(`Docker would not list the mounts of ${opts.name}`);
    let readOnly = false;
    try {
      const mounts = JSON.parse(found.stdout.toString("utf8")) as {
        Destination?: string;
        RW?: boolean;
      }[];
      readOnly = mounts.some((m) => m.Destination === MEMORY_MOUNT && m.RW === false);
    } catch {
      throw new ComputerError(`Docker would not list the mounts of ${opts.name}`);
    }
    if (!readOnly) {
      throw new ComputerError(
        `${opts.name} can write to its notes; delete it so it is made again with ${MEMORY_MOUNT} read-only`,
      );
    }
  }

  async function start(): Promise<void> {
    touched = true;
    await mkdir(opts.hostRoot, { recursive: true });
    await mkdir(opts.memoryDir, { recursive: true });
    const state = await cli(["inspect", "--format", "{{.State.Running}}", opts.name]);
    let result: CliResult;
    if (state.code === 0) {
      await verifyNetwork();
      await verifyMounts();
      if (state.stdout.toString("utf8").trim() === "true") return;
      result = await cli(["start", opts.name]);
    } else {
      result = await cli(
        [
          "run",
          "-d",
          "--name",
          opts.name,
          ...(opts.network === "closed" ? ["--network", "none"] : []),
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "512",
          "--memory",
          opts.memory,
          "--mount",
          bind(opts.hostRoot, CONTAINER_ROOT, false),
          "--mount",
          bind(opts.memoryDir, MEMORY_MOUNT, true),
          "-w",
          CONTAINER_ROOT,
          opts.image,
          "sleep",
          "infinity",
        ],
        { timeoutMs: CREATE_TIMEOUT_MS },
      );
    }
    if (result.code !== 0) {
      throw new ComputerError(
        `Docker could not run ${opts.name} from ${opts.image}; is Docker up and the image there?`,
      );
    }
  }

  /** Starts the container once; a failed start is tried again by the next caller. */
  function ready(): Promise<void> {
    if (!starting) {
      starting = start().catch((err: unknown) => {
        starting = undefined;
        throw err;
      });
    }
    return starting;
  }

  const sh: Shell = async (script, args, stdin) => {
    await ready();
    const result = await cli(
      ["exec", ...(stdin ? ["-i"] : []), opts.name, "sh", "-c", script, "sh", ...args],
      { stdin, timeoutMs: FILE_TIMEOUT_MS, limit: FILE_LIMIT },
    );
    return { code: result.code, stdout: result.stdout };
  };

  return {
    root: CONTAINER_ROOT,
    memoryPath: MEMORY_MOUNT,
    ...posixFiles(sh, CONTAINER_ROOT),
    async run(command: string, run: RunOptions): Promise<RunResult> {
      await ready();
      // `timeout` inside the container ends the command as well, so a host-side kill leaves
      // nothing running in there.
      const seconds = Math.max(1, Math.ceil(run.timeoutMs / 1000));
      const began = Date.now();
      const result = await cli(
        [
          "exec",
          "-w",
          CONTAINER_ROOT,
          opts.name,
          "sh",
          "-c",
          `timeout -s KILL ${seconds} sh -c ${quote(command)}`,
        ],
        { timeoutMs: run.timeoutMs + EXEC_GRACE_MS, signal: run.signal },
      );
      return {
        code: result.code,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr,
        // The in-container deadline kills with signal 9, which the shell reports as 137.
        timedOut: result.timedOut || (result.code === 137 && Date.now() - began >= seconds * 1000),
      };
    },
    async stop() {
      if (!touched) return;
      // A start still under way would bring the container back up after the stop.
      const pending = starting;
      starting = undefined;
      await pending?.catch(() => {});
      const result = await cli(["stop", "-t", "5", opts.name]);
      if (result.code !== 0 && !result.stderr.includes("No such container")) {
        throw new ComputerError(`Docker could not halt ${opts.name}`);
      }
    },
    async remove() {
      starting = undefined;
      touched = false;
      const result = await cli(["rm", "-f", opts.name]);
      if (result.code !== 0 && !result.stderr.includes("No such container")) {
        throw new ComputerError(`Docker could not delete ${opts.name}`);
      }
    },
  };
}
