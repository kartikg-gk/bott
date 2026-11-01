import { spawn, spawnSync } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs: number;
  signal: AbortSignal;
  env: Record<string, string | undefined>;
}

/** A place where the agent's files live and its commands run. */
export interface Workspace {
  /** The working folder, as commands on this computer see it. */
  root: string;
  /** Where the bot's memory notes appear on this computer, when they appear there at all. */
  memoryPath?: string;
  run(command: string, opts: RunOptions): Promise<RunResult>;
  /** Lets the computer go idle; its files stay. */
  stop(): Promise<void>;
  /** Deletes the computer and whatever lives only on it. */
  remove(): Promise<void>;
}

/** Most output kept per stream, so a runaway command cannot exhaust memory. */
export const STREAM_LIMIT = 5_000_000;

export interface Captured {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

export interface CaptureOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Sent to the program's input, which is otherwise closed. */
  stdin?: Buffer;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Most bytes kept per stream. */
  limit?: number;
  /** Runs `file` through the system shell instead of directly. */
  shell?: boolean;
}

let bashFound: boolean | undefined;
function hasBash(): boolean {
  if (bashFound === undefined) {
    try {
      bashFound = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
      bashFound = false;
    }
  }
  return bashFound;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // The process already exited.
  }
}

/**
 * Runs a program and keeps what it prints. It is killed, with its children, when the deadline
 * passes or the signal aborts. A program that cannot start settles with a null code.
 */
export function capture(file: string, args: string[], opts: CaptureOptions): Promise<Captured> {
  const limit = opts.limit ?? STREAM_LIMIT;
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
      detached: process.platform !== "win32",
      stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: opts.shell ?? false,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let settled = false;
    child.stdout?.on("data", (c: Buffer) => {
      if (outBytes < limit) out.push(c);
      outBytes += c.length;
    });
    child.stderr?.on("data", (c: Buffer) => {
      if (errBytes < limit) err.push(c);
      errBytes += c.length;
    });
    if (child.stdin) {
      // A program that exits without reading its input is not an error.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin);
    }

    const stop = () => killTree(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    opts.signal?.addEventListener("abort", stop, { once: true });
    if (opts.signal?.aborted) stop();

    const finish = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", stop);
      const stderr = Buffer.concat([...err, Buffer.from(extra)]);
      resolve({ code, stdout: Buffer.concat(out), stderr, timedOut });
    };
    child.on("error", (e) => finish(null, `Failed to start command: ${e.message}`));
    child.on("close", (code) => finish(code));
  });
}

/** Runs commands on this machine, in `root`. */
export function localWorkspace(root: string): Workspace {
  return {
    root,
    async run(command, opts) {
      const base = { cwd: root, env: opts.env, timeoutMs: opts.timeoutMs, signal: opts.signal };
      const result = hasBash()
        ? await capture("bash", ["-c", command], base)
        : await capture(command, [], { ...base, shell: true });
      return {
        code: result.code,
        stdout: result.stdout.toString("utf8"),
        stderr: result.stderr.toString("utf8"),
        timedOut: result.timedOut,
      };
    },
    async stop() {},
    async remove() {},
  };
}
