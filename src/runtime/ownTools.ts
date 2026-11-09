import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { HostTool, HostToolCall } from "../agent/session.ts";
import { errorOutput, type ToolOutput } from "../agent/tools.ts";
import { type Bot, botRoot, MEMORY_FILES } from "../bots/bots.ts";
import type { FolderMirror } from "../bots/folders.ts";
import type { Store } from "../store/store.ts";
import { SkillError, SkillFolder } from "../web/skillFiles.ts";

/** The most a note the bot writes for itself may hold, in bytes. */
export const NOTE_LIMIT = 64_000;

const note = z.enum(MEMORY_FILES);

const SCHEMAS = {
  update_own_bot: z
    .object({
      description: z.string().min(1).max(10_000).optional(),
      instructions: z.string().max(10_000).optional(),
    })
    .strict()
    .refine((args) => args.description !== undefined || args.instructions !== undefined),
  read_memory: z.object({ file: note }).strict(),
  write_memory: z.object({ file: note, text: z.string() }).strict(),
  write_skill: z
    .object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      files: z.record(z.string(), z.string()),
    })
    .strict(),
};

type Name = keyof typeof SCHEMAS;
type Args = { [K in Name]: z.infer<(typeof SCHEMAS)[K]> };

/** The names of the tools every bot has for itself. */
export const OWN_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(SCHEMAS));

/**
 * The tools a bot uses on itself: its own description and instructions, its two note files and
 * its own skill packages. Every change waits for the person's decision; reading notes does not.
 */
export function ownTools(): HostTool[] {
  return [
    {
      name: "update_own_bot",
      description:
        "Change your own description or working instructions once the user has agreed to the " +
        "new text. It takes effect from your next run.",
      input: SCHEMAS.update_own_bot,
      readOnly: false,
      review: true,
    },
    {
      name: "read_memory",
      description: "Read the whole of one of your note files.",
      input: SCHEMAS.read_memory,
      readOnly: true,
    },
    {
      name: "write_memory",
      description:
        "Replace the whole of one of your note files with new text, at most 64 KB. The user " +
        "reviews the change first. Keep secrets out of notes.",
      input: SCHEMAS.write_memory,
      readOnly: false,
      review: true,
    },
    {
      name: "write_skill",
      description:
        "Save a reusable skill package: SKILL.md with its name and description, plus any text " +
        "files it needs. The user reviews it first; it is offered from your next run.",
      input: SCHEMAS.write_skill,
      readOnly: false,
      review: true,
    },
  ];
}

export interface OwnContext {
  store: Store;
  /** The bot whose session made the call. */
  bot: Bot;
  stateDir: string;
  /** Keeps notes and skills in the database on a hosted server. */
  folders?: FolderMirror | undefined;
  /** Copies a saved note onto the bot's computer when the computer holds its own copy. */
  mirror?: ((file: string, text: string) => Promise<void>) | undefined;
}

/** A problem the bot should read in plain words. */
class Refused extends Error {}

const say = (text: string): ToolOutput => ({ content: [{ type: "text", text }] });

const notesOf = (ctx: OwnContext) => join(botRoot(ctx.stateDir, ctx.bot), "memory");

const HANDLERS: { [K in Name]: (ctx: OwnContext, args: Args[K]) => Promise<string> } = {
  async update_own_bot({ store, bot }, args) {
    if (args.description !== undefined && !args.description.trim()) {
      throw new Refused("A bot needs a purpose");
    }
    const changes: { role?: string; instructions?: string } = {};
    if (args.description !== undefined) changes.role = args.description;
    if (args.instructions !== undefined) changes.instructions = args.instructions;
    await store.updateBot(bot.id, changes);
    return "Saved. Your next run uses it.";
  },
  async read_memory(ctx, args) {
    await ctx.folders?.fill(ctx.bot);
    const path = join(notesOf(ctx), args.file);
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    return JSON.stringify({ file: args.file, text });
  },
  async write_memory(ctx, args) {
    if (Buffer.byteLength(args.text, "utf8") > NOTE_LIMIT || args.text.includes("\0")) {
      throw new Refused("A note holds at most 64 KB of text");
    }
    await ctx.folders?.fill(ctx.bot);
    const dir = notesOf(ctx);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, args.file), args.text, "utf8");
    await ctx.folders?.keep(ctx.bot);
    await ctx.mirror?.(args.file, args.text);
    return "Saved. Your next run reads the new note.";
  },
  async write_skill(ctx, args) {
    await ctx.folders?.fill(ctx.bot);
    try {
      new SkillFolder(join(botRoot(ctx.stateDir, ctx.bot), "skills")).write(args.name, args.files);
    } catch (error) {
      if (error instanceof SkillError) throw new Refused(error.message);
      throw error;
    }
    await ctx.folders?.keep(ctx.bot);
    return "Saved. The skill is offered from your next run.";
  },
};

/** Answers one of a bot's own tools; what goes wrong comes back as text the bot can read. */
export async function answerOwnCall(ctx: OwnContext, call: HostToolCall): Promise<ToolOutput> {
  if (!OWN_TOOL_NAMES.has(call.name)) return errorOutput("Unknown tool");
  const name = call.name as Name;
  const parsed = SCHEMAS[name].safeParse(call.input);
  if (!parsed.success) return errorOutput(`Invalid arguments for ${name}.`);
  if (!(await ctx.store.bot(ctx.bot.id))) return errorOutput("The bot was deleted");
  try {
    const handler = HANDLERS[name] as (ctx: OwnContext, args: unknown) => Promise<string>;
    return say(await handler(ctx, parsed.data));
  } catch (error) {
    if (error instanceof Refused) return errorOutput(error.message);
    if (error instanceof Error && name === "update_own_bot") return errorOutput(error.message);
    return errorOutput("The change was not saved.");
  }
}
