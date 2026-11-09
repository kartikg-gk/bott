import type { App, AppContext, AppServices, Env } from "./app.ts";
import { calendar } from "./calendar.ts";
import { drive } from "./drive.ts";
import { github } from "./github.ts";
import { gmail } from "./gmail.ts";
import { AppError, type Fetch, HttpError } from "./http.ts";

/** Every app the server can run, in the order people see them. */
const ORDER: App[] = [github, gmail, calendar, drive];

/** Every app the server can run, by name. */
export const APPS: Record<string, App> = Object.fromEntries(ORDER.map((app) => [app.name, app]));

/** The app a tool belongs to. */
export function toolOwner(tool: string, apps: Record<string, App> = APPS): string | undefined {
  for (const app of Object.values(apps)) {
    if (app.tools.some((t) => t.name === tool)) return app.name;
  }
  return undefined;
}

export interface RunnerOptions {
  fetch?: Fetch;
  env?: Env;
  apps?: Record<string, App>;
  /** The signed-in account's token for an app. Without it, apps use the server's own settings. */
  accessToken?: (app: string) => Promise<string>;
  /** A renewed token after the service refused `rejected`. */
  recoverToken?: (app: string, rejected: string) => Promise<string>;
  /** Whether the app is ready for this account. Without it, the server's settings decide. */
  available?: (app: string) => Promise<boolean>;
  services?: AppServices;
}

/** Runs app tools for one account, or for the server's own keys when no account is given. */
export class AppRunner {
  readonly apps: Record<string, App>;
  readonly accounts: boolean;
  private readonly fetcher: Fetch;
  private readonly env: Env;

  constructor(private readonly opts: RunnerOptions = {}) {
    this.apps = opts.apps ?? APPS;
    this.fetcher = opts.fetch ?? fetch;
    this.env = opts.env ?? process.env;
    this.accounts = opts.accessToken !== undefined;
  }

  async configured(name: string): Promise<boolean> {
    const app = this.apps[name];
    if (!app) return false;
    if (this.opts.available) return this.opts.available(name);
    return app.configured(this.env);
  }

  /** Runs one tool. What the service said comes back as text marked as outside content. */
  async run(tool: string, args: Record<string, unknown>, botName?: string): Promise<string> {
    const owner = toolOwner(tool, this.apps);
    const app = owner ? this.apps[owner] : undefined;
    if (!app) throw new AppError("Unknown tool");
    const { accessToken, recoverToken } = this.opts;
    let current: string | undefined;
    const ctx: AppContext = {
      fetch: this.fetcher,
      env: this.env,
      accounts: this.accounts,
      botName,
      services: this.opts.services ?? {},
      token: async () => {
        if (!accessToken) throw new AppError(`Connect ${app.name} from a signed-in account`);
        current ??= await accessToken(app.name);
        return current;
      },
    };
    try {
      return await app.run(ctx, tool, args);
    } catch (error) {
      const refused = error instanceof HttpError && error.status === 401;
      if (!refused || !app.retryOnRefusal || !recoverToken || current === undefined) throw error;
      current = await recoverToken(app.name, current);
      return app.run(ctx, tool, args);
    }
  }
}
