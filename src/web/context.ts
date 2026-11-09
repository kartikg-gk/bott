import type { Account } from "../accounts/store.ts";
import type { Gateway } from "./gateway.ts";
import type { Router } from "./router.ts";

/** What every API handler is given about the request it answers. */
export interface Ctx {
  gateway: Gateway;
  /** The person the request acts for inside the gateway. */
  actor: number;
  /** The signed-in account, in Google mode. */
  account: Account | null;
  /** The browser's sign-in session, in Google mode; apps tie started connections to it. */
  session?: string;
  /** False once whoever sent the request is no longer signed in; long streams ask again. */
  alive(): Promise<boolean>;
}

export type ApiRouter = Router<Ctx>;
