import { AccountRuntimes } from "../accounts/runtimes.ts";
import type { Account, AccountStore } from "../accounts/store.ts";
import type { Policy } from "../agent/policy.ts";
import type { ComputerFactory } from "../computers/index.ts";
import type { ComputerSettings } from "../computers/settings.ts";
import type { Database } from "../db/database.ts";
import { SqliteDatabase } from "../db/sqlite.ts";
import type { LimitsConfig } from "../limits/limits.ts";
import type { ProviderFactory } from "../runtime/sessions.ts";
import { type AppsSeam, NO_APPS } from "./apps.ts";
import { Gateway, type GatewayOptions } from "./gateway.ts";

/** Inside each account's own instance, the page acts for this one person. */
export const ACCOUNT_ACTOR = 1;

export interface AccountGatewaysOptions {
  store: AccountStore;
  login: { permitted(email: string, domain: string | null): boolean };
  stateDir: string;
  hosted: boolean;
  /** Hosted, every account's rows go in this one database under the account's instance. */
  db: Database;
  policy: Policy;
  model: string;
  idleSeconds: number;
  approvalSeconds?: number;
  computer?: ComputerSettings;
  computers?: ComputerFactory;
  limits?: Partial<LimitsConfig>;
  workers?: number;
  /** One provider for every account instead of each account's own model, as in tests. */
  fixed?: ProviderFactory;
  /** Connected apps for each account's bots; none when left out. */
  apps?: AppsSeam;
  /** Long-term memory for each account's gateway; off when left out. */
  memory?: GatewayOptions["memory"];
}

/**
 * One gateway per signed-in account: its own instance, folders, model and limits. Locally each
 * account also gets its own database file; hosted ones share the deployment's database.
 */
export class AccountGateways {
  readonly runtimes: AccountRuntimes<Gateway>;
  private readonly files: Database[] = [];

  constructor(opts: AccountGatewaysOptions) {
    this.runtimes = new AccountRuntimes<Gateway>({
      stateDir: opts.stateDir,
      hosted: opts.hosted,
      store: opts.store,
      login: opts.login,
      ...(opts.fixed ? { fixed: opts.fixed } : {}),
      limits: { db: opts.db, config: opts.limits ?? {} },
      create: async (runtime) => {
        let db = opts.db;
        if (!opts.hosted) {
          db = new SqliteDatabase(runtime.databasePath);
          this.files.push(db);
        }
        const gateway = await Gateway.open({
          db,
          instance: runtime.instance,
          hosted: opts.hosted,
          actor: ACCOUNT_ACTOR,
          runtime: {
            stateDir: runtime.stateDir,
            projectDir: runtime.projectDir,
            sessionsDir: runtime.sessionsDir,
            policy: opts.policy,
            model: opts.model,
            idleSeconds: opts.idleSeconds,
            ...(opts.approvalSeconds === undefined
              ? {}
              : { approvalSeconds: opts.approvalSeconds }),
            ...(opts.computer ? { computer: opts.computer } : {}),
          },
          providers: runtime.providers,
          limits: runtime.limits,
          requireAccountModel: !opts.fixed,
          ...(opts.workers === undefined ? {} : { workers: opts.workers }),
          ...(opts.computers ? { computers: opts.computers } : {}),
          ...(opts.memory ? { memory: opts.memory } : {}),
        });
        await (opts.apps ?? NO_APPS).attach(gateway, runtime.account);
        return gateway;
      },
    });
  }

  gateway(account: Account): Promise<Gateway> {
    return this.runtimes.get(account);
  }

  /** Whether any of the account's bots is working, so its model keys stay as they are. */
  busy(accountId: string): boolean {
    const instance = accountId.replaceAll("-", "").toLowerCase();
    return this.runtimes
      .all()
      .some((gateway) => gateway.store.ctx.instance === instance && gateway.working());
  }

  async close(): Promise<void> {
    for (const gateway of this.runtimes.all()) await gateway.close();
    for (const db of this.files.splice(0)) await db.close();
  }
}
