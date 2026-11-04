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
  root: string;
  run(command: string, opts: RunOptions): Promise<RunResult>;
}

/** Most output kept per stream, so a runaway command cannot exhaust memory. */
const STREAM_LIMIT = 5_000_000;

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

/** Runs commands on this machine, in `root`. */
export function localWorkspace(root: string): Workspace {
  return {
    root,
    run(command, opts) {
      return new Promise((resolve) => {
        const base = {
          cwd: root,
          env: opts.env as NodeJS.ProcessEnv,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
          windowsHide: true,
        };
        const child = hasBash()
          ? spawn("bash", ["-c", command], base)
          : spawn(command, { ...base, shell: true });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;
        const take = (current: string, chunk: Buffer) =>
          current.length >= STREAM_LIMIT ? current : current + chunk.toString("utf8");
        child.stdout.on("data", (c: Buffer) => {
          stdout = take(stdout, c);
        });
        child.stderr.on("data", (c: Buffer) => {
          stderr = take(stderr, c);
        });

        const stop = () => killTree(child.pid);
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, opts.timeoutMs);
        opts.signal.addEventListener("abort", stop, { once: true });
        if (opts.signal.aborted) stop();

        const finish = (code: number | null, extra = "") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          opts.signal.removeEventListener("abort", stop);
          resolve({ code, stdout, stderr: stderr + extra, timedOut });
        };
        child.on("error", (err) => finish(null, `Failed to start command: ${err.message}`));
        child.on("close", (code) => finish(code));
      });
    },
  };
}
