import { type Bot, workspaceDir } from "../bots/bots.js";
import type { Route } from "../store/routes.js";
import type { Store } from "../store/store.js";
import { type Fact, MemoryError, type Scope } from "./facts.js";
import type { Memory } from "./memory.js";

/** Memory is personal: only private conversations (positive chat numbers) have an owner. */
export function ownerFor(chat: number, actor: number): number | null {
  return chat > 0 ? actor : null;
}

/** Memory belongs to the folder a bot works in, so bots on one project share it. */
export function projectOf(dirs: {
  stateDir: string;
  projectDir: string;
}): (bot: Pick<Bot, "id" | "chief">) => string {
  return (bot) => workspaceDir(dirs.stateDir, dirs.projectDir, bot);
}

export type MemoryView = "facts" | "episodes" | "conflicts" | "forgotten";

export interface MemorySummary {
  bot: string;
  facts: Fact[];
  episodes: number;
  conflicts: number;
  /** Facts the index could not take; not searchable until retried. */
  failed: number;
}

/** What the person can do with their memory, for the page's memory controls. */
export class MemoryControls {
  constructor(
    private readonly store: Store,
    private readonly memory: Memory | null,
    private readonly project: (bot: Pick<Bot, "id" | "chief">) => string,
  ) {}

  async summary(route: Route, actor: number): Promise<MemorySummary> {
    const { memory, scope, bot } = await this.open(route, actor);
    const facts = await memory.facts.facts(scope, { kind: "fact" });
    return {
      bot: bot.name,
      facts,
      episodes: (await memory.facts.facts(scope, { kind: "episode" })).length,
      conflicts: (await memory.facts.facts(scope, { statuses: ["conflicted"] })).length,
      failed: (await memory.facts.failed(scope)).length,
    };
  }

  async list(route: Route, actor: number, view: MemoryView): Promise<Fact[]> {
    const { memory, scope } = await this.open(route, actor);
    switch (view) {
      case "facts":
        return memory.facts.facts(scope, { kind: "fact" });
      case "episodes":
        return memory.facts.facts(scope, { kind: "episode" });
      case "conflicts":
        return memory.facts.facts(scope, { statuses: ["conflicted"] });
      case "forgotten":
        return memory.facts.facts(scope, { statuses: ["retracted"] });
    }
  }

  async search(route: Route, actor: number, text: string): Promise<Fact[]> {
    if (!text.trim()) throw new MemoryError("Say what to search for");
    const { memory, scope } = await this.open(route, actor);
    return memory.search(scope, text.trim());
  }

  async remember(route: Route, actor: number, text: string): Promise<number> {
    if (!text.trim()) throw new MemoryError("Say what to remember");
    const { memory, scope } = await this.open(route, actor);
    const id = await memory.facts.remember(scope, text.trim());
    await memory.sync();
    return id;
  }

  /** Retracts a current fact; `restore` brings it back. */
  forget(route: Route, actor: number, id: number): Promise<void> {
    return this.change(route, actor, (memory, scope) => memory.facts.forget(id, scope));
  }

  restore(route: Route, actor: number, id: number): Promise<void> {
    return this.change(route, actor, (memory, scope) => memory.facts.restore(id, scope));
  }

  /** Keeps one version of a conflict; the other is superseded. */
  keep(route: Route, actor: number, id: number): Promise<void> {
    return this.change(route, actor, (memory, scope) => memory.facts.keep(id, scope));
  }

  /** Gives facts the index refused another try. */
  async retry(route: Route, actor: number): Promise<{ retried: number; failed: number }> {
    const { memory, scope } = await this.open(route, actor);
    const retried = await memory.facts.retry(scope);
    await memory.sync();
    return { retried, failed: (await memory.facts.failed(scope)).length };
  }

  private async change(
    route: Route,
    actor: number,
    work: (memory: Memory, scope: Scope) => Promise<void>,
  ): Promise<void> {
    const { memory, scope } = await this.open(route, actor);
    await work(memory, scope);
    await memory.sync();
  }

  private async open(
    route: Route,
    actor: number,
  ): Promise<{ memory: Memory; scope: Scope; bot: Bot }> {
    if (!this.memory) throw new MemoryError("Memory is not enabled on this server.");
    const owner = ownerFor(route.chat, actor);
    if (owner === null) throw new MemoryError("Memory stays off in group chats, since it is personal.");
    const current = (await this.store.getRoute(route.id)) ?? route;
    const bot = await this.store.bot(current.bot ?? (await this.store.chief()).id);
    if (!bot) throw new MemoryError("The bot was deleted");
    return { memory: this.memory, scope: { project: this.project(bot), owner }, bot };
  }
}
