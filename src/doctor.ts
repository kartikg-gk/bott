/**
 * `bott doctor`: walks every setting a deploy depends on and prints one line for each, so a
 * person can fix them all in one pass. It only reads: no database, file or container is made.
 *
 *   ok    the setting is in place
 *   fix   the server will not start or a feature will fail until this changes
 *   note  optional, or worth knowing, but nothing breaks
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CLIENT_ID_VARIABLE, CLIENT_SECRET_VARIABLE, checkGoogleBind } from "./accounts/google.ts";
import { TOKEN_VARIABLE } from "./accounts/localToken.ts";
import { MASTER_KEY_VARIABLE, masterKey } from "./accounts/sealing.ts";
import {
  type Config,
  ConfigError,
  type Env,
  PROVIDER_KEYS,
  readConfig,
  SETTINGS,
} from "./config.ts";
import { createDatabase, D1_VARIABLES, type Database } from "./db/database.ts";
import { databaseStatus, SCHEMA_MARK } from "./db/status.ts";
import { PROXY_SECRET_VARIABLE, proxySecretProblem } from "./web/app.ts";

/** What running a program found: `missing` when it is not installed at all. */
export interface ProbeResult {
  missing: boolean;
  status: number | null;
  stdout: string;
}

/** Runs a program briefly to see whether it is there and answers. */
export type Probe = (command: string, args: string[]) => ProbeResult;

export interface DoctorIo {
  env: Env;
  out: (line: string) => void;
  probe?: Probe;
  /** Opens the configured database; tests stand one in instead of reaching D1. */
  database?: (config: Config, env: Env) => Database;
}

const runProgram: Probe = (command, args) => {
  const found = spawnSync(command, args, { timeout: 10_000, encoding: "utf8" });
  const code = (found.error as { code?: string } | undefined)?.code;
  return { missing: code === "ENOENT", status: found.status, stdout: found.stdout ?? "" };
};

/** Programs the document tools call on the server, with what is lost without each. */
const DOCUMENT_TOOLS: [string, string[], string][] = [
  ["pdftotext", ["-v"], "PDF pages cannot be read as text"],
  ["pdftoppm", ["-v"], "scanned PDF pages cannot be turned into images for OCR"],
  ["tesseract", ["--version"], "images and scanned pages cannot be read"],
];

/** Every BOTT_* setting named in a message that the environment actually sets. */
function namedIn(message: string, env: Env): string[] {
  const names = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
  return [...new Set(names)].filter((name) => env[name]?.trim());
}

/**
 * Reads the settings, collecting each complaint instead of stopping at the first: a setting
 * that is refused is set aside and the rest are read again. The config is null when a
 * complaint names nothing that could be set aside.
 */
export function readSettings(env: Env): {
  config: Config | null;
  problems: string[];
  /** The settings set aside, already reported, so later checks need not ask for them again. */
  refused: Set<string>;
} {
  const trial: Env = { ...env };
  const problems: string[] = [];
  const refused = new Set<string>();
  for (;;) {
    try {
      return { config: readConfig(trial), problems, refused };
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(error.message);
      const named = namedIn(error.message, trial);
      if (named.length === 0) return { config: null, problems, refused };
      for (const name of named) {
        refused.add(name);
        delete trial[name];
      }
    }
  }
}

/** Runs every check and returns 0 when nothing needs fixing, 1 otherwise. */
export async function doctor(io: DoctorIo): Promise<number> {
  const { env } = io;
  const probe = io.probe ?? runProgram;
  let fixes = 0;
  const ok = (line: string) => io.out(`ok    ${line}`);
  const fix = (line: string) => {
    fixes++;
    io.out(`fix   ${line}`);
  };
  const note = (line: string) => io.out(`note  ${line}`);
  const set = (name: string) => Boolean(env[name]?.trim());
  const finish = () => {
    io.out(fixes === 0 ? "Everything needed is in place." : `${fixes} to fix.`);
    return fixes === 0 ? 0 : 1;
  };

  const { config, problems, refused } = readSettings(env);
  for (const problem of problems) fix(problem);
  if (!config) {
    io.out("The remaining checks need the settings above to be readable.");
    return finish();
  }
  ok(
    `${config.hosted ? "Hosted" : "On this machine"}, ${config.auth} sign-in, instance ${config.instance}`,
  );

  // Where the data lives.
  const d1Set = D1_VARIABLES.filter(set);
  const d1Ready = d1Set.length === D1_VARIABLES.length;
  if (d1Set.length > 0 && !d1Ready) {
    const missing = D1_VARIABLES.filter((name) => !set(name));
    fix(`D1 needs all three settings; set ${missing.join(" and ")} as well`);
  } else if (config.hosted && !d1Ready) {
    fix(`Hosted mode keeps its data in D1; set ${D1_VARIABLES.join(", ")}`);
  } else if (d1Ready && !config.hosted && !set("BOTT_INSTANCE")) {
    // A name made from this machine's state folder would not match the hosted one.
    fix("Set BOTT_INSTANCE to the hosted deployment's value so both use the same data in D1");
  } else if (!config.hosted && !set("BOTT_INSTANCE")) {
    note(`Instance named after ${config.stateDir}; set BOTT_INSTANCE to keep it if that moves`);
  }
  if (d1Ready || (d1Set.length === 0 && !config.hosted)) {
    if (!d1Ready && !existsSync(config.databasePath)) {
      fix(`No database at ${config.databasePath} yet; run bott init`);
    } else {
      const db = (io.database ?? createDatabase)(config, env);
      try {
        const status = await databaseStatus(db);
        const line = `${status.backend}: answers, schema ${status.schema ?? "not made yet"}`;
        if (status.schema === SCHEMA_MARK) ok(line);
        else fix(`${line}; this build expects ${SCHEMA_MARK}`);
      } catch (error) {
        fix(`The database did not answer: ${(error as Error).message}`);
      } finally {
        await db.close();
      }
    }
  }

  // Sign-in and the model.
  const sealing = () => {
    try {
      masterKey(env);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };
  if (config.auth === "token") {
    if ((env[TOKEN_VARIABLE] ?? "").length >= 16) ok(`${TOKEN_VARIABLE} is set`);
    else fix(`Set ${TOKEN_VARIABLE} to 16 characters or more (bott init makes one)`);
    if (set(MASTER_KEY_VARIABLE)) {
      const wrong = sealing();
      if (wrong) fix(wrong);
      else ok(`${MASTER_KEY_VARIABLE} is well formed`);
    }
    if (!config.provider || !config.model) {
      fix("Set BOTT_PROVIDER and BOTT_MODEL so bots have a model to talk to");
    } else if (!set(PROVIDER_KEYS[config.provider] as string)) {
      fix(`Set ${PROVIDER_KEYS[config.provider]} for the ${config.provider} provider`);
    } else {
      ok(`Model ${config.provider}/${config.model}`);
    }
  } else {
    const wrong = sealing();
    if (wrong) fix(wrong);
    else ok(`${MASTER_KEY_VARIABLE} is well formed`);
    if (!config.origin) {
      if (!refused.has("BOTT_ORIGIN")) fix("Set BOTT_ORIGIN to the page's public origin");
    } else {
      try {
        if (!config.hosted) checkGoogleBind(config.origin, config.host);
        ok(`Origin ${config.origin}`);
      } catch {
        fix(`${config.origin} is plain HTTP, so BOTT_HOST must be a loopback address`);
      }
    }
    if (set(CLIENT_ID_VARIABLE) && set(CLIENT_SECRET_VARIABLE)) ok("Google client is set");
    else fix(`Set ${CLIENT_ID_VARIABLE} and ${CLIENT_SECRET_VARIABLE}`);
    if (config.allowedEmails.length + config.allowedDomains.length > 0) {
      ok("Someone is allowed to sign in");
    } else {
      fix("Set BOTT_ALLOWED_EMAILS or BOTT_ALLOWED_DOMAINS");
    }
    note("Each account chooses its own model and key on the page");
  }
  if (config.proxySecret !== undefined) {
    const wrong = proxySecretProblem(config.proxySecret);
    if (wrong) fix(wrong);
    else ok(`${PROXY_SECRET_VARIABLE} is well formed`);
  }

  // App clients come in pairs; half of one fails when someone tries to connect.
  const paired: string[] = [];
  for (const { name } of SETTINGS) {
    if (!name.endsWith("_CLIENT_ID") || name === CLIENT_ID_VARIABLE) continue;
    const secret = name.replace(/_CLIENT_ID$/, "_CLIENT_SECRET");
    const app = name.slice("BOTT_".length, -"_CLIENT_ID".length).toLowerCase();
    if (set(name) && set(secret)) paired.push(app);
    else if (set(name)) fix(`Set ${secret} to go with ${name}`);
    else if (set(secret)) fix(`Set ${name} to go with ${secret}`);
  }
  if (paired.length > 0) ok(`App clients for ${paired.join(", ")}`);

  // Where bots run commands.
  const computer = config.computer;
  if (computer.executor === "docker") {
    const found = probe("docker", ["version", "--format", "{{.Server.Version}}"]);
    if (found.status === 0) {
      ok(`Docker ${found.stdout.trim()} answers`);
      const image = probe("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        computer.dockerImage,
      ]);
      if (image.status === 0) ok(`Image ${computer.dockerImage} is here`);
      else note(`Image ${computer.dockerImage} is not pulled yet; the first bot waits for it`);
    } else {
      fix("Docker does not answer; start it or choose another BOTT_EXECUTOR");
    }
  } else if (computer.executor === "daytona") {
    if (set("DAYTONA_API_KEY")) ok("DAYTONA_API_KEY is set");
    else fix("Set DAYTONA_API_KEY for the daytona executor");
  } else if (set("BOTT_SANDBOX_NETWORK")) {
    note("BOTT_SANDBOX_NETWORK has no effect while bots run commands on this machine");
  }

  if (config.memory.enabled) {
    if (set("OPENAI_API_KEY") || set("OPENAI_BASE_URL")) ok("Memory has an embeddings service");
    else fix("Memory needs OPENAI_API_KEY (or OPENAI_BASE_URL) for embeddings");
  }

  // Optional programs for reading documents.
  for (const [command, args, without] of DOCUMENT_TOOLS) {
    if (probe(command, args).missing) note(`${command} is not installed; ${without}`);
    else ok(`${command} is installed`);
  }

  return finish();
}
