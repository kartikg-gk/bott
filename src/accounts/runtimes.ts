import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProviderFactory } from "../runtime/sessions.ts";
import { type AccountProviderOptions, accountProvider } from "./models.ts";
import type { Account, AccountStore } from "./store.ts";

/** Everything an account's own gateway runtime is built from. */
export interface AccountRuntime {
  account: Account;
  /** The account's ID in plain hex; its rows in shared tables carry it as their instance. */
  instance: string;
  stateDir: string;
  projectDir: string;
  /** Where session files go; null when hosted, where transcripts stay in the database. */
  sessionsDir: string | null;
  databasePath: string;
  /** Builds each bot's provider from the account's saved model and key. */
  providers: ProviderFactory;
}

export interface AccountRuntimesOptions<T> {
  /** The gateway's state folder; each account gets web-users/<id> inside it. */
  stateDir: string;
  hosted: boolean;
  store: AccountStore;
  /** Who may still use the gateway; accounts dropped from the allow list are not reopened. */
  login: { permitted(email: string, domain: string | null): boolean };
  /** One factory for every account instead of each account's own model, as in tests. */
  fixed?: ProviderFactory;
  providerOptions?: AccountProviderOptions;
  /** Builds the account's store, sessions and whatever else serves it. */
  create: (runtime: AccountRuntime) => T | Promise<T>;
}

/** The plain hex form of a UUID, or an error for anything else. */
function hexId(id: string): string {
  const hex = id.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex) || (id.includes("-") && id.length !== 36)) {
    throw new Error("Invalid account ID");
  }
  return hex;
}

/** One separate runtime per signed-in account: its own instance, folders and model. */
export class AccountRuntimes<T> {
  private readonly built = new Map<string, Promise<T>>();
  private readonly ready: T[] = [];

  constructor(private readonly opts: AccountRuntimesOptions<T>) {}

  /** What the account's runtime is made of, with its folders created. */
  describe(account: Account): AccountRuntime {
    const instance = hexId(account.id);
    const stateDir = join(this.opts.stateDir, "web-users", instance);
    const projectDir = join(stateDir, "workspace");
    mkdirSync(projectDir, { recursive: true });
    const { store, fixed, providerOptions } = this.opts;
    return {
      account,
      instance,
      stateDir,
      projectDir,
      sessionsDir: this.opts.hosted ? null : join(stateDir, "sessions"),
      databasePath: join(stateDir, "gateway.sqlite3"),
      providers: fixed ?? (() => accountProvider(store, instance, providerOptions)),
    };
  }

  /** The account's runtime, built on first use and shared after. */
  async get(account: Account): Promise<T> {
    const instance = hexId(account.id);
    let found = this.built.get(instance);
    if (!found) {
      found = (async () => this.opts.create(this.describe(account)))();
      this.built.set(instance, found);
      found.then(
        (service) => this.ready.push(service),
        () => this.built.delete(instance),
      );
    }
    return found;
  }

  /** Runtimes built so far. */
  all(): T[] {
    return [...this.ready];
  }

  /** Reopens every account still allowed, so its scheduled work runs before anyone signs in. */
  async start(): Promise<void> {
    for (const account of await this.opts.store.allAccounts()) {
      if (this.opts.login.permitted(account.email, account.domain)) await this.get(account);
    }
  }
}
