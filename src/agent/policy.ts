import { statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { BeforeToolCall, ToolCall } from "./engine.ts";

export type Policy = "engine" | "ask" | "deny" | "auto";

/**
 * Shell rules are plain string matching over the command text. They stop
 * careless destructive commands; they are a guard rail, not a sandbox, and a
 * determined command can get around them.
 */
const family = (names: string) => `(?<![\\w.-])(?:${names})(?:\\.exe)?(?![\\w.-])`;

const DELETION = family(
  "rm|rmdir|shred|truncate|dd|mkfs(?:\\.[a-z0-9]+)?|wipefs|fdisk|parted|remove-item|clear-disk|format-volume",
);
const FIND_DELETE = `${family("find")}[^\\n;&|]*\\s-delete\\b`;
const SYSTEM = family("sudo|su|doas|chmod|chown|shutdown|reboot|poweroff|halt");
const WINDOWS = family(
  "del|erase|rd|diskpart|format|takeown|icacls|stop-computer|restart-computer",
);
const GIT = family("git");
const DOWNLOAD = family("curl|wget|invoke-webrequest|iwr");
const SHELL = family("sh|bash|dash|zsh|fish|pwsh|powershell|cmd|iex|invoke-expression");

const RULES: [RegExp, string][] = [
  [new RegExp(DELETION, "i"), "File deletion and disk changes are refused."],
  [new RegExp(FIND_DELETE, "i"), "File deletion and disk changes are refused."],
  [new RegExp(SYSTEM, "i"), "Privilege and system access changes are refused."],
  [
    new RegExp(
      `${GIT}[^\\n;&|]*(?:\\bclean\\b|\\breset\\b[^\\n;&|]*--hard\\b|\\bpush\\b[^\\n;&|]*(?:--force\\b|(?:^|\\s)-[a-z]*f[a-z]*\\b|\\s\\+\\S+))`,
      "i",
    ),
    "Destructive Git commands are refused.",
  ],
  [
    new RegExp(`${DOWNLOAD}[^\\n;]*?(?<!\\|)\\|(?!\\|)[^;]*?${SHELL}`, "i"),
    "Piping a download into a shell is refused.",
  ],
];
const WINDOWS_RULE = new RegExp(WINDOWS, "i");

/** The reason a shell command is refused, or null when it may run. */
export function blockedCommand(
  command: string,
  windows: boolean = process.platform === "win32",
): string | null {
  // Join quoted fragments and line continuations before matching command names.
  let script = command.replace(/\\\r?\n/g, "").replace(/["']/g, "");
  if (windows) {
    script = script.replace(/[\^`]/g, "");
    if (WINDOWS_RULE.test(script)) return "Destructive Windows commands are refused.";
  } else {
    script = script.replace(/\\([A-Za-z])/g, "$1");
  }
  for (const [pattern, reason] of RULES) if (pattern.test(script)) return reason;
  return null;
}

/** Options each read-only command may take; anything else makes the command need approval. */
const LOOKING: Record<string, RegExp> = {
  cat: /^-[AbEnstTv]+$/,
  echo: /^-[neE]+$/,
  head: /^(?:-\d+|-[ncvq]|--(?:lines|bytes)=\d+)$/,
  tail: /^(?:-\d+|-[ncvq]|--(?:lines|bytes)=\d+)$/,
  ls: /^(?:-[aAbBdFghilnoprRstU1]+|--(?:all|almost-all|directory|human-readable|recursive))$/,
  pwd: /^-[LP]$/,
  uname: /^(?:-[asnrvmpio]+|--all)$/,
  wc: /^(?:-[clmwL]+|--(?:bytes|chars|lines|words|max-line-length))$/,
  whoami: /^--(?:help|version)$/,
};
/** Commands that never take a file, so every word after the name must be an option. */
const ONLY_OPTIONS = new Set(["pwd", "uname", "whoami"]);
/** Plain words and spaces only: no redirection, pipes, substitution, quoting or globbing. */
const PLAIN = /^[A-Za-z0-9_./:\\=, \t-]+$/;

/**
 * Whether the command only looks at things, so it runs without asking under any policy. Only a
 * short list of commands in their plain form counts; anything unusual needs the normal checks.
 */
export function readOnlyCommand(
  command: string,
  windows: boolean = process.platform === "win32",
): boolean {
  if (!command.trim() || !PLAIN.test(command)) return false;
  const [name = "", ...rest] = command.trim().split(/\s+/);
  if (windows) {
    // cmd.exe answers these itself, whatever programs share their names.
    const lower = name.toLowerCase();
    return (lower === "dir" && rest.length === 0) || lower === "echo" || lower === "type";
  }
  const allowed = LOOKING[name];
  if (!allowed || command.includes("\\")) return false;
  for (const word of rest) {
    if (word === "--" && !ONLY_OPTIONS.has(name)) return true;
    if ((word.startsWith("-") || ONLY_OPTIONS.has(name)) && !allowed.test(word)) return false;
  }
  return true;
}

/** Files that steer later runs: skill packages, prompt files and a bot's notes. */
const INSTRUCTION_FILES = [
  "SKILL.md",
  "AGENTS.md",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "PREFERENCES.md",
  "KNOWLEDGE.md",
];
const INSTRUCTION_NAMES = new Set(INSTRUCTION_FILES.map((name) => name.toLowerCase()));
const NAMED_IN_COMMAND = new RegExp(
  `(?<![\\w.-])(?:${INSTRUCTION_FILES.map((name) => name.replace(/\./g, "\\.")).join("|")})(?![\\w.-])`,
  "i",
);

export interface GuardPlaces {
  /** The working folder that relative paths start from. */
  root: string;
  /** Folders whose files steer later runs, as the computer sees them. */
  roots: string[];
  /** Whether paths are POSIX paths, as on a container or sandbox. */
  posix: boolean;
  /** Whether shell commands run under Windows. */
  windows: boolean;
}

/** The file's own name, without a Windows stream suffix or the dots and spaces Windows drops. */
function baseName(path: string): string {
  const last = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return (
    last
      .split(":")[0]
      ?.replace(/[ .]+$/, "")
      .toLowerCase() ?? ""
  );
}

/** Shell words, with quotes removed and operators splitting them. */
function words(command: string, windows: boolean): string[] {
  const text = windows ? command.replace(/\\/g, "/").replace(/\^/g, "") : command;
  return text
    .replace(/["']/g, "")
    .split(/[\s|&;<>()]+/)
    .filter(Boolean);
}

/**
 * Says whether a Write, Edit or shell call touches a file that steers later runs. Such calls ask
 * the person even when the policy lets ordinary changes through.
 */
export function instructionGuard(places: GuardPlaces): (call: ToolCall) => boolean {
  const paths = places.posix ? posix : process.platform === "win32" ? win32 : posix;
  const roots = places.roots.map((root) => paths.resolve(root));
  const steers = (raw: string): boolean => {
    if (!raw.trim()) return false;
    if (INSTRUCTION_NAMES.has(baseName(raw))) return true;
    const full = paths.resolve(places.root, places.posix ? raw.replace(/\\/g, "/") : raw);
    if (INSTRUCTION_NAMES.has(baseName(full))) return true;
    for (const root of roots) {
      const inside = paths.relative(root, full);
      if (inside === "" || (!inside.startsWith("..") && !paths.isAbsolute(inside))) return true;
    }
    if (places.posix) return false;
    // A second name for the same file could reach a saved instruction file.
    try {
      const found = statSync(full);
      return found.isFile() && found.nlink > 1;
    } catch {
      return false;
    }
  };
  return (call) => {
    const input = (call.input ?? {}) as { path?: unknown; command?: unknown };
    if (call.name === "Write" || call.name === "Edit") {
      return typeof input.path === "string" && steers(input.path);
    }
    if (call.name !== "Bash" || typeof input.command !== "string") return false;
    if (NAMED_IN_COMMAND.test(input.command)) return true;
    return words(input.command, places.windows).some(
      (word) => steers(word) || (word.includes("=") && steers(word.slice(word.indexOf("=") + 1))),
    );
  };
}

/** The command of a shell call, or null for any other call. */
export function shellCommand(call: ToolCall): string | null {
  const command = (call.input as { command?: unknown } | null)?.command;
  return call.name === "Bash" && typeof command === "string" ? command : null;
}

const SECRET_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "CLOUDFLARE_API_TOKEN",
]);

/** The environment a command may see, without keys or tokens. */
const SECRET_SUFFIXES = [
  "_TOKEN",
  "_SECRET",
  "_API_KEY",
  "_KEY",
  "_PASSWORD",
  "_PASS",
  "_CREDENTIALS",
];

/** A URL carrying a user and password, such as postgres://user:pass@host/db. */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:[^/@\s]*@/i;

export function scrubbedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const secret =
      SECRET_NAMES.has(upper) ||
      upper.startsWith("BOTT_") ||
      upper.startsWith("AWS_") ||
      upper.includes("_SECRET_") ||
      SECRET_SUFFIXES.some((suffix) => upper.endsWith(suffix)) ||
      URL_WITH_CREDENTIALS.test(value);
    if (!secret) out[name] = value;
  }
  return out;
}

/**
 * Decides each tool call before it runs. `ask` resolves true when the person approves. `windows`
 * says whether shell commands run under Windows, which changes how they are read.
 */
export function makeBeforeToolCall(
  policy: Policy,
  ask: (call: ToolCall) => Promise<boolean>,
  readOnlyTools: ReadonlySet<string> = new Set(["Read"]),
  windows: boolean = process.platform === "win32",
): BeforeToolCall {
  return async (call) => {
    if (readOnlyTools.has(call.name)) return { allow: true };
    // Shell rules come before the policy: looking is always fine, blocked commands never are.
    const command = shellCommand(call);
    if (command !== null) {
      if (readOnlyCommand(command, windows)) return { allow: true };
      const reason = blockedCommand(command, windows);
      if (reason) return { allow: false, reason };
    }
    switch (policy) {
      case "auto":
        return { allow: true };
      case "deny":
        return { allow: false, reason: `${call.name} is not allowed by this bot's policy.` };
      case "ask":
        return (await ask(call))
          ? { allow: true }
          : { allow: false, reason: `The person declined ${call.name}.` };
      case "engine":
        return { allow: true };
    }
  };
}
