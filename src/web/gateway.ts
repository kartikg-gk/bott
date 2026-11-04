import type { ComputerFactory } from "../computers/index.ts";
import type { Database } from "../db/database.ts";
import { BackgroundAgents } from "../runtime/agents.ts";
import { Dispatcher } from "../runtime/dispatcher.ts";
import { type ProviderFactory, type RuntimeConfig, SessionManager } from "../runtime/sessions.ts";
import { Store } from "../store/store.ts";
import { WebChannel } from "./channel.ts";

/** The person the web page acts for when nothing else says so. */
export const DEFAULT_ACTOR = 1;

export interface GatewayOptions {
  db: Database;
  instance: string;
  runtime: RuntimeConfig;
  providers: ProviderFactory;
  /** Hosted gateways keep no files between requests. */
  hosted?: boolean;
  /** The person the web page acts for; existing databases hold their first allowed person. */
  actor?: number;
  /** Most prompts run at once. */
  workers?: number;
  computers?: ComputerFactory;
  /** Seconds since the epoch, as a float. */
  clock?: () => number;
}

/** One instance's whole runtime, as the web endpoints use it. */
export class Gateway {
  private constructor(
    readonly store: Store,
    readonly sessions: SessionManager,
    readonly dispatcher: Dispatcher,
    readonly agents: BackgroundAgents,
    readonly channel: WebChannel,
    readonly actor: number,
    readonly hosted: boolean,
  ) {}

  static async open(opts: GatewayOptions): Promise<Gateway> {
    const store = await Store.open(opts.db, opts.instance, opts.clock ? { clock: opts.clock } : {});
    const sessions = new SessionManager(opts.runtime, store, opts.providers, opts.computers);
    const channel = new WebChannel();
    const dispatcher = new Dispatcher(store, sessions, channel, { workers: opts.workers });
    // A finished background task queues a report for the chief; a look at the inbox picks it up.
    const agents = new BackgroundAgents(store, sessions, channel, {
      onReport: () => void dispatcher.tick().catch(() => {}),
    });
    return new Gateway(
      store,
      sessions,
      dispatcher,
      agents,
      channel,
      opts.actor ?? DEFAULT_ACTOR,
      opts.hosted ?? false,
    );
  }

  /** Starts whatever waiting work can start now. */
  async dispatch(): Promise<void> {
    await this.dispatcher.tick();
  }

  /** Ends live streams and stops the sessions; running work ends with them. */
  async close(): Promise<void> {
    this.channel.close();
    await this.agents.stop();
    await this.sessions.close();
  }
}
