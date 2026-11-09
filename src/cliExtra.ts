/**
 * Two `bott` commands for the person running the server: `task`, which runs one task with a bot
 * and prints its answer, and `skills`, which looks after the shared and per-bot skill folders.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadSkills } from "./agent/skills.ts";
import { type Bot, botRoot } from "./bots/bots.ts";
import { FolderMirror } from "./bots/folders.ts";
import { ensureStarters } from "./bots/starters.ts";
import type { Config, Env } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { RunUsage } from "./limits/usage.ts";
import type { ProviderFactory } from "./runtime/sessions.ts";
import { startServer } from "./startup.ts";
import { Store, WEB_CHAT } from "./store/store.ts";
import { SkillError, SkillFolder } from "./web/skillFiles.ts";

/** What these commands need from the shell. */
export interface ExtraIo {
  env: Env;
  cwd: string;
  out: (line: string) => void;
  /** Reads what was piped in, for a task given as `-`. */
  stdin?: () => Promise<string>;
  providers?: ProviderFactory;
}

/** A failure the person can act on; its message is all they see. */
export class ExtraError extends Error {}

const MOST_TEXT = 16_000;

/** A kept bot found by name or ID, or the chief when none is named. */
async function pickBot(store: Store, named: string | undefined): Promise<Bot> {
  const found = named ? await store.findBot(named) : await store.bot((await store.chief()).id);
  if (!found || found.temporary) throw new ExtraError("No kept bot has that name or ID");
  return found;
}

export async function task(io: ExtraIo, config: Config, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      bot: { type: "string" },
      deadline: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (config.auth !== "token") {
    throw new ExtraError("task runs on a server signed in with a token; use the page instead");
  }
  if (positionals.length !== 1)
    throw new ExtraError("Give the task as one argument, or - to pipe it in");
  let text = positionals[0] as string;
  if (text === "-") text = (await io.stdin?.()) ?? "";
  text = text.trim();
  if (!text || text.length > MOST_TEXT) {
    throw new ExtraError(`Give a task of 1 to ${MOST_TEXT} characters`);
  }
  if (text.startsWith("/")) throw new ExtraError("Give the task in words, not as a command");
  const seconds = values.deadline === undefined ? 120 : Number(values.deadline);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) {
    throw new ExtraError("The deadline is more than 0 and at most 3600 seconds");
  }

  const server = await startServer(config, {
    env: io.env,
    ...(io.providers ? { providers: io.providers } : {}),
  });
  try {
    const [gateway] = await server.gateways();
    if (!gateway) throw new ExtraError("This server has no instance to run the task on");
    const bot = await pickBot(gateway.store, values.bot);
    const route = await gateway.store.conversation(WEB_CHAT, gateway.actor);
    const usage = new RunUsage();
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), seconds * 1000);
    let status: string;
    let answer: string;
    let reserved: number | undefined;
    const work = async () => {
      const done = await gateway.sessions.background(route, bot, text, {
        readOnly: false,
        signal: stop.signal,
        // Nobody is there to answer, so a call needing approval is refused at once.
        unattended: true,
        onEvent: (event) => usage.observe(event),
      });
      if (gateway.limits?.spendMetered) reserved = gateway.limits.scope().spendMicros;
      return done;
    };
    try {
      const done = gateway.limits ? await gateway.limits.operation(work) : await work();
      status = stop.signal.aborted ? "timed_out" : done.outcome;
      answer = stop.signal.aborted ? "The task ran out of time" : done.text;
    } finally {
      clearTimeout(timer);
    }
    const used: Record<string, number> = { ...usage.result() };
    if (reserved !== undefined) used.reserved_micros = reserved;
    if (values.json) {
      io.out(JSON.stringify({ bot: bot.id, status, answer, usage: used }));
    } else {
      io.out(answer);
      io.out(
        `${status} | input ${used.input} | output ${used.output} | cache read ${used.cache_read}` +
          ` | cache write ${used.cache_write} | cost $${(used.cost_usd ?? 0).toFixed(6)}`,
      );
      if (reserved !== undefined) io.out(`Spend held: $${(reserved / 1_000_000).toFixed(6)}`);
    }
    return status === "completed" ? 0 : 1;
  } finally {
    await server.close();
  }
}

/** Every text file in a skill folder on this machine, by its path inside the folder. */
function folderFiles(top: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new ExtraError(`${relative} is a link; copy the file in`);
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else if (entry.isFile()) files[relative] = readFileSync(join(dir, entry.name), "utf8");
    }
  };
  walk(top, "");
  return files;
}

export async function skills(io: ExtraIo, config: Config, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { bot: { type: "string" } },
  });
  const [action = "list", target, ...extra] = positionals;
  if (!["list", "add", "remove"].includes(action) || extra.length > 0) {
    throw new ExtraError("Use skills [list|add FOLDER|remove NAME] [--bot NAME]");
  }
  const db = createDatabase(config, io.env);
  try {
    const store = await Store.open(db, config.instance);
    const bot = values.bot === undefined ? null : await pickBot(store, values.bot);
    // A hosted server keeps skills in the database; the folders are filled from it first.
    const mirror = new FolderMirror(store, config.stateDir, config.hosted);
    await mirror.fill(null);
    if (bot) await mirror.fill(bot);
    const shared = join(config.stateDir, "skills");
    const root = bot ? join(botRoot(config.stateDir, bot), "skills") : shared;
    const folder = new SkillFolder(root);
    if (action === "list") {
      const dirs = bot ? [root, shared] : [root];
      const listed = loadSkills([...dirs, ensureStarters(config.stateDir)]).map((skill) => ({
        name: skill.name,
        description: skill.description,
        managed: skill.path.startsWith(root) && folder.managed(skill.name),
      }));
      io.out(JSON.stringify(listed, null, 2));
      return 0;
    }
    if (!target)
      throw new ExtraError(
        `skills ${action} needs a ${action === "add" ? "folder" : "skill name"}`,
      );
    try {
      if (action === "add") {
        const source = resolve(io.cwd, target);
        const name = basename(source);
        folder.write(name, folderFiles(source));
        io.out(`Added ${name}`);
      } else {
        folder.remove(target);
        io.out(`Removed ${target}`);
      }
    } catch (error) {
      if (error instanceof SkillError) throw new ExtraError(error.message);
      if ((error as { code?: unknown }).code === "ENOENT") {
        throw new ExtraError(`There is no folder at ${target}`);
      }
      throw error;
    }
    await mirror.keep(bot);
    return 0;
  } finally {
    await db.close();
  }
}
