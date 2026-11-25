import type { SocketOpener } from "./cdp.ts";
import { nodeSocket } from "./cdp.ts";
import { type BrowserKey, BrowserSession, type Engine } from "./page.ts";

/** Whose browser it is: one per account, bot and run. */
export interface BrowserOwner {
  account: string;
  bot: string;
  run: string;
}

const keyOf = (o: BrowserOwner) => JSON.stringify([o.account, o.bot, o.run]);

export interface BrowserRegistryOptions {
  open?: SocketOpener;
  settleMs?: number;
  commandMs?: number;
}

interface Entry {
  owner: BrowserOwner;
  engine: Engine;
  ready: Promise<BrowserSession>;
}

/**
 * The browsers open in this process. Each is started the first time its bot asks for one in a
 * run and closed when that run ends. Asking for the other engine closes the browser and starts
 * a fresh one, since nothing carries over between engines.
 */
export class BrowserRegistry {
  private readonly open = new Map<string, Entry>();

  constructor(private readonly opts: BrowserRegistryOptions = {}) {}

  /** The owner's browser, started on `engine` when there is none or it runs the other one. */
  async use(owner: BrowserOwner, key: BrowserKey, engine?: Engine): Promise<BrowserSession> {
    const id = keyOf(owner);
    const found = this.open.get(id);
    if (found && (engine === undefined || found.engine === engine)) {
      const session = await found.ready.catch(() => null);
      if (session && !session.closed) return session;
      if (this.open.get(id) === found) this.open.delete(id);
    } else if (found) {
      this.open.delete(id);
      await closeEntry(found);
    }
    const chosen = engine ?? found?.engine ?? "kitesurf";
    const entry: Entry = {
      owner,
      engine: chosen,
      ready: BrowserSession.start(key, chosen, {
        open: this.opts.open ?? nodeSocket,
        ...(this.opts.settleMs === undefined ? {} : { settleMs: this.opts.settleMs }),
        ...(this.opts.commandMs === undefined ? {} : { commandMs: this.opts.commandMs }),
      }),
    };
    this.open.set(id, entry);
    try {
      return await entry.ready;
    } catch (error) {
      if (this.open.get(id) === entry) this.open.delete(id);
      throw error;
    }
  }

  /** The owner's browser when one is open; never starts one. */
  async current(owner: BrowserOwner): Promise<BrowserSession | null> {
    const found = this.open.get(keyOf(owner));
    const session = await found?.ready.catch(() => null);
    return session && !session.closed ? session : null;
  }

  /** The open browser of a run in the account, whichever bot it belongs to. */
  async forRun(account: string, run: string): Promise<BrowserSession | null> {
    for (const entry of this.open.values()) {
      if (entry.owner.account === account && entry.owner.run === run) {
        return this.current(entry.owner);
      }
    }
    return null;
  }

  /** Closes every browser the run opened in the account. */
  async endRun(account: string, run: string): Promise<void> {
    const ending: Entry[] = [];
    for (const [id, entry] of this.open) {
      if (entry.owner.account === account && entry.owner.run === run) {
        this.open.delete(id);
        ending.push(entry);
      }
    }
    await Promise.all(ending.map(closeEntry));
  }

  /** Closes every browser, as the server shuts down. */
  async closeAll(): Promise<void> {
    const ending = [...this.open.values()];
    this.open.clear();
    await Promise.all(ending.map(closeEntry));
  }

  /** How many browsers are open or starting. */
  get size(): number {
    return this.open.size;
  }
}

async function closeEntry(entry: Entry): Promise<void> {
  const session = await entry.ready.catch(() => null);
  await session?.close();
}
