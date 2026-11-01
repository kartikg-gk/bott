import type { SessionEvent } from "../agent/session.ts";
import type { InboxItem, InboxStatus } from "../store/inbox.ts";
import type { Route } from "../store/routes.ts";
import type { Store } from "../store/store.ts";
import { BotBusy, type SessionManager } from "./sessions.ts";
import type { ApprovalCard, Sink } from "./sink.ts";

type ApprovalRequest = Extract<SessionEvent, { type: "approval_requested" }>;

/**
 * Control names that once arrived as typed commands. The page offers them as controls, so a
 * message that starts with one never becomes a prompt; other text starting with "/" does.
 */
const CONTROLS = new Set([
  "/start",
  "/help",
  "/stop",
  "/status",
  "/sessions",
  "/queue",
  "/steer",
  "/tasks",
  "/cancel",
  "/keep",
  "/discard",
  "/memory",
  "/bot",
  "/plugin",
  "/plugins",
  "/jobs",
  "/schedule",
  "/unschedule",
  "/pausejob",
  "/resumejob",
  "/new",
  "/clone",
  "/name",
  "/compact",
  "/export",
  "/last",
  "/model",
  "/models",
  "/thinking",
  "/think",
  "/switch",
]);

const CONTROL_NOTICE = "That command is not taken as a message here; use the controls on the page.";
const QUEUE_FULL = "The prompt queue is full right now; retry later.";
/** The longest delay a timer takes, in milliseconds. */
const MAX_TIMER = 2 ** 31 - 1;
const INTERRUPTED = "Task interrupted. It was not replayed.";

/** Run approvals are not tied to a run of their own, so they all carry this run name. */
const SESSION_RUN = "native";

/** Whether a waiting message names a control rather than asking something. */
function isControl(item: InboxItem): boolean {
  if (item.status !== "pending") return false;
  const verb = item.text.trim().split(/\s+/, 1)[0] ?? "";
  return CONTROLS.has(verb.split("@")[0] ?? "");
}

/** One prompt being run on a route. */
interface Active {
  route: Route;
  item: InboxItem;
  /** The bot the route is on; one run per bot at a time. */
  bot: string;
  /** The status the item waited in, restored when the bot turns out to be busy elsewhere. */
  waiting: InboxStatus;
  /** Set by `stop`; a run that has not reached the session yet is aborted when it does. */
  stopped: boolean;
  /** Whether the session has sent any event, meaning the prompt reached it. */
  started: boolean;
  /** Approval work started from events, settled before the run is closed. */
  chores: Set<Promise<void>>;
  done: Promise<void>;
}

interface OpenCard {
  card: ApprovalCard;
  active: Active;
  deciding: boolean;
  timer: NodeJS.Timeout | undefined;
}

/** Turns waiting inbox messages into runs, one at a time per route, and delivers each answer. */
export class Dispatcher {
  private readonly active = new Map<number, Active>();
  private readonly cards = new Map<string, OpenCard>();
  private readonly workers: number;
  private ticking: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly sessions: SessionManager,
    private readonly sink: Sink,
    opts: { workers?: number | undefined } = {},
  ) {
    const workers = opts.workers ?? Number.POSITIVE_INFINITY;
    if (!(workers >= 1)) throw new Error("workers must be at least 1");
    this.workers = workers;
  }

  /**
   * Starts a run for each waiting message whose route is free, while workers are free, and
   * settles the messages that are not prompts. Returns how many runs it started.
   */
  tick(): Promise<number> {
    const next = this.ticking.then(() => this.dispatch());
    this.ticking = next.catch(() => {});
    return next;
  }

  /** Resolves once no run is in progress. */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((a) => a.done));
    }
  }

  /** Approvals still waiting for this person, optionally for one run of the page. */
  approvals(actor: number, run?: string): ApprovalCard[] {
    const now = this.store.ctx.clock();
    return [...this.cards.values()]
      .filter(
        (open) =>
          open.active.item.actor === actor &&
          !open.deciding &&
          (run === undefined || open.card.run === run) &&
          open.card.expiresAt > now,
      )
      .map((open) => open.card);
  }

  /**
   * Answers an approval for the person who was asked. Returns false, changing nothing, when the
   * approval is unknown, someone else's, already being decided or its run is stopping. An
   * expired approval is denied whatever the answer.
   */
  async decide(approvalId: string, allow: boolean, actor: number): Promise<boolean> {
    const open = this.cards.get(approvalId);
    if (!open || open.deciding || open.active.item.actor !== actor || open.active.stopped) {
      return false;
    }
    open.deciding = true;
    let allowed = allow && this.store.ctx.clock() < open.card.expiresAt;
    if (!(await this.respond(open, allowed))) allowed = false;
    await this.resolve(approvalId, allowed, "user");
    return true;
  }

  /** Stops the route's run, if any, and cancels its queued prompts. */
  async stop(route: Route): Promise<{ stopped: boolean; cleared: number }> {
    const cleared = await this.store.clearRouteQueue(route);
    const active = this.active.get(route.id);
    if (active) active.stopped = true;
    const closing = [...this.cards].filter(([, open]) => open.active.route.id === route.id);
    // The session denies these as it aborts; the record should say the stop did it.
    for (const [, open] of closing) open.deciding = true;
    await this.sessions.abort(route).catch(() => {});
    for (const [id] of closing) await this.resolve(id, false, "stopped");
    if (active) await active.done;
    return { stopped: active !== undefined, cleared };
  }

  /** Adds a message to the route's running prompt. False when nothing is running. */
  steer(route: Route, text: string): Promise<boolean> {
    return this.forward(route, "steer", text);
  }

  /** Queues a message to run after the route's running prompt. False when nothing is running. */
  followUp(route: Route, text: string): Promise<boolean> {
    return this.forward(route, "follow_up", text);
  }

  /** Tells each conversation about its interrupted tasks, once. Returns how many were told. */
  async reportInterrupted(): Promise<number> {
    const notices = await this.store.takeUnreported();
    for (const notice of notices) {
      const route = await this.store.conversation(notice.chat, notice.user, notice.thread);
      await this.deliver(route, notice.text).catch(() => {});
    }
    return notices.length;
  }

  private async dispatch(): Promise<number> {
    let started = 0;
    const chief = (await this.store.chief()).id;
    for (const item of await this.store.pending()) {
      const route = await this.store.conversation(item.chat, item.user, item.thread);
      const bot = route.bot ?? chief;
      if (item.status === "rejected") {
        await this.answerOnly(item, route, QUEUE_FULL);
      } else if (isControl(item)) {
        await this.answerOnly(item, route, CONTROL_NOTICE);
      } else if (
        !this.active.has(route.id) &&
        this.active.size < this.workers &&
        !this.botBusy(bot)
      ) {
        const waiting = item.status;
        if (!(await this.store.mark(item, "dispatching"))) continue;
        this.launch(item, route, bot, waiting);
        started++;
      }
    }
    return started;
  }

  /** Whether the bot is running something here; other processes are found when the run starts. */
  private botBusy(bot: string): boolean {
    if (this.sessions.isBusy(bot)) return true;
    for (const active of this.active.values()) if (active.bot === bot) return true;
    return false;
  }

  /** Settles a message that gets a reply but no run. */
  private async answerOnly(item: InboxItem, route: Route, text: string): Promise<void> {
    if (!(await this.store.mark(item, "dispatching"))) return;
    try {
      await this.deliver(route, text);
      await this.store.mark(item, "completed");
    } catch {
      await this.store.mark(item, "delivery_failed");
    }
  }

  private launch(item: InboxItem, route: Route, bot: string, waiting: InboxStatus): void {
    const active: Active = {
      route,
      item,
      bot,
      waiting,
      stopped: false,
      started: false,
      chores: new Set(),
      done: Promise.resolve(),
    };
    this.active.set(route.id, active);
    active.done = this.run(active).finally(() => {
      this.active.delete(route.id);
    });
  }

  private async run(active: Active): Promise<void> {
    const { item, route } = active;
    try {
      if (!(await this.store.mark(item, "running"))) return;
      if (active.stopped) {
        await this.store.mark(item, "cancelled");
        return;
      }
      const answer = await this.sessions.prompt(route, item.text, {
        onEvent: (e) => this.observe(active, e),
      });
      await this.settleChores(active);
      await this.store.mark(item, "delivering");
      let text = answer.text || `Run ${answer.outcome}; no assistant text returned.`;
      if (answer.outcome !== "completed") text += `\n[Run ${answer.outcome}]`;
      try {
        await this.deliver(route, text);
        await this.store.mark(item, answer.outcome satisfies InboxStatus);
      } catch {
        await this.store.mark(item, "delivery_failed");
      }
    } catch (err) {
      if (err instanceof BotBusy) {
        // Another process is running the bot: the item waits for a later tick.
        await this.store.mark(item, active.waiting).catch(() => {});
        return;
      }
      // Once the session has the prompt, what it did is unknown; before that, nothing ran.
      await this.store.mark(item, active.started ? "uncertain" : "failed").catch(() => {});
      await this.sessions.abort(route).catch(() => {});
      const reason = err instanceof Error ? err.message : String(err);
      await this.deliver(route, active.started ? INTERRUPTED : reason).catch(() => {});
    } finally {
      await this.settleChores(active);
      for (const [id, open] of this.cards) {
        if (open.active === active) await this.resolve(id, false, "run_closed");
      }
    }
  }

  private async settleChores(active: Active): Promise<void> {
    while (active.chores.size > 0) await Promise.allSettled([...active.chores]);
  }

  /** Passes a session event on and acts on approval requests and answers. */
  private observe(active: Active, e: SessionEvent): void {
    if (!active.started) {
      active.started = true;
      // A stop that came before the prompt reached the session could not abort it then.
      if (active.stopped) this.chore(active, this.sessions.abort(active.route));
    }
    try {
      this.sink.event(active.route, e);
    } catch {
      // A failing page must not stop the run.
    }
    if (e.type === "approval_requested") {
      this.chore(active, this.ask(active, e));
    } else if (e.type === "approval_resolved") {
      const open = this.cards.get(e.approvalId);
      if (open && !open.deciding) this.chore(active, this.resolve(e.approvalId, e.allow, "worker"));
    }
  }

  private chore(active: Active, work: Promise<unknown>): void {
    const tracked = work.then(
      () => {},
      () => {},
    );
    active.chores.add(tracked);
    void tracked.finally(() => active.chores.delete(tracked));
  }

  /** Records an approval request and shows it; one that cannot be shown is denied. */
  private async ask(active: Active, e: ApprovalRequest): Promise<void> {
    const { item, route } = active;
    await this.store.addApproval({
      id: e.approvalId,
      chat: route.chat,
      user: item.actor,
      thread: route.thread,
      run: SESSION_RUN,
      tool: e.tool,
      digest: e.digest,
      expires: e.expiresAt,
    });
    const card: ApprovalCard = {
      id: e.approvalId,
      tool: e.tool,
      preview: e.preview,
      digest: e.digest,
      expiresAt: e.expiresAt,
      run: item.run,
      bot: route.bot ?? (await this.store.chief()).id,
    };
    const open: OpenCard = { card, active, deciding: false, timer: undefined };
    this.cards.set(card.id, open);
    this.arm(open);
    try {
      await this.sink.approval(route, card);
    } catch {
      open.deciding = true;
      await this.respond(open, false);
      await this.resolve(card.id, false, "delivery_failed");
    }
  }

  /** Sets the card's timer for its deadline, by the store clock. */
  private arm(open: OpenCard): void {
    const left = (open.card.expiresAt - this.store.ctx.clock()) * 1000;
    // A longer delay would overflow the timer; the timer then fires early and sets itself again.
    open.timer = setTimeout(
      () => void this.expire(open.card.id),
      Math.min(MAX_TIMER, Math.max(0, left)),
    );
    open.timer.unref();
  }

  /** Denies an approval nobody answered in time. */
  private async expire(id: string): Promise<void> {
    const open = this.cards.get(id);
    if (!open || open.deciding) return;
    if (this.store.ctx.clock() < open.card.expiresAt) {
      this.arm(open);
      return;
    }
    open.deciding = true;
    await this.respond(open, false);
    await this.resolve(id, false, "expired");
  }

  /** Gives the session the answer; false when it could not take it. */
  private async respond(open: OpenCard, allow: boolean): Promise<boolean> {
    try {
      const session = await this.sessions.sessionFor(open.active.route);
      const reply = await session.request("respond_to_approval", {
        approvalId: open.card.id,
        allow,
      });
      return reply.success;
    } catch {
      return false;
    }
  }

  /** Closes the card and records the decision. */
  private async resolve(id: string, allow: boolean, source: string): Promise<void> {
    const open = this.cards.get(id);
    if (!open) return;
    this.cards.delete(id);
    clearTimeout(open.timer);
    await this.store.decide(id, allow, source).catch(() => {});
  }

  private async forward(
    route: Route,
    command: "steer" | "follow_up",
    text: string,
  ): Promise<boolean> {
    const active = this.active.get(route.id);
    if (!active || active.stopped) return false;
    const session = await this.sessions.sessionFor(route);
    const reply = await session.request(command, { message: text, requireActive: true });
    return reply.success;
  }

  /** Logs the answer on the route and sends it. */
  private async deliver(route: Route, text: string): Promise<void> {
    await this.store.logMessage(route, text, "out");
    await this.sink.send(route, text);
  }
}
