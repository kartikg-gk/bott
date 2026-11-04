import { existsSync, rmSync } from "node:fs";
import type { Bot } from "../bots/bots.js";
import { savedSession } from "../bots/profiles.js";
import type { ExchangeHooks } from "../runtime/dispatcher.js";
import type { SessionManager } from "../runtime/sessions.js";
import { type InboxItem, REPORT_IDS } from "../store/inbox.js";
import type { Route } from "../store/routes.js";
import type { Store } from "../store/store.js";
import type { MemoryConfig } from "./config.js";
import { ownerFor } from "./controls.js";
import { type Extractor, LoopExtractor, learn, type ModelCall } from "./extract.js";
import type { Scope } from "./facts.js";
import type { Memory } from "./memory.js";

/** The temporary bot extraction prompts run on. */
export const EXTRACTOR_NAME = "Memory extractor";

export const CONFLICT_NOTICE =
  "A memory changed and I was unclear which one is current. Neither is used until you " +
  "choose one under Memory, in Conflicts.";

/**
 * Model calls for extraction, run through our own agent loop on the temporary extractor bot:
 * tools that change nothing, every tool call denied, and a time limit. One call runs at a time,
 * and each starts from an empty session, so no exchange is ever shown to the next.
 */
export function sessionModelCall(
  store: Store,
  sessions: Pick<SessionManager, "background">,
  seconds: number,
): (route: Route) => ModelCall {
  let queue: Promise<unknown> = Promise.resolve();
  const once = async (route: Route, prompt: string): Promise<string> => {
    const bot = await extractorBot(store);
    await forgetSession(store, bot.id);
    try {
      const answer = await sessions.background(route, bot, prompt, {
        policy: "deny",
        readOnly: true,
        signal: AbortSignal.timeout(seconds * 1000),
      });
      if (answer.outcome !== "completed") throw new Error(`Extraction ${answer.outcome}`);
      return answer.text;
    } finally {
      await forgetSession(store, bot.id);
    }
  };
  return (route) => (prompt) => {
    const next = queue.then(() => once(route, prompt));
    queue = next.catch(() => {});
    return next;
  };
}

async function extractorBot(store: Store): Promise<Bot> {
  const find = async () =>
    (await store.bots({ temporary: true })).find((b) => b.temporary && b.name === EXTRACTOR_NAME);
  const found = await find();
  if (found) return found;
  try {
    return await store.createBot({
      name: EXTRACTOR_NAME,
      role: "Extracts memories.",
      temporary: true,
    });
  } catch (error) {
    // Another process made it first.
    const made = await find();
    if (made) return made;
    throw error;
  }
}

/** Drops the extractor's saved session and its file. */
async function forgetSession(store: Store, botId: string): Promise<void> {
  const file = await savedSession(store, botId);
  const { db, instance } = store.ctx;
  await db.run("DELETE FROM bot_sessions WHERE instance=? AND bot=?", [instance, botId]);
  if (file && existsSync(file)) rmSync(file, { force: true });
}

export interface MemoryRuntimeOptions {
  store: Store;
  memory: Memory;
  config: MemoryConfig;
  /** The project folder a bot's memory belongs to. */
  project: (bot: Pick<Bot, "id" | "chief">) => string;
  /** Makes the model call extraction uses for an exchange on `route`. */
  model: (route: Route) => ModelCall;
  /** Defaults to extraction through our own agent loop. */
  extractor?: (call: ModelCall) => Extractor;
  /** Tells the conversation something; failures are ignored. */
  notify: (route: Route, text: string) => Promise<void>;
}

/**
 * Puts recalled memory above each private message and learns from each finished exchange in
 * the background. Memory never blocks or breaks a conversation: any failure here is dropped.
 */
export class MemoryRuntime implements ExchangeHooks {
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly opts: MemoryRuntimeOptions) {}

  async before(route: Route, item: InboxItem): Promise<string> {
    try {
      const scope = await this.scope(route, item);
      if (!scope || !this.opts.config.enabled) return "";
      return await this.opts.memory.recall(scope, item.text);
    } catch {
      return "";
    }
  }

  after(route: Route, item: InboxItem, answer: string): void {
    if (!this.opts.config.enabled || !this.opts.config.extract) return;
    const work = this.learn(route, item, answer).finally(() => this.running.delete(work));
    this.running.add(work);
  }

  /** Resolves once no extraction is running. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private async learn(route: Route, item: InboxItem, answer: string): Promise<void> {
    try {
      const scope = await this.scope(route, item);
      if (!scope) return;
      const call = this.opts.model(route);
      const extractor = (this.opts.extractor ?? ((c) => new LoopExtractor(c)))(call);
      const { conflicts } = await learn(
        this.opts.memory,
        extractor,
        call,
        scope,
        item.text,
        answer,
      );
      if (conflicts.length > 0) await this.opts.notify(route, CONFLICT_NOTICE);
    } catch {
      // Extraction failures never reach the conversation.
    }
  }

  /** The person and project this message's memory belongs to; null when it has none. */
  private async scope(route: Route, item: InboxItem): Promise<Scope | null> {
    // Agent reports carry another model's output; they are never recalled or remembered.
    if (item.id > REPORT_IDS) return null;
    const owner = ownerFor(item.chat, item.actor);
    if (owner === null) return null;
    const { store } = this.opts;
    const current = (await store.getRoute(route.id)) ?? route;
    const bot = await store.bot(current.bot ?? (await store.chief()).id);
    return bot ? { project: this.opts.project(bot), owner } : null;
  }
}
