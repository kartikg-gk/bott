import { HttpError } from "../accounts/http.ts";
import type { Account } from "../accounts/store.ts";
import type { ComputerFactory } from "../computers/index.ts";
import type { Database } from "../db/database.ts";
import type { ModelLimits } from "../limits/limits.ts";
import { BackgroundAgents } from "../runtime/agents.ts";
import { Dispatcher } from "../runtime/dispatcher.ts";
import { type ProviderFactory, type RuntimeConfig, SessionManager } from "../runtime/sessions.ts";
import type { Route } from "../store/routes.ts";
import { Store } from "../store/store.ts";
import { WebChannel } from "./channel.ts";
import { RunJournal } from "./journal.ts";

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
  /** Request and spend limits; each run counts against one budget of its own. */
  limits?: ModelLimits;
  /** Runs wait until the signed-in account has chosen a model and saved a key. */
  requireAccountModel?: boolean;
}

/** One instance's whole runtime, as the web endpoints use it. */
export class Gateway {
  private constructor(
    readonly store: Store,
    readonly sessions: SessionManager,
    readonly dispatcher: Dispatcher,
    readonly agents: BackgroundAgents,
    readonly channel: WebChannel,
    readonly journal: RunJournal,
    readonly actor: number,
    readonly hosted: boolean,
    readonly runtime: RuntimeConfig,
    private readonly accountModel: boolean,
  ) {}

  static async open(opts: GatewayOptions): Promise<Gateway> {
    const store = await Store.open(opts.db, opts.instance, opts.clock ? { clock: opts.clock } : {});
    const sessions = new SessionManager(opts.runtime, store, opts.providers, opts.computers);
    const journal = new RunJournal(store);
    const { limits } = opts;
    const channel = new WebChannel(journal);
    const dispatcher = new Dispatcher(store, sessions, channel, {
      workers: opts.workers,
      wrap: limits ? (work) => limits.operation(() => work()) : undefined,
      observer: {
        started: (item, bot) => journal.emit(item.run as string, "run_started", { bot }),
        answered: (item, text) => journal.answer(item.run as string, text),
        closed: async (item) => {
          const run = item.run as string;
          const usage: Record<string, number> = { ...channel.takeUsage(run) };
          // Still inside the run's operation, so the budget read here is this run's own.
          if (limits?.spendMetered) usage.reserved_micros = limits.scope().spendMicros;
          if (usage.model_messages || "reserved_micros" in usage) {
            await journal.emit(run, "run_usage", usage);
          }
          await journal.finish(run);
        },
      },
    });
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
      journal,
      opts.actor ?? DEFAULT_ACTOR,
      opts.hosted ?? false,
      opts.runtime,
      opts.requireAccountModel ?? false,
    );
  }

  /**
   * Stops the person's run: a queued one never starts, a running one is aborted, and either
   * ends cancelled. False when the run is not theirs or already over or stopping.
   */
  async stopRun(run: string, actor: number): Promise<boolean> {
    if (!(await this.journal.cancel(run, actor))) return false;
    await this.dispatcher.stopRun(run);
    await this.journal.finish(run);
    return true;
  }

  /** Refuses, with a 409, a run that has no model to run on yet. */
  async requireModel(account: Account | null): Promise<void> {
    if (this.accountModel && account && !account.provider) {
      throw new HttpError(409, "Choose a model and save its key under Account before you start");
    }
  }

  /** Queues a run of the text on the route; `earlier` is what the browser sent before it. */
  async queueRun(
    route: Route,
    text: string,
    _earlier: unknown,
  ): Promise<{ run: string; inbox: bigint }> {
    return this.journal.queue(route, text);
  }

  /** Whether a run or a background agent is going. */
  working(): boolean {
    return this.dispatcher.running() > 0 || this.agents.running() > 0;
  }

  /** Starts whatever waiting work can start now. */
  async dispatch(): Promise<void> {
    await this.dispatcher.tick();
  }

  /** Ends live streams and stops the sessions; running work ends with them. */
  async close(): Promise<void> {
    this.channel.close();
    this.journal.close();
    await this.agents.stop();
    await this.sessions.close();
  }
}
