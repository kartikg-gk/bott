import type { SessionEvent } from "../../src/agent/session.ts";
import type { ApprovalCard, Sink } from "../../src/runtime/sink.ts";
import type { Route } from "../../src/store/routes.ts";

/** Keeps everything sent to it, so tests can read it back. */
export class MemorySink implements Sink {
  readonly sent: { route: Route; text: string }[] = [];
  readonly events: { route: Route; e: SessionEvent }[] = [];
  readonly cards: { route: Route; card: ApprovalCard }[] = [];
  /** When set, sending fails with this message. */
  failSend: string | null = null;
  private seen = 0;
  private waiters: (() => void)[] = [];

  async send(route: Route, text: string): Promise<void> {
    if (this.failSend) throw new Error(this.failSend);
    this.sent.push({ route, text });
  }

  event(route: Route, e: SessionEvent): void {
    this.events.push({ route, e });
  }

  async approval(route: Route, card: ApprovalCard): Promise<void> {
    this.cards.push({ route, card });
    for (const wake of this.waiters.splice(0)) wake();
  }

  /** The next card not yet taken, waiting for it if need be. */
  async nextCard(): Promise<ApprovalCard> {
    while (this.cards.length <= this.seen) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return (this.cards[this.seen++] as { card: ApprovalCard }).card;
  }

  texts(): string[] {
    return this.sent.map((s) => s.text);
  }
}
