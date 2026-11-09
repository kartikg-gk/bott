import type { SessionEvent } from "../agent/session.ts";
import type { ApprovalCard, EventContext, Sink } from "../runtime/sink.ts";
import type { Route } from "../store/routes.ts";
import { WEB_CHAT } from "../store/store.ts";
import type { RunJournal } from "./journal.ts";

/** One record on the page's live stream. */
export type StreamRecord = Record<string, unknown> & { type: string };

/** How many records may wait for one slow listener before newer ones are dropped. */
const BACKLOG = 200;
/** Tools whose first argument is a file path the page may show. */
const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);

/** Someone following the page's live stream. */
export interface Listener {
  push(record: StreamRecord | null): void;
}

/** A listener that queues records until they are taken, dropping any past the backlog. */
export class Queue implements Listener {
  private readonly items: (StreamRecord | null)[] = [];
  private waiting: ((record: StreamRecord | null | undefined) => void) | undefined;

  push(record: StreamRecord | null): void {
    if (this.waiting) {
      const wake = this.waiting;
      this.waiting = undefined;
      wake(record);
    } else if (this.items.length < BACKLOG || record === null) {
      this.items.push(record);
    }
  }

  /** The next record; undefined when `ms` pass first, null once the stream is closing. */
  take(ms: number): Promise<StreamRecord | null | undefined> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        resolve(undefined);
      }, ms);
      this.waiting = (record) => {
        clearTimeout(timer);
        resolve(record);
      };
    });
  }
}

/** The page's view of an approval; `expires` is what the page and older clients read. */
export function approvalView(card: ApprovalCard): Record<string, unknown> {
  return {
    id: card.id,
    run: card.run,
    bot: card.bot,
    tool: card.tool,
    preview: card.preview,
    digest: card.digest,
    expires: card.expiresAt,
  };
}

/** Model use a run reported, in the layout existing run journals hold. */
export interface RunUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  model_messages: number;
  cost_usd: number;
}

const emptyRunUsage = (): RunUsage => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  model_messages: 0,
  cost_usd: 0,
});

/** Least time between two partial-answer events of one run, in milliseconds. */
const PARTIAL_MS = 150;

/** What the channel remembers about a run while it goes. */
interface RunState {
  partial: string;
  lastPartial: number;
  usage: RunUsage;
}

/**
 * Where a web instance's answers and live events go. Only the person's main web conversation is
 * shown on the live stream; a run the page started is also written to its journal, so it can be
 * followed whichever conversation it runs on.
 */
export class WebChannel implements Sink {
  private readonly listeners = new Set<Listener>();
  private readonly runs = new Map<string, RunState>();
  private numbers = 0;
  closed = false;

  constructor(
    private readonly journal?: RunJournal,
    private readonly now: () => number = Date.now,
  ) {}

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Ends every live stream. */
  close(): void {
    this.closed = true;
    for (const listener of this.listeners) listener.push(null);
  }

  /** The usage the run has reported, forgetting the run. */
  takeUsage(run: string): RunUsage {
    const usage = this.runs.get(run)?.usage ?? emptyRunUsage();
    this.runs.delete(run);
    return usage;
  }

  private publish(record: StreamRecord): void {
    for (const listener of this.listeners) listener.push(record);
  }

  private shown(route: Route): boolean {
    return route.chat === WEB_CHAT && route.thread === 0;
  }

  private state(run: string): RunState {
    let found = this.runs.get(run);
    if (!found) {
      found = { partial: "", lastPartial: 0, usage: emptyRunUsage() };
      this.runs.set(run, found);
    }
    return found;
  }

  private record(run: string, kind: string, data: object): void {
    void this.journal?.emit(run, kind, data).catch(() => {});
  }

  async send(route: Route, text: string): Promise<void> {
    if (!this.shown(route)) return;
    this.numbers += 1;
    this.publish({ type: "message", id: this.numbers, text });
  }

  event(route: Route, e: SessionEvent, context?: EventContext): void {
    if (context?.run) this.journalEvent(context.run, context.bot, e);
    if (!this.shown(route)) return;
    if (e.type !== "tool_execution_start" && e.type !== "tool_execution_end") return;
    const input = e.type === "tool_execution_start" ? e.input : undefined;
    const path =
      FILE_TOOLS.has(e.name) && typeof input === "object" && input !== null
        ? (input as Record<string, unknown>).path
        : undefined;
    const status =
      e.type === "tool_execution_start" ? "running" : e.isError ? "failed" : "finished";
    this.publish({
      type: "tool",
      id: e.callId,
      name: e.name.slice(0, 60),
      status,
      path: typeof path === "string" ? path.slice(0, 400) : "",
    });
  }

  /** Writes what a follower of the run needs: partial answers, tool calls and model use. */
  private journalEvent(run: string, bot: string, e: SessionEvent): void {
    const state = this.state(run);
    if (e.type === "message_start") {
      state.partial = "";
    } else if (e.type === "message_update" && e.delta.type === "text_delta") {
      state.partial += e.delta.text;
      const now = this.now();
      if (now >= state.lastPartial + PARTIAL_MS) {
        state.lastPartial = now;
        this.record(run, "assistant_text", { text: state.partial });
      }
    } else if (e.type === "tool_execution_start" || e.type === "tool_execution_end") {
      this.record(run, e.type === "tool_execution_start" ? "tool_started" : "tool_finished", {
        id: e.callId,
        bot,
        tool: e.name,
        failed: e.type === "tool_execution_end" && e.isError,
      });
    } else if (e.type === "message_end" && e.message.role === "assistant") {
      const { usage } = e.message;
      state.usage.model_messages += 1;
      state.usage.input += usage.input;
      state.usage.output += usage.output;
      state.usage.cache_read += usage.cacheRead;
      state.usage.cache_write += usage.cacheWrite;
    }
  }

  async approval(route: Route, card: ApprovalCard): Promise<void> {
    const view = approvalView(card);
    if (card.run) {
      const { run: _run, ...details } = view;
      this.record(card.run, "approval_requested", details);
    }
    if (this.shown(route)) this.publish({ type: "approval", ...view });
  }

  async resolved(route: Route, card: ApprovalCard, allow: boolean): Promise<void> {
    if (card.run) this.record(card.run, "approval_resolved", { id: card.id, allowed: allow });
    if (this.shown(route)) this.publish({ type: "approval_resolved", id: card.id, allowed: allow });
  }
}
