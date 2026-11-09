/**
 * The `bott` command: set up a local server, serve it, own its scheduled work, check the
 * settings, and look after the database. `main` takes everything it touches as arguments, so it
 * runs the same from the shell and from tests.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { CLIENT_ID_VARIABLE, CLIENT_SECRET_VARIABLE } from "./accounts/google.ts";
import { TOKEN_VARIABLE } from "./accounts/localToken.ts";
import { MASTER_KEY_VARIABLE, masterKey } from "./accounts/sealing.ts";
import { ExtraError, skills, task } from "./cliExtra.ts";
import { type Config, ConfigError, type Env, PROVIDER_KEYS, readConfig } from "./config.ts";
import { createDatabase, D1_VARIABLES, type Database } from "./db/database.ts";
import { databaseStatus, SCHEMA_MARK } from "./db/status.ts";
import { checkDatabase, ImportError, importLocal } from "./db/transfer.ts";
import type { ModelLimits } from "./limits/limits.ts";
import { runRunners } from "./runner.ts";
import type { ProviderFactory } from "./runtime/sessions.ts";
import { serveNode } from "./server.ts";
import { startServer } from "./startup.ts";
import { Store } from "./store/store.ts";

export interface Io {
  env: Env;
  /** Where `init` keeps the settings file. */
  cwd: string;
  out: (line: string) => void;
  /** Stops `run` and `runner`; the process wires it to Ctrl+C. */
  signal?: AbortSignal;
  /** One provider for every bot, as in tests. */
  providers?: ProviderFactory;
  /** Reads what was piped in, for a task given as `-`. */
  stdin?: () => Promise<string>;
}

const USAGE = [
  "Usage: bott <command>",
  "",
  "  init                 Write a local .env with a fresh token and key, and make the database",
  "  run                  Serve the page and API on BOTT_HOST:BOTT_PORT",
  "  runner [--once]      Run scheduled jobs and wake-ups under a database lease",
  "  doctor               Check the settings and the database without changing them",
  "  task TEXT [--bot NAME] [--deadline S] [--json]  Run one task with a bot; - reads it piped in",
  "  skills [list|add FOLDER|remove NAME] [--bot NAME]  Look after shared or one bot's skills",
  "  db check             Show the database backend, that it answers, and its schema",
  "  db import [--from PATH]  Copy a local SQLite instance into D1",
].join("\n");

/** A failure the person can act on; its message is all they see. */
class CommandError extends Error {}

function hasD1(env: Env): boolean {
  return Boolean(env.CLOUDFLARE_D1_DATABASE_ID?.trim());
}

/** The configured database, or null when it is a SQLite file that does not exist yet. */
function existingDatabase(config: Config, env: Env): Database | null {
  if (!hasD1(env) && !existsSync(config.databasePath)) return null;
  return createDatabase(config, env);
}

/** Resolves when the signal fires; never, without one. */
function stopped(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function init(io: Io, config: Config, args: string[]): Promise<number> {
  parseArgs({ args, options: {} });
  if (config.hosted) {
    throw new CommandError(
      "init sets up a server on this machine; a hosted one is configured in its host's settings",
    );
  }
  const file = join(io.cwd, ".env");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const saved = parseEnv(text);
  const added: string[] = [];
  if (!saved[TOKEN_VARIABLE] && !io.env[TOKEN_VARIABLE]) {
    added.push(`${TOKEN_VARIABLE}=${randomBytes(32).toString("base64url")}`);
  }
  if (!saved[MASTER_KEY_VARIABLE] && !io.env[MASTER_KEY_VARIABLE]) {
    added.push(`${MASTER_KEY_VARIABLE}=${randomBytes(32).toString("base64url")}=`);
  }
  if (added.length > 0) {
    const glue = text === "" || text.endsWith("\n") ? "" : "\n";
    writeFileSync(file, `${text}${glue}${added.join("\n")}\n`, "utf8");
    chmodSync(file, 0o600);
    io.out(`Saved ${added.map((line) => line.split("=")[0]).join(" and ")} in ${file}`);
  } else {
    io.out(`${file} already holds a token and a key; left as it is`);
  }
  const db = createDatabase(config, io.env);
  try {
    await Store.open(db, config.instance);
  } finally {
    await db.close();
  }
  io.out(`Instance ${config.instance}, state in ${config.stateDir}`);
  io.out("Start the server with: bott run");
  return 0;
}

async function run(io: Io, config: Config, args: string[]): Promise<number> {
  parseArgs({ args, options: {} });
  const server = await startServer(config, {
    env: io.env,
    ...(io.providers ? { providers: io.providers } : {}),
  });
  try {
    const listening = await serveNode(server.handler, { host: config.host, port: config.port });
    const shown = config.host.includes(":") ? `[${config.host}]` : config.host;
    io.out(`Serving on http://${shown}:${listening.port}`);
    io.out("Scheduled jobs run in a separate process: bott runner");
    if (config.auth === "token") {
      // Messages queued before a restart start now instead of waiting for the next one.
      for (const gateway of await server.gateways()) await gateway.dispatch();
    }
    await stopped(io.signal);
    await listening.close();
  } finally {
    await server.close();
  }
  return 0;
}

/** Runs work as one operation under the limits, so it gets one run's budget. */
const limitedBy =
  (limits: ModelLimits) =>
  <T>(work: () => Promise<T>): Promise<T> =>
    limits.operation(() => work());

async function runner(io: Io, config: Config, args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { once: { type: "boolean" } } });
  const server = await startServer(config, {
    env: io.env,
    ...(io.providers ? { providers: io.providers } : {}),
  });
  try {
    let told = false;
    // Asked again while running, so accounts made later are covered without a restart.
    const targets = async () => {
      const gateways = await server.gateways();
      if (!told) io.out(`Running scheduled work for ${gateways.length} instance(s)`);
      told = true;
      return gateways.map((gateway) => ({
        store: gateway.store,
        sessions: gateway.sessions,
        sink: gateway.channel,
        instance: gateway.store.ctx.instance,
        // Each job is one run for the per-run limits, as a web run is.
        ...(gateway.limits ? { wrap: limitedBy(gateway.limits) } : {}),
      }));
    };
    await runRunners({
      targets,
      once: values.once ?? false,
      ...(config.workers === undefined ? {} : { workers: config.workers }),
      retentionDays: config.retentionDays,
      ...(io.signal ? { signal: io.signal } : {}),
    });
  } finally {
    await server.close();
  }
  return 0;
}

async function doctor(io: Io, config: Config, args: string[]): Promise<number> {
  parseArgs({ args, options: {} });
  const { env } = io;
  const problems: string[] = [];
  const good = (line: string) => io.out(`ok    ${line}`);
  const bad = (line: string) => {
    problems.push(line);
    io.out(`fix   ${line}`);
  };
  good(
    `${config.hosted ? "Hosted" : "On this machine"}, ${config.auth} sign-in, instance ${config.instance}`,
  );

  const db = existingDatabase(config, env);
  if (!db) {
    bad(`No database at ${config.databasePath} yet; run bott init`);
  } else {
    try {
      const status = await databaseStatus(db);
      const line = `${status.backend}: answers, schema ${status.schema ?? "not made yet"}`;
      if (status.schema === SCHEMA_MARK) good(line);
      else bad(`${line}; this build expects ${SCHEMA_MARK}`);
    } catch (error) {
      bad(`The database did not answer: ${(error as Error).message}`);
    } finally {
      await db.close();
    }
  }

  if (config.auth === "token") {
    if ((env[TOKEN_VARIABLE] ?? "").length >= 16) good(`${TOKEN_VARIABLE} is set`);
    else bad(`Set ${TOKEN_VARIABLE} to 16 characters or more (bott init makes one)`);
    if (!config.provider || !config.model) {
      bad("Set BOTT_PROVIDER and BOTT_MODEL so bots have a model to talk to");
    } else if (!env[PROVIDER_KEYS[config.provider] as string]?.trim()) {
      bad(`Set ${PROVIDER_KEYS[config.provider]} for the ${config.provider} provider`);
    } else {
      good(`Model ${config.provider}/${config.model}`);
    }
  } else {
    try {
      masterKey(env);
      good(`${MASTER_KEY_VARIABLE} is set`);
    } catch (error) {
      bad((error as Error).message);
    }
    if (config.origin) good(`Origin ${config.origin}`);
    else bad("Set BOTT_ORIGIN to the page's public origin");
    if (env[CLIENT_ID_VARIABLE] && env[CLIENT_SECRET_VARIABLE]) good("Google client is set");
    else bad(`Set ${CLIENT_ID_VARIABLE} and ${CLIENT_SECRET_VARIABLE}`);
    if (config.allowedEmails.length + config.allowedDomains.length > 0) {
      good("Someone is allowed to sign in");
    } else {
      bad("Set BOTT_ALLOWED_EMAILS or BOTT_ALLOWED_DOMAINS");
    }
  }

  if (config.computer.executor === "docker") {
    const found = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 10_000,
      encoding: "utf8",
    });
    if (found.status === 0) good(`Docker ${found.stdout.trim()} answers`);
    else bad("Docker does not answer; start it or choose another BOTT_EXECUTOR");
  } else if (config.computer.executor === "daytona") {
    if (env.DAYTONA_API_KEY) good("DAYTONA_API_KEY is set");
    else bad("Set DAYTONA_API_KEY for the daytona executor");
  }
  if (config.memory.enabled) {
    if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) good("Memory has an embeddings service");
    else bad("Memory needs OPENAI_API_KEY (or OPENAI_BASE_URL) for embeddings");
  }

  io.out(problems.length === 0 ? "Everything needed is in place." : `${problems.length} to fix.`);
  return problems.length === 0 ? 0 : 1;
}

async function db(io: Io, config: Config, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { from: { type: "string" } },
  });
  const [action, ...extra] = positionals;
  if (extra.length > 0 || (action !== "check" && action !== "import")) {
    io.out(USAGE);
    return 2;
  }
  if (action === "check") {
    if (values.from !== undefined) throw new CommandError("db check takes no --from");
    const target = existingDatabase(config, io.env);
    if (!target) throw new CommandError(`SQLite: no database at ${config.databasePath}`);
    try {
      await checkDatabase(target, io.out);
    } finally {
      await target.close();
    }
    return 0;
  }
  if (!hasD1(io.env)) {
    throw new CommandError(`db import copies into D1; set ${D1_VARIABLES.join(", ")} first`);
  }
  const target = createDatabase(config, io.env);
  try {
    await importLocal({
      source: values.from === undefined ? config.databasePath : resolve(io.cwd, values.from),
      instance: config.instance,
      stateDir: config.stateDir,
      target,
      out: io.out,
    });
  } finally {
    await target.close();
  }
  return 0;
}

type Command = (io: Io, config: Config, args: string[]) => Promise<number>;

const COMMANDS: Record<string, Command> = { init, run, runner, doctor, db, task, skills };

/** Runs one command and returns the exit code: 0 done, 1 failed, 2 not understood. */
export async function main(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!command) {
    if (name !== undefined && !["-h", "--help", "help"].includes(name)) {
      io.out(`Unknown command: ${name}`);
    }
    io.out(USAGE);
    return name === undefined || !["-h", "--help", "help"].includes(name) ? 2 : 0;
  }
  try {
    return await command(io, readConfig(io.env), rest);
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof CommandError ||
      error instanceof ExtraError ||
      error instanceof ImportError
    ) {
      io.out(error.message);
      return 1;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      io.out((error as Error).message);
      io.out(USAGE);
      return 2;
    }
    io.out(`${name} failed: ${(error as Error).message}`);
    return 1;
  }
}
