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

const SECRET_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "CLOUDFLARE_API_TOKEN",
]);

/** The environment a command may see, without keys or tokens. */
export function scrubbedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const secret =
      SECRET_NAMES.has(upper) ||
      upper.startsWith("BOTT_") ||
      upper.endsWith("_TOKEN") ||
      upper.endsWith("_SECRET") ||
      upper.endsWith("_API_KEY");
    if (!secret) out[name] = value;
  }
  return out;
}

/** Decides each tool call before it runs. `ask` resolves true when the person approves. */
export function makeBeforeToolCall(
  policy: Policy,
  ask: (call: ToolCall) => Promise<boolean>,
  readOnlyTools: ReadonlySet<string> = new Set(["Read"]),
): BeforeToolCall {
  return async (call) => {
    if (readOnlyTools.has(call.name)) return { allow: true };
    switch (policy) {
      case "auto":
        return { allow: true };
      case "deny":
        return { allow: false, reason: `${call.name} is not allowed by this bot's policy.` };
      case "ask":
        return (await ask(call))
          ? { allow: true }
          : { allow: false, reason: `The person declined ${call.name}.` };
      case "engine": {
        const command = (call.input as { command?: unknown } | null)?.command;
        const reason =
          call.name === "Bash" && typeof command === "string" ? blockedCommand(command) : null;
        return reason ? { allow: false, reason } : { allow: true };
      }
    }
  };
}
