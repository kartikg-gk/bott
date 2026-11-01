/**
 * Builds the whole server from its settings: the database and its schema, sign-in, a gateway
 * per instance, connected apps and the request handler. The command line, the hosted function
 * and tests all start the server through `startServer`.
 */

import { join } from "node:path";
import { checkGoogleBind, GoogleLogin } from "./accounts/google.ts";
import { localToken } from "./accounts/localToken.ts";
import { AccountModels, PROVIDERS } from "./accounts/models.ts";
import { type AccountStore, openAccountStore } from "./accounts/store.ts";
import { anthropicProvider } from "./agent/providers/anthropic.ts";
import { openAICompatibleProvider } from "./agent/providers/openai.ts";
import { withRetry } from "./agent/providers/retry.ts";
import type { FetchFn, ModelProvider, StreamEvent } from "./agent/providers/types.ts";
import { AppConnections } from "./apps/connections.ts";
import { type Config, ConfigError, type Env, PROVIDER_KEYS } from "./config.ts";
import { createDatabase, D1_VARIABLES, type Database } from "./db/database.ts";
import { ensureSchema } from "./db/schema.ts";
import { ModelLimits } from "./limits/limits.ts";
import type { ProviderFactory, RuntimeConfig } from "./runtime/sessions.ts";
import { AccountGateways } from "./web/accounts.ts";
import { createApp } from "./web/app.ts";
import { accountAppStores, connectedApps } from "./web/apps.ts";
import { Gateway, type GatewayOptions } from "./web/gateway.ts";

export interface StartOptions {
  /** Where secrets and keys are read from; the process environment when left out. */
  env?: Env;
  /** An open database instead of the configured one; it is closed with the server. */
  db?: Database;
  /** One provider for every bot instead of the configured or chosen model, as in tests. */
  providers?: ProviderFactory;
  fetch?: FetchFn;
}

export interface Server {
  readonly config: Config;
  readonly db: Database;
  /** Answers every request for the page, sign-in and the API. */
  readonly handler: (request: Request) => Promise<Response>;
  /** The account store in Google mode; null with a token. */
  readonly accounts: AccountStore | null;
  /**
   * The gateways whose scheduled work a runner owns: this machine's one in token mode, and in
   * Google mode one for every account that exists and is allowed to sign in at the time of
   * asking, so accounts made or removed since the last call are counted in or out.
   */
  gateways(): Promise<Gateway[]>;
  close(): Promise<void>;
}

/** A provider that only ever explains why no model can be called. */
function refusing(message: string): ModelProvider {
  return {
    id: "unconfigured",
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: "error", message, retryable: false };
    },
  };
}

/** The model provider for token mode, from BOTT_PROVIDER and that provider's key. */
export function tokenProvider(config: Config, env: Env, fetchFn?: FetchFn): ModelProvider {
  const name = config.provider;
  if (!name) {
    return refusing("No model is set up: set BOTT_PROVIDER and BOTT_MODEL for this server");
  }
  const variable = PROVIDER_KEYS[name] as string;
  const key = env[variable]?.trim();
  if (!key) return refusing(`Set ${variable} for the ${name} provider`);
  const base = (PROVIDERS[name] as { base: string }).base;
  const extra = fetchFn ? { fetch: fetchFn } : {};
  const raw =
    name === "anthropic"
      ? anthropicProvider({ apiKey: key, baseUrl: base, ...extra })
      : openAICompatibleProvider({ apiKey: key, baseUrl: base, id: name, ...extra });
  return withRetry(raw, { attempts: 3, baseMs: 1000 });
}

function runtime(config: Config): RuntimeConfig {
  return {
    stateDir: config.stateDir,
    projectDir: config.projectDir,
    sessionsDir: config.hosted ? null : join(config.stateDir, "sessions"),
    policy: config.policy,
    model: config.model,
    idleSeconds: config.idleSeconds,
    approvalSeconds: config.approvalSeconds,
    computer: config.computer,
    ...(config.thinking ? { thinking: config.thinking } : {}),
  };
}

function memory(config: Config, env: Env): GatewayOptions["memory"] {
  return config.memory.enabled ? { config: config.memory, env } : undefined;
}

/** One person on this machine, behind the token. */
async function tokenServer(config: Config, db: Database, opts: StartOptions): Promise<Server> {
  const env = opts.env ?? process.env;
  const token = localToken(env, { hosted: config.hosted });
  const limits = new ModelLimits(db, config.instance, config.limits);
  const shared = opts.providers ? null : tokenProvider(config, env, opts.fetch);
  const providers: ProviderFactory = (bot, profile) => {
    const provider = opts.providers ? opts.providers(bot, profile) : (shared as ModelProvider);
    return limits.meter(provider, config.provider ?? provider.id);
  };
  const gateway = await Gateway.open({
    db,
    instance: config.instance,
    runtime: runtime(config),
    providers,
    actor: config.actor,
    limits,
    ...(config.workers === undefined ? {} : { workers: config.workers }),
    memory: memory(config, env),
  });
  const handler = createApp({
    auth: { mode: "token", token, gateway },
    proxySecret: config.proxySecret,
  });
  return {
    config,
    db,
    handler,
    accounts: null,
    gateways: async () => [gateway],
    close: async () => {
      await gateway.close();
      await db.close();
    },
  };
}

/** Everyone on the allow list, each with a gateway, model and apps of their own. */
async function googleServer(config: Config, db: Database, opts: StartOptions): Promise<Server> {
  const env = opts.env ?? process.env;
  if (!config.origin) {
    throw new ConfigError("Set BOTT_ORIGIN to the page's public origin for Google sign-in");
  }
  const origin = config.origin;
  if (!config.hosted) checkGoogleBind(origin, config.host);
  const opened = await openAccountStore({
    hosted: config.hosted,
    db,
    stateDir: config.stateDir,
    realm: config.instance,
    env,
  });
  const { store } = opened;
  let gateways: AccountGateways | undefined;
  try {
    const login = new GoogleLogin(store, {
      origin,
      clientId: env.BOTT_GOOGLE_CLIENT_ID,
      clientSecret: env.BOTT_GOOGLE_CLIENT_SECRET,
      emails: config.allowedEmails,
      domains: config.allowedDomains,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    const connections = new AppConnections({
      ...accountAppStores(store),
      storeFor: async (id) => {
        const account = await store.account(id);
        if (!account || !gateways) throw new Error("That account is not open here");
        return (await gateways.gateway(account)).store;
      },
      origin,
      env,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    const apps = connectedApps(connections);
    const built = new AccountGateways({
      store,
      login,
      stateDir: config.stateDir,
      hosted: config.hosted,
      db,
      policy: config.policy,
      model: config.model,
      idleSeconds: config.idleSeconds,
      approvalSeconds: config.approvalSeconds,
      ...(config.thinking ? { thinking: config.thinking } : {}),
      computer: config.computer,
      limits: config.limits,
      ...(config.workers === undefined ? {} : { workers: config.workers }),
      ...(opts.providers ? { fixed: opts.providers } : {}),
      apps,
      memory: memory(config, env),
    });
    gateways = built;
    const models = new AccountModels(store, {
      busy: (account) => built.busy(account),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    const handler = createApp({
      auth: { mode: "google", login, models, gateway: (account) => built.gateway(account) },
      proxySecret: config.proxySecret,
      apps,
    });
    return {
      config,
      db,
      handler,
      accounts: store,
      gateways: () => built.runtimes.current(),
      close: async () => {
        await built.close();
        await opened.close();
        await db.close();
      },
    };
  } catch (error) {
    await opened.close();
    throw error;
  }
}

/** Opens the database, brings its schema up to date and builds the server on it. */
export async function startServer(config: Config, opts: StartOptions = {}): Promise<Server> {
  const env = opts.env ?? process.env;
  // A hosted function's disk is gone at its next cold start, so its data must live in D1.
  if (config.hosted && !opts.db && !env.CLOUDFLARE_D1_DATABASE_ID?.trim()) {
    throw new ConfigError(`Hosted mode keeps its data in D1; set ${D1_VARIABLES.join(", ")}`);
  }
  const db = opts.db ?? createDatabase(config, env);
  try {
    await ensureSchema(db);
    return config.auth === "google"
      ? await googleServer(config, db, opts)
      : await tokenServer(config, db, opts);
  } catch (error) {
    await db.close();
    throw error;
  }
}
