import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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

export type FileKind = "file" | "directory" | "other";

export interface FileStat {
  kind: FileKind;
  size: number;
  /** Seconds since the epoch. */
  modified: number;
}

export interface DirEntry {
  name: string;
  kind: FileKind;
}

/** A file operation that failed for a reason the agent can act on. */
export class FileProblem extends Error {
  constructor(
    readonly reason: "missing" | "kind" | "failed",
    message: string,
  ) {
    super(message);
  }
}

/** A place where the agent's files live and its commands run. */
export interface Workspace {
  /** The working folder, as commands on this computer see it. */
  root: string;
  /** Where the bot's memory notes appear on this computer, when they appear there at all. */
  memoryPath?: string;
  run(command: string, opts: RunOptions): Promise<RunResult>;
  /**
   * Resolves `given` against `root`, following links, even where later parts do not exist yet.
   * Null when the result is outside `root`. The other file operations take what this returns.
   */
  realpath(given: string): Promise<string | null>;
  /** Null when nothing is there. */
  stat(path: string): Promise<FileStat | null>;
  /** The folder's entries, sorted by name. */
  list(path: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<Buffer>;
  /** Creates or replaces the file, making its parent folders. */
  writeFile(path: string, data: string | Buffer): Promise<void>;
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
    realpath: (given) => confine(root, given),
    async stat(target) {
      const info = await stat(target).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
      if (!info) return null;
      const kind = info.isFile() ? "file" : info.isDirectory() ? "directory" : "other";
      return { kind, size: info.size, modified: Math.floor(info.mtimeMs / 1000) };
    },
    async list(target) {
      const entries = await readdir(target, { withFileTypes: true });
      const kinds = await Promise.all(
        entries.map(async (e): Promise<DirEntry> => {
          // A link is listed as whatever it leads to.
          const info = e.isSymbolicLink()
            ? await stat(path.join(target, e.name)).catch(() => null)
            : e;
          const kind = info?.isFile() ? "file" : info?.isDirectory() ? "directory" : "other";
          return { name: e.name, kind };
        }),
      );
      return kinds.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    readFile: (target) => readFile(target),
    async writeFile(target, data) {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    async stop() {},
    async remove() {},
  };
}

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolves `given` inside the workspace, following links; null when it leaves. */
async function confine(root: string, given: string): Promise<string | null> {
  const realRoot = await realpath(root);
  let existing = path.resolve(root, given);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      const full = path.join(real, ...rest);
      return inside(realRoot, full) ? full : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // A dangling link would be followed on write, so where it leads is unknown.
      const info = await lstat(existing).catch(() => null);
      if (info?.isSymbolicLink()) return null;
      const parent = path.dirname(existing);
      if (parent === existing) return null;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}
