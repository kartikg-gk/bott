/**
 * Skill packages and bot notes.
 *
 * Skill packages live for the whole instance (/api/skills) or for one bot
 * (/api/bots/:bot/skills). A package is { name, files: { [path]: text } } with SKILL.md.
 *
 * - GET    <prefix>        -> [{ name, description, managed }]; a bot's list adds the shared ones
 * - POST   <prefix>        { name, files } -> { saved: name }
 * - GET    <prefix>/:name  -> { name, files }
 * - DELETE <prefix>/:name  -> { deleted: name }
 * - GET    /api/bots/:bot/memory -> { "PREFERENCES.md": text, "KNOWLEDGE.md": text }
 * - PUT    /api/bots/:bot/memory { file, text } -> { saved: file }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "../../accounts/http.ts";
import { loadSkills } from "../../agent/skills.ts";
import { type Bot, botRoot, MEMORY_FILES } from "../../bots/bots.ts";
import type { ApiRouter, Ctx } from "../context.ts";
import { fresh, readObject } from "../router.ts";
import { FILE_LIMIT, SkillError, SkillFolder } from "../skillFiles.ts";

/** The kept bot named in the path, or null for the instance-wide scope. */
async function scope(ctx: Ctx, params: Record<string, string>): Promise<Bot | null> {
  if (params.bot === undefined) return null;
  const bot = await ctx.gateway.store.bot(params.bot);
  if (!bot || bot.temporary) throw new HttpError(404, "No such bot");
  return bot;
}

function sharedSkills(ctx: Ctx): string {
  return join(ctx.gateway.runtime.stateDir, "skills");
}

function folderFor(ctx: Ctx, bot: Bot | null): SkillFolder {
  return new SkillFolder(
    bot ? join(botRoot(ctx.gateway.runtime.stateDir, bot), "skills") : sharedSkills(ctx),
  );
}

/** Runs a change to a bot's files while it is idle, then restarts its idle sessions. */
async function whileIdle(ctx: Ctx, bot: Bot | null, change: () => void): Promise<void> {
  const { sessions } = ctx.gateway;
  if (bot && sessions.isBusy(bot.id)) {
    throw new HttpError(409, `${bot.name} is working; try again when it has finished`);
  }
  try {
    change();
  } catch (error) {
    if (error instanceof SkillError) throw new HttpError(400, error.message);
    throw error;
  }
  sessions.restartIdle(bot?.id);
}

/** Brings the folders up to date with what a hosted server stored. */
async function current(ctx: Ctx, bot: Bot | null): Promise<void> {
  await ctx.gateway.folders.fill(null);
  if (bot) await ctx.gateway.folders.fill(bot);
}

async function catalog(ctx: Ctx, _request: Request, params: Record<string, string>) {
  const bot = await scope(ctx, params);
  await current(ctx, bot);
  const own = folderFor(ctx, bot);
  // A bot sees its own skills first and the shared ones after; its own win on a name clash.
  const dirs = bot ? [own.root, sharedSkills(ctx)] : [own.root];
  return fresh(
    loadSkills(dirs).map((skill) => ({
      name: skill.name,
      description: skill.description,
      managed: skill.path.startsWith(own.root) && own.managed(skill.name),
    })),
  );
}

async function read(ctx: Ctx, _request: Request, params: Record<string, string>) {
  const bot = await scope(ctx, params);
  await current(ctx, bot);
  try {
    return fresh({ name: params.name, files: folderFor(ctx, bot).read(params.name as string) });
  } catch (error) {
    if (error instanceof SkillError) throw new HttpError(404, error.message);
    throw error;
  }
}

async function save(ctx: Ctx, request: Request, params: Record<string, string>) {
  const bot = await scope(ctx, params);
  const body = await readObject(request, "Send a skill name and its files");
  if (Object.keys(body).sort().join(",") !== "files,name" || typeof body.name !== "string") {
    throw new HttpError(400, "Send a skill name and its files");
  }
  const name = body.name;
  await current(ctx, bot);
  await whileIdle(ctx, bot, () => folderFor(ctx, bot).write(name, body.files));
  await ctx.gateway.folders.keep(bot);
  return fresh({ saved: name });
}

async function remove(ctx: Ctx, _request: Request, params: Record<string, string>) {
  const bot = await scope(ctx, params);
  const name = params.name as string;
  await current(ctx, bot);
  await whileIdle(ctx, bot, () => folderFor(ctx, bot).remove(name));
  await ctx.gateway.folders.keep(bot);
  return fresh({ deleted: name });
}

function notesDir(ctx: Ctx, bot: Bot): string {
  return join(botRoot(ctx.gateway.runtime.stateDir, bot), "memory");
}

async function readNotes(ctx: Ctx, _request: Request, params: Record<string, string>) {
  const bot = (await scope(ctx, params)) as Bot;
  await ctx.gateway.folders.fill(bot);
  const dir = notesDir(ctx, bot);
  const notes: Record<string, string> = {};
  for (const file of MEMORY_FILES) {
    const path = join(dir, file);
    notes[file] = existsSync(path) ? readFileSync(path, "utf8") : "";
  }
  return fresh(notes);
}

async function writeNote(ctx: Ctx, request: Request, params: Record<string, string>) {
  const bot = (await scope(ctx, params)) as Bot;
  const body = await readObject(request, "Send a note file name and its text");
  const { file, text } = body;
  if (Object.keys(body).sort().join(",") !== "file,text" || typeof text !== "string") {
    throw new HttpError(400, "Send a note file name and its text");
  }
  if (!(MEMORY_FILES as readonly unknown[]).includes(file)) {
    throw new HttpError(400, `Notes are kept in ${MEMORY_FILES.join(" or ")}`);
  }
  if (Buffer.byteLength(text, "utf8") > FILE_LIMIT || text.includes("\0")) {
    throw new HttpError(400, "A note holds at most 256 KB of text");
  }
  await ctx.gateway.folders.fill(bot);
  await whileIdle(ctx, bot, () => {
    const dir = notesDir(ctx, bot);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file as string), text, "utf8");
  });
  await ctx.gateway.folders.keep(bot);
  return fresh({ saved: file });
}

export function resourceRoutes(router: ApiRouter): void {
  for (const prefix of ["/api/skills", "/api/bots/:bot/skills"]) {
    router
      .add("GET", prefix, catalog)
      .add("POST", prefix, save)
      .add("GET", `${prefix}/:name`, read)
      .add("DELETE", `${prefix}/:name`, remove);
  }
  router
    .add("GET", "/api/bots/:bot/memory", readNotes)
    .add("PUT", "/api/bots/:bot/memory", writeNote);
}
