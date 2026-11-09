import { HttpError } from "../accounts/http.ts";
import type { Account } from "../accounts/store.ts";
import { FolderMirror } from "../bots/folders.ts";
import type { ComputerFactory } from "../computers/index.ts";
import type { Database } from "../db/database.ts";
import type { ModelLimits } from "../limits/limits.ts";
import type { MemoryConfig } from "../memory/config.ts";
import { MemoryControls, projectOf } from "../memory/controls.ts";
import type { Memory } from "../memory/memory.ts";
import { openMemory } from "../memory/open.ts";
import { MemoryRuntime, sessionModelCall } from "../memory/runtime.ts";
import type { Embedder } from "../memory/vectors.ts";
import { BackgroundAgents } from "../runtime/agents.ts";
import { Dispatcher } from "../runtime/dispatcher.ts";
import { type ProviderFactory, type RuntimeConfig, SessionManager } from "../runtime/sessions.ts";
import type { Route } from "../store/routes.ts";
import { Store } from "../store/store.ts";
import { approvalView, WebChannel } from "./channel.ts";
import { parseEarlier, saveEarlier, takeEarlier, toEntries } from "./earlier.ts";
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
  /** Long-term memory; left out or off, nothing is recalled or learned. */
  memory?: {
    config: MemoryConfig;
    env?: Record<string, string | undefined>;
    /** Turns text into vectors; the configured embeddings service when left out. */
    embedder?: Embedder;
  };
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
    /** What the person can see and change in their long-term memory. */
    readonly memory: MemoryControls,
    /** Recall and learning around each exchange, when memory is on. */
    readonly learning: MemoryRuntime | undefined,
    /** Bot notes and skills, kept in the database when hosted. */
    readonly folders: FolderMirror,
    /** Request and spend limits, when set; a run outside the web goes inside `limits.operation`. */
    readonly limits: ModelLimits | undefined,
  ) {}

  static async open(opts: GatewayOptions): Promise<Gateway> {
    const store = await Store.open(opts.db, opts.instance, opts.clock ? { clock: opts.clock } : {});
    const sessions = new SessionManager(opts.runtime, store, opts.providers, opts.computers);
    const folders = new FolderMirror(store, opts.runtime.stateDir, opts.hosted ?? false);
    sessions.folders = folders;
    const journal = new RunJournal(store);
    const { limits } = opts;
    const channel = new WebChannel(journal);
    const project = projectOf(opts.runtime);
    let memory: Memory | null = null;
    let learning: MemoryRuntime | undefined;
    if (opts.memory?.config.enabled) {
      const settings = opts.memory;
      memory = await openMemory(store, settings.config, settings.env ?? process.env, {
        ...(settings.embedder ? { embedder: settings.embedder } : {}),
      });
      if (memory) {
        learning = new MemoryRuntime({
          store,
          memory,
          config: settings.config,
          project,
          // Extraction runs on the hidden extractor bot, one exchange at a time.
          model: sessionModelCall(store, sessions, settings.config.extractionSeconds),
          notify: async (route, text) => {
            await store.logMessage(route, text, "out");
            await channel.send(route, text);
          },
        });
      }
    }
    const dispatcher = new Dispatcher(store, sessions, channel, {
      workers: opts.workers,
      exchange: opts.hosted
        ? {
            // Hosted runs keep no session between requests: each starts on a new one holding
            // what the browser sent, before memory adds anything above the message.
            before: async (route, item) => {
              const earlier = toEntries(await takeEarlier(store, item.id));
              await sessions.seed(route, earlier);
              return (await learning?.before(route, item)) ?? "";
            },
            after: (route, item, answer) => learning?.after(route, item, answer),
          }
        : learning,
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
      new MemoryControls(store, memory, project),
      learning,
      folders,
      limits,
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

  /**
   * The person's approvals still waiting, in the page's layout, optionally for one run. Cards
   * asked here come with everything; those another process asked come from the database, with
   * the run, bot and preview its journal kept, so any process can list and answer them.
   */
  async approvals(actor: number, run?: string): Promise<Record<string, unknown>[]> {
    const here = this.dispatcher.approvals(actor);
    const rest = (await this.store.openApprovals(actor)).filter(
      (open) => !this.dispatcher.holds(open.id),
    );
    const asked = await this.journal.requested(rest.map((open) => open.id));
    const views = here.map(approvalView);
    for (const open of rest) {
      const shown = asked.get(open.id);
      views.push({
        id: open.id,
        run: shown?.run ?? null,
        bot: typeof shown?.data.bot === "string" ? shown.data.bot : null,
        tool: open.tool,
        preview: typeof shown?.data.preview === "string" ? shown.data.preview : "",
        digest: open.digest,
        expires: open.expires,
      });
    }
    return run === undefined ? views : views.filter((view) => view.run === run);
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
    earlier: unknown,
  ): Promise<{ run: string; inbox: bigint }> {
    const messages = parseEarlier(earlier);
    const queued = await this.journal.queue(route, text);
    // Only a hosted gateway needs them; on this machine the route keeps its own session.
    if (this.hosted && messages.length > 0) {
      await saveEarlier(this.store, queued.inbox, messages);
    }
    return queued;
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
    await this.learning?.settled();
    await this.agents.stop();
    await this.sessions.close();
  }
}
