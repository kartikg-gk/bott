import { randomUUID } from "node:crypto";
import type { Bot } from "../bots/bots.ts";
import type { Param, Row } from "../db/database.ts";
import type { InboxStatus } from "../store/inbox.ts";
import type { Route } from "../store/routes.ts";
import { type Store, WEB_CHAT } from "../store/store.ts";

/** Inbox statuses of a run that has not ended; existing databases hold these strings. */
export const ACTIVE: readonly InboxStatus[] = [
  "pending",
  "prompt",
  "scheduled",
  "dispatching",
  "running",
  "delivering",
  "cancelling",
];

/** How the page names an inbox status; statuses not listed are shown as they are. */
export const RUN_STATUS: Partial<Record<InboxStatus, string>> = {
  pending: "queued",
  prompt: "queued",
  scheduled: "queued",
  dispatching: "running",
  delivering: "running",
};

/** Events kept per run; older ones are dropped as new ones arrive. */
export const REPLAY_LIMIT = 512;

/** A run as the page sees it. */
export interface RunView {
  id: string;
  bot: string;
  status: string;
  created: number;
  finished: number | null;
  answer: string | null;
  usage?: Record<string, unknown>;
}

export interface RunEvent {
  seq: number;
  kind: string;
  data: Record<string, unknown>;
}

interface RunRow {
  id: string;
  bot: string;
  actor: number;
  inbox: bigint;
  status: InboxStatus;
  created: number;
  finished: number | null;
  answer: string | null;
}

const SELECT =
  "SELECT r.id,r.bot,r.actor,CAST(r.inbox AS TEXT) AS inbox,i.status,i.created,r.finished,r.answer " +
  "FROM web_runs r JOIN inbox i ON i.instance=r.instance AND i.id=r.inbox WHERE r.instance=? AND ";

const marks = (count: number) => Array(count).fill("?").join(",");

function toRun(row: Row): RunRow {
  return {
    id: String(row.id),
    bot: String(row.bot),
    actor: Number(row.actor),
    inbox: BigInt(String(row.inbox)),
    status: String(row.status) as InboxStatus,
    created: Number(row.created),
    finished: row.finished === null || row.finished === undefined ? null : Number(row.finished),
    answer: row.answer === null || row.answer === undefined ? null : String(row.answer),
  };
}

/**
 * The durable record of each run the page starts: its status, its final answer and a bounded
 * list of events a follower can replay from any point still kept.
 */
export class RunJournal {
  private readonly listeners = new Map<string, Set<() => void>>();
  /** Writes for one run go one after another, so its sequence numbers follow event order. */
  private readonly writes = new Map<string, Promise<void>>();
  private recovered: Promise<void> | undefined;
  closed = false;

  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.ctx.db;
  }

  private get instance() {
    return this.store.ctx.instance;
  }

  /** Settles, once per process, runs left open by a process that stopped. */
  private ready(): Promise<void> {
    this.recovered ??= (async () => {
      const rows = await this.db.query(
        "SELECT r.id FROM web_runs r JOIN inbox i ON i.instance=r.instance AND i.id=r.inbox " +
          `WHERE r.instance=? AND r.finished IS NULL AND i.status NOT IN (${marks(ACTIVE.length)})`,
        [this.instance, ...ACTIVE],
      );
      for (const row of rows) await this.finish(String(row.id));
    })().catch((error: unknown) => {
      this.recovered = undefined;
      throw error;
    });
    return this.recovered;
  }

  /**
   * The person's route for a run: their main conversation, or a thread of its own for each bot
   * they talk to directly, numbered in the order they were first used.
   */
  async route(actor: number, bot: Pick<Bot, "id"> | null): Promise<Route> {
    await this.ready();
    const { store, instance } = this;
    if (bot === null) return store.conversation(WEB_CHAT, actor);
    await this.db.run(
      "INSERT OR IGNORE INTO web_bot_routes(instance,actor,bot,thread) " +
        "SELECT ?,?,?,coalesce(max(thread),0)+1 FROM web_bot_routes WHERE instance=? AND actor=?",
      [instance, actor, bot.id, instance, actor],
    );
    const rows = await this.db.query(
      "SELECT thread FROM web_bot_routes WHERE instance=? AND actor=? AND bot=?",
      [instance, actor, bot.id],
    );
    const route = await store.conversation(WEB_CHAT, actor, Number(rows[0]?.thread));
    return route.bot === bot.id ? route : store.switchBot(route, bot.id);
  }

  /** Queues the text as a new run on the route. */
  async queue(route: Route, text: string): Promise<{ run: string; inbox: bigint }> {
    await this.ready();
    const run = randomUUID().replaceAll("-", "");
    const item = await this.store.admitWeb(route.chat, route.user, text, { route, run });
    return { run, inbox: item.id };
  }

  /** Matching runs; recovery itself reads without waiting for recovery. */
  private async rows(where: string, params: Param[], recovering = false): Promise<RunRow[]> {
    if (!recovering) await this.ready();
    return (await this.db.query(SELECT + where, [this.instance, ...params])).map(toRun);
  }

  private async view(row: RunRow): Promise<RunView> {
    const view: RunView = {
      id: row.id,
      bot: row.bot,
      status: RUN_STATUS[row.status] ?? row.status,
      created: row.created,
      finished: row.finished,
      answer: row.answer,
    };
    if (row.finished !== null) {
      const usage = await this.db.query(
        "SELECT data FROM web_run_events WHERE instance=? AND run=? AND kind='run_usage' " +
          "ORDER BY seq DESC LIMIT 1",
        [this.instance, row.id],
      );
      if (usage[0]) view.usage = JSON.parse(String(usage[0].data)) as Record<string, unknown>;
    }
    return view;
  }

  /** The person's run, or null when there is none by that id for them. */
  async get(run: string, actor: number): Promise<RunView | null> {
    const [row] = await this.rows("r.id=? AND r.actor=?", [run, actor]);
    return row ? this.view(row) : null;
  }

  /** Runs of the person's that have not ended, oldest first. */
  async active(actor: number): Promise<RunView[]> {
    const rows = await this.rows(
      `r.actor=? AND r.finished IS NULL AND i.status IN (${marks(ACTIVE.length)}) ORDER BY i.id`,
      [actor, ...ACTIVE],
    );
    return Promise.all(rows.map((row) => this.view(row)));
  }

  /** The person's ten most recently finished runs, optionally on one bot. */
  async recent(actor: number, bot: string | null): Promise<RunView[]> {
    const rows = await this.rows(
      "r.actor=? AND r.finished IS NOT NULL AND (? IS NULL OR r.bot=?) " +
        "ORDER BY r.finished DESC LIMIT 10",
      [actor, bot, bot],
    );
    return Promise.all(rows.map((row) => this.view(row)));
  }

  /** The inbox status behind a run, or null for an unknown run. */
  async status(run: string): Promise<InboxStatus | null> {
    const [row] = await this.rows("r.id=?", [run]);
    return row?.status ?? null;
  }

  /** Keeps the run's final answer. */
  async answer(run: string, text: string): Promise<void> {
    await this.db.run("UPDATE web_runs SET answer=?,version=version+1 WHERE instance=? AND id=?", [
      text,
      this.instance,
      run,
    ]);
  }

  /** Runs `work` after every earlier write for the run. */
  private serial(run: string, work: () => Promise<void>): Promise<void> {
    const next = (this.writes.get(run) ?? Promise.resolve()).then(work);
    const settled = next.catch(() => {});
    this.writes.set(run, settled);
    void settled.then(() => {
      if (this.writes.get(run) === settled) this.writes.delete(run);
    });
    return next;
  }

  private async append(run: string, kind: string, data: object): Promise<void> {
    // The sequence number is worked out by the same statement that adds the event.
    const rows = await this.db.query(
      "INSERT INTO web_run_events(instance,run,seq,kind,data) " +
        "SELECT ?,?,coalesce(max(seq),0)+1,?,? FROM web_run_events WHERE instance=? AND run=? " +
        "RETURNING seq",
      [this.instance, run, kind, JSON.stringify(data), this.instance, run],
    );
    const seq = Number(rows[0]?.seq);
    if (seq > REPLAY_LIMIT) {
      await this.db.run("DELETE FROM web_run_events WHERE instance=? AND run=? AND seq<=?", [
        this.instance,
        run,
        seq - REPLAY_LIMIT,
      ]);
    }
    this.wake(run);
  }

  /** Records an event on the run and wakes its followers. */
  emit(run: string, kind: string, data: object): Promise<void> {
    return this.serial(run, () => this.append(run, kind, data));
  }

  /**
   * Closes a run whose work is over: a stopping run becomes cancelled, the finish time is set
   * once and one final event carries the run as it ended. A run still going is left alone.
   */
  finish(run: string): Promise<void> {
    return this.serial(run, async () => {
      const [row] = await this.rows("r.id=?", [run], true);
      if (!row || row.finished !== null) return;
      if (ACTIVE.includes(row.status) && row.status !== "cancelling") return;
      if (row.status === "cancelling") {
        await this.db.run(
          "UPDATE inbox SET status='cancelled',version=version+1 WHERE instance=? AND id=? " +
            "AND status='cancelling'",
          [this.instance, row.inbox],
        );
      }
      const first = await this.db.run(
        "UPDATE web_runs SET finished=?,version=version+1 WHERE instance=? AND id=? " +
          "AND finished IS NULL",
        [this.store.ctx.clock(), this.instance, run],
      );
      if (first === 0) return;
      const [ended] = await this.rows("r.id=?", [run], true);
      await this.append(run, "run_finished", ended ? await this.view(ended) : {});
    });
  }

  /** Marks the person's unfinished run as stopping. False when it is not theirs or not going. */
  async cancel(run: string, actor: number): Promise<boolean> {
    const [row] = await this.rows("r.id=? AND r.actor=?", [run, actor]);
    if (!row || !ACTIVE.includes(row.status) || row.status === "cancelling") return false;
    const changed = await this.db.run(
      "UPDATE inbox SET status='cancelling',version=version+1 WHERE instance=? AND id=? " +
        "AND status=?",
      [this.instance, row.inbox, row.status],
    );
    return changed > 0;
  }

  /** Events after `after`, oldest first. */
  async events(run: string, after: number): Promise<RunEvent[]> {
    await this.ready();
    const rows = await this.db.query(
      "SELECT seq,kind,data FROM web_run_events WHERE instance=? AND run=? AND seq>? ORDER BY seq",
      [this.instance, run, after],
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      kind: String(row.kind),
      data: JSON.parse(String(row.data)) as Record<string, unknown>,
    }));
  }

  /**
   * The approval requests these runs' journals hold, by approval id: the run each belongs to and
   * what was shown for it. Approvals asked outside a page's run have none.
   */
  async requested(
    ids: string[],
  ): Promise<Map<string, { run: string; data: Record<string, unknown> }>> {
    const found = new Map<string, { run: string; data: Record<string, unknown> }>();
    if (ids.length === 0) return found;
    await this.ready();
    const rows = await this.db.query(
      "SELECT run,data FROM web_run_events WHERE instance=? AND kind='approval_requested' " +
        `AND json_extract(data,'$.id') IN (${ids.map(() => "?").join(",")})`,
      [this.instance, ...ids],
    );
    for (const row of rows) {
      const data = JSON.parse(String(row.data)) as Record<string, unknown>;
      found.set(String(data.id), { run: String(row.run), data });
    }
    return found;
  }

  /** The tool calls the run made, as far as they are still kept. */
  async activity(run: string): Promise<Record<string, unknown>[]> {
    const events = await this.events(run, 0);
    return events
      .filter((e) => e.kind === "tool_started" || e.kind === "tool_finished")
      .map((e) => ({
        seq: e.seq,
        type: e.kind,
        id: e.data.id ?? null,
        bot: e.data.bot ?? null,
        tool: e.data.tool ?? null,
        failed: Boolean(e.data.failed),
      }));
  }

  /** Calls `wake` whenever the run gets an event; returns the call that stops it. */
  subscribe(run: string, wake: () => void): () => void {
    let set = this.listeners.get(run);
    if (!set) {
      set = new Set();
      this.listeners.set(run, set);
    }
    set.add(wake);
    return () => {
      set.delete(wake);
      if (set.size === 0) this.listeners.delete(run);
    };
  }

  private wake(run: string): void {
    for (const wake of this.listeners.get(run) ?? []) wake();
  }

  /** Lets every follower go. */
  close(): void {
    this.closed = true;
    for (const run of this.listeners.keys()) this.wake(run);
  }
}
