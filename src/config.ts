/**
 * The server's settings, read once from environment variables. Everything the gateway needs to
 * start comes from here, so the same build runs on this machine, on a server and as a hosted
 * function: only the variables differ.
 */

import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CLIENT_ID_VARIABLE, CLIENT_SECRET_VARIABLE, canonicalOrigin } from "./accounts/google.ts";
import { TOKEN_VARIABLE } from "./accounts/localToken.ts";
import { PROVIDERS } from "./accounts/models.ts";
import { MASTER_KEY_VARIABLE } from "./accounts/sealing.ts";
import type { Policy } from "./agent/policy.ts";
import { THINKING_LEVELS } from "./agent/thinking.ts";
import { type ComputerSettings, computerSettings } from "./computers/settings.ts";
import { D1_VARIABLES } from "./db/database.ts";
import { DEFAULT_LIMITS, type LimitsConfig } from "./limits/limits.ts";
import { type MemoryConfig, readMemoryConfig } from "./memory/config.ts";
import { PROXY_SECRET_VARIABLE } from "./web/app.ts";

/** A setting is missing, malformed or does not fit with the others. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export type Env = Record<string, string | undefined>;

export interface Config {
  /** Serving as a hosted function: Google sign-in, nothing kept on disk between requests. */
  hosted: boolean;
  host: string;
  port: number;
  stateDir: string;
  /** The chief bot's working folder. */
  projectDir: string;
  /** The SQLite file used when no D1 database is configured. */
  databasePath: string;
  /** This deployment's instance, 32 hex characters; it also binds sealed credentials. */
  instance: string;
  /** The person the page acts for in token mode; existing databases hold their first person. */
  actor: number;
  auth: "token" | "google";
  /** The public origin of the page, for Google sign-in and app connections. */
  origin: string | null;
  allowedEmails: string[];
  allowedDomains: string[];
  /** The model provider used in token mode; signed-in accounts choose their own. */
  provider: string | null;
  model: string;
  policy: Policy;
  idleSeconds: number;
  approvalSeconds: number;
  workers: number | undefined;
  /** Days before finished message text, chat history and run records are dropped. */
  retentionDays: number;
  /** How hard models think before answering when a conversation has not chosen. */
  thinking: string | undefined;
  computer: ComputerSettings;
  limits: LimitsConfig;
  memory: MemoryConfig;
  proxySecret: string | undefined;
}

export interface Setting {
  name: string;
  /** One line on what it does, written into the example file. */
  about: string;
  /** A value to show in the example; secrets never get one. */
  example?: string;
}

/** Each provider's key variable, for the provider used in token mode. */
export const PROVIDER_KEYS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

const OAUTH_APPS = [
  "github",
  "gmail",
  "calendar",
  "drive",
  "contacts",
  "notion",
  "linear",
  "todoist",
];

/** Every variable the server reads, grouped as the example file lists them. */
export const SETTINGS: Setting[] = [
  { name: "BOTT_HOSTED", about: "1 when serving as a hosted function; automatic on Vercel" },
  { name: "BOTT_HOST", about: "Address the local server listens on", example: "127.0.0.1" },
  { name: "BOTT_PORT", about: "Port the local server listens on", example: "8765" },
  { name: "BOTT_STATE_DIR", about: "Folder for bot files, sessions and the local database" },
  { name: "BOTT_PROJECT_DIR", about: "The chief bot's working folder; <state>/workspace if unset" },
  { name: "BOTT_DATABASE", about: "SQLite file when D1 is not configured" },
  { name: "BOTT_INSTANCE", about: "32 hex characters naming this deployment; required hosted" },
  { name: "BOTT_ACTOR", about: "Person id the page acts for in token mode", example: "1" },
  { name: "BOTT_AUTH", about: "token (one person, local only) or google; google when hosted" },
  { name: TOKEN_VARIABLE, about: "Token for the page in token mode, 16 characters or more" },
  { name: MASTER_KEY_VARIABLE, about: "32 random bytes as base64; seals saved keys and tokens" },
  { name: "BOTT_ORIGIN", about: "Public origin of the page, such as https://bott.example.com" },
  { name: CLIENT_ID_VARIABLE, about: "Google OAuth client for sign-in" },
  { name: CLIENT_SECRET_VARIABLE, about: "Google OAuth client secret for sign-in" },
  { name: "BOTT_ALLOWED_EMAILS", about: "Comma-separated addresses that may sign in" },
  { name: "BOTT_ALLOWED_DOMAINS", about: "Comma-separated Workspace domains that may sign in" },
  { name: PROXY_SECRET_VARIABLE, about: "Secret a trusted proxy sends in X-Bott-Proxy" },
  { name: "BOTT_PROVIDER", about: "openai, anthropic or openrouter, for token mode" },
  { name: "BOTT_MODEL", about: "Model name sent to that provider" },
  { name: "OPENAI_API_KEY", about: "OpenAI key; also used for memory embeddings" },
  { name: "OPENAI_BASE_URL", about: "Another OpenAI-compatible endpoint for embeddings" },
  { name: "ANTHROPIC_API_KEY", about: "Anthropic key for token mode" },
  { name: "OPENROUTER_API_KEY", about: "OpenRouter key for token mode" },
  { name: "BOTT_POLICY", about: "engine, ask, deny or auto: how tool calls are approved" },
  { name: "BOTT_IDLE_SECONDS", about: "Seconds before an idle session is closed", example: "1800" },
  { name: "BOTT_APPROVAL_SECONDS", about: "Seconds an approval waits", example: "300" },
  { name: "BOTT_WORKERS", about: "Most runs or jobs at once" },
  {
    name: "BOTT_THINKING",
    about: "How hard models think before answering: off, minimal, low, medium, high, xhigh or max",
  },
  {
    name: "BOTT_RETENTION_DAYS",
    about: "Days kept of finished message text, chat history and run records",
    example: "7",
  },
  { name: "BOTT_EXECUTOR", about: "local, docker or daytona: where bots run commands" },
  { name: "BOTT_DOCKER_IMAGE", about: "Image for bot containers" },
  { name: "BOTT_DOCKER_MEMORY", about: "Memory cap for bot containers", example: "2g" },
  { name: "BOTT_DAYTONA_TARGET", about: "Daytona region" },
  { name: "BOTT_DAYTONA_SNAPSHOT", about: "Daytona snapshot for new sandboxes" },
  { name: "BOTT_DAYTONA_ARCHIVE_MINUTES", about: "Idle minutes before a sandbox is archived" },
  { name: "BOTT_SANDBOX_NETWORK", about: "open or closed network for containers and sandboxes" },
  { name: "DAYTONA_API_KEY", about: "Daytona key, when the executor is daytona" },
  { name: "BOTT_REQUESTS_PER_RUN", about: "Model requests one run may send", example: "100" },
  { name: "BOTT_REQUESTS_PER_DAY", about: "Model requests per UTC day", example: "1000" },
  { name: "BOTT_SPEND_MICROS_PER_RUN", about: "Spend cap per run, in millionths of a dollar" },
  { name: "BOTT_SPEND_MICROS_PER_DAY", about: "Spend cap per UTC day, in millionths of a dollar" },
  {
    name: "BOTT_ATTEMPT_MAX_MICROS",
    about: 'JSON: most one attempt may cost, {"provider/model": n}',
  },
  { name: "BOTT_MEMORY", about: "on to recall long-term memory (not hosted)", example: "off" },
  { name: "BOTT_MEMORY_EXTRACT", about: "on to learn facts after each exchange", example: "off" },
  { name: "BOTT_QDRANT_URL", about: "Qdrant server for the memory index" },
  { name: "QDRANT_API_KEY", about: "Qdrant key, when the server needs one" },
  { name: "BOTT_EMBEDDING_MODEL", about: "Embedding model for memory" },
  ...D1_VARIABLES.map((name) => ({ name, about: "Cloudflare D1; all three switch storage to D1" })),
  ...OAUTH_APPS.flatMap((app) => [
    { name: `BOTT_${app.toUpperCase()}_CLIENT_ID`, about: `OAuth client for the ${app} app` },
    { name: `BOTT_${app.toUpperCase()}_CLIENT_SECRET`, about: `OAuth secret for the ${app} app` },
  ]),
  { name: "BOTT_GITHUB_TOKEN", about: "GitHub token for the github app without OAuth" },
  {
    name: "BOTT_GMAIL_REFRESH_TOKEN",
    about: "Gmail refresh token for the gmail app without OAuth",
  },
  { name: "BOTT_TELEGRAM_APP_TOKEN", about: "Telegram bot that sends messages for bots" },
  { name: "BOTT_TAVILY_API_KEY", about: "Tavily key for web search" },
  { name: "BOTT_EXA_API_KEY", about: "Exa key for web search" },
  { name: "BOTT_SCRAPERAPI_API_KEY", about: "ScraperAPI key for reading pages" },
];

const POLICIES: Policy[] = ["engine", "ask", "deny", "auto"];

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function whole(env: Env, name: string, min: number, max: number): number | undefined {
  const value = text(env, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < min || number > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return number;
}

function choice<T extends string>(env: Env, name: string, allowed: readonly T[]): T | undefined {
  const value = text(env, name);
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function flag(env: Env, name: string): boolean {
  const value = text(env, name)?.toLowerCase();
  if (value === undefined) return false;
  if (["1", "on", "true", "yes"].includes(value)) return true;
  if (["0", "off", "false", "no"].includes(value)) return false;
  throw new ConfigError(`${name} must be on or off`);
}

function list(env: Env, name: string): string[] {
  return (text(env, name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function attemptCaps(env: Env): Record<string, number> {
  const value = text(env, "BOTT_ATTEMPT_MAX_MICROS");
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  const valid =
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((n) => Number.isInteger(n) && (n as number) > 0);
  if (!valid) {
    throw new ConfigError(
      'BOTT_ATTEMPT_MAX_MICROS must be a JSON object such as {"openai/model": 500000}',
    );
  }
  return parsed as Record<string, number>;
}

/** Runs a reader from another module, turning its complaint into a settings error. */
function checked<T>(name: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new ConfigError(`${name}: ${(error as Error).message}`);
  }
}

export interface ReadOptions {
  /** The home folder the default state folder goes in. */
  home?: string;
  /** Where a hosted function may write, which is all it keeps until the next cold start. */
  scratch?: string;
}

/** Reads and checks every setting, filling in the defaults. */
export function readConfig(env: Env = process.env, opts: ReadOptions = {}): Config {
  const hosted = flag(env, "BOTT_HOSTED") || text(env, "VERCEL") === "1";
  const stateDir = resolve(
    text(env, "BOTT_STATE_DIR") ??
      (hosted ? join(opts.scratch ?? tmpdir(), "bott") : join(opts.home ?? homedir(), ".bott")),
  );
  const given = text(env, "BOTT_INSTANCE");
  if (given !== undefined && !/^[0-9a-fA-F]{32}$/.test(given)) {
    throw new ConfigError("BOTT_INSTANCE must be 32 hex characters");
  }
  if (hosted && given === undefined) {
    throw new ConfigError("Set BOTT_INSTANCE when hosted: there is no state folder to name it by");
  }
  // Without a saved name, one state folder is always the same instance.
  const instance =
    given?.toLowerCase() ??
    createHash("sha256").update(`bott-instance:${stateDir}`).digest("hex").slice(0, 32);

  const auth = choice(env, "BOTT_AUTH", ["token", "google"]) ?? (hosted ? "google" : "token");
  if (hosted && auth !== "google") {
    throw new ConfigError("Hosted mode signs people in with Google; set BOTT_AUTH=google");
  }
  const originText = text(env, "BOTT_ORIGIN");
  const origin =
    originText === undefined ? null : checked("BOTT_ORIGIN", () => canonicalOrigin(originText));

  const provider = choice(env, "BOTT_PROVIDER", Object.keys(PROVIDERS)) ?? null;
  const executor = choice(env, "BOTT_EXECUTOR", ["local", "docker", "daytona"] as const);
  const network = choice(env, "BOTT_SANDBOX_NETWORK", ["open", "closed"] as const);
  const archive = whole(env, "BOTT_DAYTONA_ARCHIVE_MINUTES", 1, 525_600);
  const computer = checked("Computer settings", () =>
    computerSettings({
      ...(executor ? { executor } : {}),
      ...(network ? { sandboxNetwork: network } : {}),
      ...(archive === undefined ? {} : { daytonaArchiveMinutes: archive }),
      dockerImage: text(env, "BOTT_DOCKER_IMAGE") ?? null,
      ...(text(env, "BOTT_DOCKER_MEMORY") ? { dockerMemory: text(env, "BOTT_DOCKER_MEMORY") } : {}),
      daytonaTarget: text(env, "BOTT_DAYTONA_TARGET") ?? null,
      daytonaSnapshot: text(env, "BOTT_DAYTONA_SNAPSHOT") ?? null,
    }),
  );

  const limits: LimitsConfig = {
    requestsPerRun:
      whole(env, "BOTT_REQUESTS_PER_RUN", 1, 1_000_000) ?? DEFAULT_LIMITS.requestsPerRun,
    requestsPerDay:
      whole(env, "BOTT_REQUESTS_PER_DAY", 1, 100_000_000) ?? DEFAULT_LIMITS.requestsPerDay,
    spendMicrosPerRun: whole(env, "BOTT_SPEND_MICROS_PER_RUN", 1, 10 ** 12) ?? null,
    spendMicrosPerDay: whole(env, "BOTT_SPEND_MICROS_PER_DAY", 1, 10 ** 12) ?? null,
    attemptMaxMicros: attemptCaps(env),
  };

  const enabled = flag(env, "BOTT_MEMORY");
  const memory = checked("BOTT_MEMORY", () =>
    readMemoryConfig(
      {
        enabled,
        extract: flag(env, "BOTT_MEMORY_EXTRACT"),
        qdrantUrl: text(env, "BOTT_QDRANT_URL") ?? null,
        ...(text(env, "BOTT_EMBEDDING_MODEL")
          ? { embeddingModel: text(env, "BOTT_EMBEDDING_MODEL") }
          : {}),
      },
      { hosted },
    ),
  );

  return {
    hosted,
    host: text(env, "BOTT_HOST") ?? "127.0.0.1",
    port: whole(env, "BOTT_PORT", 0, 65_535) ?? 8765,
    stateDir,
    projectDir: resolve(text(env, "BOTT_PROJECT_DIR") ?? join(stateDir, "workspace")),
    databasePath: resolve(text(env, "BOTT_DATABASE") ?? join(stateDir, "gateway.sqlite3")),
    instance,
    actor: whole(env, "BOTT_ACTOR", 1, Number.MAX_SAFE_INTEGER) ?? 1,
    auth,
    origin,
    allowedEmails: list(env, "BOTT_ALLOWED_EMAILS"),
    allowedDomains: list(env, "BOTT_ALLOWED_DOMAINS"),
    provider,
    model: text(env, "BOTT_MODEL") ?? "",
    policy: choice(env, "BOTT_POLICY", POLICIES) ?? "ask",
    idleSeconds: whole(env, "BOTT_IDLE_SECONDS", 1, 86_400 * 7) ?? 1800,
    approvalSeconds: whole(env, "BOTT_APPROVAL_SECONDS", 1, 3600) ?? 300,
    workers: whole(env, "BOTT_WORKERS", 1, 256),
    retentionDays: whole(env, "BOTT_RETENTION_DAYS", 1, 3650) ?? 7,
    thinking: choice(env, "BOTT_THINKING", THINKING_LEVELS),
    computer,
    limits,
    memory,
    proxySecret: text(env, PROXY_SECRET_VARIABLE),
  };
}
