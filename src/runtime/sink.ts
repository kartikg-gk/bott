import type { SessionEvent } from "../agent/session.ts";
import type { Route } from "../store/routes.ts";

/** A tool call waiting for the person's yes or no, as the page shows it. */
export interface ApprovalCard {
  /** The approval's id; a decision names it. */
  id: string;
  tool: string;
  /** The call's input, shortened. */
  preview: string;
  /** Fingerprint of the tool name and input. */
  digest: string;
  /** Seconds since the epoch. */
  expiresAt: number;
  /** The page's run the request belongs to, if it started from one. */
  run: string | null;
  /** The bot whose session asked. */
  bot: string | null;
}

/** Which run an event belongs to and which bot's session sent it. */
export interface EventContext {
  /** The page's run, when the event comes from one. */
  run: string | null;
  bot: string;
}

/** Where answers, live events and approval requests for a conversation go. */
export interface Sink {
  send(route: Route, text: string): Promise<void>;
  event(route: Route, e: SessionEvent, context?: EventContext): void;
  approval(route: Route, card: ApprovalCard): Promise<void>;
  /** Told once a shown approval is settled, however it was settled. */
  resolved?(route: Route, card: ApprovalCard, allow: boolean): Promise<void>;
}
