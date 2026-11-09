/**
 * Where connected apps plug into the web gateway. The apps layer is built separately; until it
 * is part of the build, `NO_APPS` is used and bots get no app tools and the page no app routes.
 *
 * Once it is, its seam does two things:
 * - `attach`: give each gateway's sessions the bot-facing apps for its account, as in
 *   `gateway.sessions.apps = new BotApps(gateway.store, connections.runner(account.id))`;
 * - `routes`: add the routes that list, connect, finish connecting, disconnect and grant apps.
 *
 * `accountAppStores` already backs the stores that layer asks for with the account tables:
 * credentials sealed to account, kind and name; started connections held as digests; and the
 * shared limit on key checks.
 */

import type { Account, AccountStore } from "../accounts/store.ts";
import type { ApiRouter } from "./context.ts";
import type { Gateway } from "./gateway.ts";

export interface AppsSeam {
  /** Called with each gateway as it is built; `account` is null on this machine's own gateway. */
  attach(gateway: Gateway, account: Account | null): void | Promise<void>;
  /** Adds the app routes to the API. */
  routes(router: ApiRouter): void;
}

/** The seam while the apps layer is not part of the build: it adds nothing. */
export const NO_APPS: AppsSeam = {
  attach() {},
  routes() {},
};

/** An account's secrets, sealed by the account store. `get` throws when one will not open. */
export interface SealedCredentials {
  get(account: string, kind: string, name: string): Promise<string | null>;
  put(account: string, kind: string, name: string, value: string): Promise<void>;
  delete(account: string, kind: string, name: string): Promise<void>;
}

/** Started app connections; each works once, for the browser session that began it. */
export interface AppFlows {
  start(
    account: string,
    app: string,
    session: string,
    state: string,
    verifier: string,
  ): Promise<void>;
  consume(account: string, app: string, session: string, state: string): Promise<string | null>;
  forget(account: string, app: string): Promise<void>;
}

/** How often one account may ask the server to check a key or start a link. */
export interface Attempts {
  attempt(account: string): Promise<boolean>;
}

/** The apps layer's three stores, kept in the account tables. */
export function accountAppStores(store: AccountStore): {
  credentials: SealedCredentials;
  flows: AppFlows;
  attempts: Attempts;
} {
  return {
    credentials: {
      get: (account, kind, name) => store.credential(account, kind, name),
      put: (account, kind, name, value) => store.putCredential(account, kind, name, value),
      delete: (account, kind, name) => store.deleteCredential(account, kind, name),
    },
    flows: {
      start: (account, app, session, state, verifier) =>
        store.startAppFlow(account, app, session, state, verifier),
      consume: (account, app, session, state) => store.consumeAppFlow(account, app, session, state),
      forget: async (account, app) => {
        await store.db.run("DELETE FROM app_flows WHERE account=? AND app=?", [account, app]);
      },
    },
    attempts: { attempt: (account) => store.validationAttempt(account) },
  };
}
