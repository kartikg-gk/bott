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

/** Where answers, live events and approval requests for a conversation go. */
export interface Sink {
  send(route: Route, text: string): Promise<void>;
  event(route: Route, e: SessionEvent): void;
  approval(route: Route, card: ApprovalCard): Promise<void>;
}
