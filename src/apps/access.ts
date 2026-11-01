import { z } from "zod";
import type { HostTool } from "../agent/session.ts";
import { errorOutput, type ToolOutput } from "../agent/tools.ts";
import type { Bot } from "../bots/bots.ts";
import type { Store } from "../store/store.ts";
import { AppError, HttpError, NetworkError } from "./http.ts";
import type { AppRunner } from "./registry.ts";
import { toolOwner } from "./registry.ts";
import type { AppTool } from "./schema.ts";

/** The one app tool a bot starts with: it loads an app's full tools when the bot needs them. */
export const LOAD_PLUGIN = "load_plugin";

const loadInput = z.object({ name: z.string() }).strict();

const say = (text: string): ToolOutput => ({ content: [{ type: "text", text }] });

export function hostTool(t: AppTool): HostTool {
  return {
    name: t.name,
    description: t.description,
    input: t.input,
    readOnly: t.readOnly,
    review: t.review,
  };
}

/** What one bot may do with the apps: only those granted to it and ready for the account. */
export class BotApps {
  constructor(
    private readonly store: Store,
    readonly runner: AppRunner,
  ) {}

  /** The apps granted to the bot that are ready to use, in name order. */
  async enabled(botId: string): Promise<string[]> {
    const names: string[] = [];
    for (const name of await this.store.pluginsFor(botId)) {
      if (this.runner.apps[name] && (await this.runner.configured(name))) names.push(name);
    }
    return names;
  }

  /** The loader the bot is given; it lists app names only, so the prompt stays small. */
  loader(enabled: string[]): HostTool {
    return {
      name: LOAD_PLUGIN,
      description: `Load tool schemas for a connected app. Available apps: ${enabled.join(", ")}`,
      input: loadInput,
      readOnly: true,
    };
  }

  /** Answers a load: the app's tools to add to the session, or an error when it is not enabled. */
  async load(botId: string, input: unknown): Promise<{ output: ToolOutput; tools: HostTool[] }> {
    const parsed = loadInput.safeParse(input);
    const name = parsed.success ? parsed.data.name : undefined;
    if (name === undefined || !(await this.enabled(botId)).includes(name)) {
      return { output: errorOutput("This app is not connected or not granted to this bot"), tools: [] };
    }
    const app = this.runner.apps[name];
    const tools = (app?.tools ?? []).map(hostTool);
    const names = tools.map((t) => t.name).join(", ");
    return { output: say(`Loaded ${name}. Available tools are ${names}.`), tools };
  }

  owns(tool: string): boolean {
    return toolOwner(tool, this.runner.apps) !== undefined;
  }

  /** Runs an app tool for the bot. What goes wrong comes back as a message the bot can read. */
  async call(bot: Bot, tool: string, input: unknown): Promise<ToolOutput> {
    const owner = toolOwner(tool, this.runner.apps);
    const spec = owner ? this.runner.apps[owner]?.tools.find((t) => t.name === tool) : undefined;
    if (!owner || !spec) return errorOutput("Unknown tool");
    if (!(await this.store.pluginsFor(bot.id)).includes(owner)) {
      return errorOutput(`${owner} is not enabled for this bot.`);
    }
    if (!(await this.runner.configured(owner))) {
      return errorOutput(`${owner} is not set up on the server.`);
    }
    const parsed = spec.input.safeParse(input);
    if (!parsed.success) return errorOutput(`Invalid arguments for ${tool}.`);
    try {
      return say(await this.runner.run(tool, parsed.data as Record<string, unknown>, bot.name));
    } catch (error) {
      return errorOutput(failure(owner, error));
    }
  }
}

/** Turns a failure into words for the bot, without passing on anything a service sent. */
export function failure(app: string, error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof HttpError) return `${app} returned HTTP ${error.status}.`;
  if (error instanceof NetworkError) {
    return `Could not reach ${app}. A write may have gone through; do not retry it.`;
  }
  return `${app} could not complete the request.`;
}
