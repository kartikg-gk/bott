import { mkdir } from "node:fs/promises";
import {
  capture,
  type RunOptions,
  type RunResult,
  type Workspace,
} from "../agent/tools/workspace.ts";
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
}

/** Runs one `docker` command. */
export type DockerCli = (args: string[], opts?: CliOptions) => Promise<CliResult>;

/** Docker management commands get this long; creating a container may pull its image. */
const CLI_TIMEOUT_MS = 60_000;
const CREATE_TIMEOUT_MS = 300_000;
/** Extra time the host waits beyond a command's own deadline inside the container. */
const EXEC_GRACE_MS = 5_000;

/** The real `docker` program. Its environment is this process's, which it needs to reach Docker. */
export const dockerCli: DockerCli = async (args, opts = {}) => {
  const result = await capture("docker", args, {
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs ?? CLI_TIMEOUT_MS,
    signal: opts.signal,
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
 * A long-lived container per bot, created or started on first use. Stopping keeps its files.
 * Commands see none of the gateway's environment.
 */
export function dockerComputer(opts: DockerOptions): Workspace {
  const cli = opts.cli ?? dockerCli;
  let starting: Promise<void> | undefined;
  /** Set once a start was tried, so stopping knows there may be something to stop. */
  let touched = false;

  async function verifyMounts(): Promise<void> {
    const found = await cli(["inspect", "--format", "{{json .Mounts}}", opts.name]);
    if (found.code !== 0)
      throw new ComputerError("The container read-only mounts could not be checked");
    let readOnly = false;
    try {
      const mounts = JSON.parse(found.stdout.toString("utf8")) as {
        Destination?: string;
        RW?: boolean;
      }[];
      readOnly = mounts.some((m) => m.Destination === MEMORY_MOUNT && m.RW === false);
    } catch {
      throw new ComputerError("The container read-only mounts could not be checked");
    }
    if (!readOnly) {
      throw new ComputerError(
        `Container ${opts.name} needs to be recreated with read-only bot note mounts`,
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
      throw new ComputerError("The bot container did not start; look at Docker and the image");
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

  return {
    root: CONTAINER_ROOT,
    memoryPath: MEMORY_MOUNT,
    async run(command: string, run: RunOptions): Promise<RunResult> {
      await ready();
      // The deadline also holds inside the container, so a killed exec leaves nothing behind.
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
      starting = undefined;
      const result = await cli(["stop", "-t", "5", opts.name]);
      if (result.code !== 0 && !result.stderr.includes("No such container")) {
        throw new ComputerError("The bot container did not stop; look at Docker");
      }
    },
    async remove() {
      starting = undefined;
      touched = false;
      const result = await cli(["rm", "-f", opts.name]);
      if (result.code !== 0 && !result.stderr.includes("No such container")) {
        throw new ComputerError("The bot container was not removed; look at Docker");
      }
    },
  };
}
