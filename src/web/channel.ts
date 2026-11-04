import type { SessionEvent } from "../agent/session.ts";
import type { ApprovalCard, Sink } from "../runtime/sink.ts";
import type { Route } from "../store/routes.ts";
import { WEB_CHAT } from "../store/store.ts";

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

/**
 * Where a web instance's answers and live events go. Only the person's main web conversation is
 * shown on the live stream; work on a bot's own thread is followed through its run instead.
 */
export class WebChannel implements Sink {
  private readonly listeners = new Set<Listener>();
  private numbers = 0;
  closed = false;

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Ends every live stream. */
  close(): void {
    this.closed = true;
    for (const listener of this.listeners) listener.push(null);
  }

  private publish(record: StreamRecord): void {
    for (const listener of this.listeners) listener.push(record);
  }

  private shown(route: Route): boolean {
    return route.chat === WEB_CHAT && route.thread === 0;
  }

  async send(route: Route, text: string): Promise<void> {
    if (!this.shown(route)) return;
    this.numbers += 1;
    this.publish({ type: "message", id: this.numbers, text });
  }

  event(route: Route, e: SessionEvent): void {
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

  async approval(route: Route, card: ApprovalCard): Promise<void> {
    if (this.shown(route)) this.publish({ type: "approval", ...approvalView(card) });
  }

  async resolved(route: Route, card: ApprovalCard, allow: boolean): Promise<void> {
    if (this.shown(route)) this.publish({ type: "approval_resolved", id: card.id, allowed: allow });
  }
}
