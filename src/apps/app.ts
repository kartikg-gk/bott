import type { Fetch } from "./http.ts";
import type { AppTool } from "./schema.ts";

export type Env = Record<string, string | undefined>;

/** What an app's tools get when they run. */
export interface AppContext {
  fetch: Fetch;
  env: Env;
  /** Whether the call runs for a signed-in account, with that account's connections. */
  accounts: boolean;
  /** The account's current token for this app. */
  token(): Promise<string>;
  /** The bot making the call. */
  botName?: string | undefined;
  /** Extra services some apps need, keyed by name. */
  services: AppServices;
}

/** Optional services the runner hands to the apps that use them. */
export interface AppServices {
  /** Sends text to the account's linked Telegram chat. */
  telegramSend?: (text: string) => Promise<unknown>;
  /** Reads text from a PDF or image. */
  documents?: {
    read(
      data: Uint8Array,
      mime: string | undefined,
      args: { page?: number; offset?: number },
    ): Promise<Record<string, unknown>>;
  };
}

/** A connected app: its tools and how the server runs them. */
export interface App {
  name: string;
  tools: AppTool[];
  /** Whether it works without a signed-in account, from the server's own settings. */
  configured(env: Env): boolean;
  /** Runs one tool and returns what the bot reads. */
  run(ctx: AppContext, tool: string, args: Record<string, unknown>): Promise<string>;
  /** A refused token is renewed once and the call retried. */
  retryOnRefusal?: boolean;
}

export function envSet(env: Env, name: string): boolean {
  return Boolean(env[name]?.trim());
}
