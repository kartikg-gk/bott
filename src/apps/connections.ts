import { randomBytes } from "node:crypto";
import type { Store } from "../store/store.ts";
import type { Env } from "./app.ts";
import type { AttemptLimit, CredentialStore, FlowStore } from "./credentials.ts";
import { MemoryAttempts } from "./credentials.ts";
import { checkGranolaKey, granolaKeyValid } from "./granola.ts";
import { AppError, type Fetch, HttpError } from "./http.ts";
import {
  type Client,
  OAUTH_APPS,
  type OAuthApp,
  OLDER_GMAIL_SCOPES,
  type SavedToken,
  signInLink,
  tokenRequest,
  wisprClientFields,
} from "./providers.ts";
import { AppRunner } from "./registry.ts";
import { TELEGRAM_APP_TOKEN, TELEGRAM_MAIN_TOKEN, TelegramLinks } from "./telegram.ts";
import { checkTinyfishKey, providerKeyValid } from "./tinyfish.ts";
import { registerWisprClient } from "./wispr.ts";

export {
  GMAIL_SCOPES,
  GOOGLE_AUTH_URL,
  OAUTH_APPS,
  type OAuthApp,
  type SavedToken,
} from "./providers.ts";

/** A refusal the web layer turns into an HTTP status with this message. */
export class ConnectionError extends Error {
  override name = "ConnectionError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The service no longer accepts the saved authorization; the account must connect again. */
export class AuthorizationExpired extends AppError {}
/** The registered client is gone too; it is registered afresh on the next connection. */
export class ClientExpired extends AuthorizationExpired {}

/** Apps an account connects with its own API key, checked with the service before saving. */
export const KEY_APPS: Record<
  string,
  {
    label: string;
    valid: (key: unknown) => key is string;
    check: (f: Fetch, key: string) => Promise<void>;
  }
> = {
  granola: { label: "Granola", valid: granolaKeyValid, check: checkGranolaKey },
  tinyfish: { label: "TinyFish", valid: providerKeyValid, check: checkTinyfishKey },
};

/** Who is asking: the signed-in account, its browser session, and a fresh check it still is. */
export interface Caller {
  account: string;
  session: string;
  signedIn?: () => Promise<boolean>;
}

export interface ConnectionsOptions {
  credentials: CredentialStore;
  flows: FlowStore;
  /** The bots and grants of the account's instance. */
  storeFor: (account: string) => Promise<Store>;
  /** Where the browser reaches this server, for OAuth callbacks. */
  origin: string;
  attempts?: AttemptLimit;
  /** Links accounts to a private Telegram chat; built from the environment when left out. */
  telegram?: TelegramLinks;
  /** The server's own Telegram bot token. Falls back to TELEGRAM_BOT_TOKEN in the environment. */
  mainTelegramToken?: string;
  fetch?: Fetch;
  env?: Env;
  /** Seconds since the epoch, as a float. */
  clock?: () => number;
}

const RENEW_MARGIN = 30;
const STATE_LENGTH = 43;
const SIGN_IN_AGAIN = "Your session ended. Sign in, then connect the app again.";

const nonce = () => randomBytes(32).toString("base64url");

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The scopes a token reply grants, read from its `scope` field and the provider's own rules. */
function grantedScopes(app: OAuthApp, reply: Record<string, unknown>, refresh: unknown) {
  const listed = typeof reply.scope === "string" ? reply.scope.trim().split(/[,\s]+/) : [];
  return new Set([...listed, ...(app.impliedScopes?.(reply, refresh) ?? [])]);
}

/**
 * Checks a token reply and returns the token to save. `previous` is the saved token when this
 * is a renewal, which keeps its refresh token when the reply leaves one out.
 */
export function readTokenReply(
  name: string,
  reply: Record<string, unknown>,
  now: number,
  previous?: SavedToken,
): SavedToken {
  const app = OAUTH_APPS[name] as OAuthApp;
  const { access_token: access, expires_in: lifetime } = reply;
  const refresh = "refresh_token" in reply ? reply.refresh_token : (previous?.refresh ?? null);
  if (typeof access !== "string" || access === "" || /\s/.test(access)) {
    throw new AppError(`No usable access token came back from ${name}`);
  }
  if (refresh !== null && (typeof refresh !== "string" || refresh === "")) {
    throw new AppError(`The refresh token from ${name} is not usable`);
  }
  const wanted = app.scopes;
  const scoped = wanted.length > 0;
  if (scoped && reply.scope !== undefined && reply.scope !== null) {
    const granted = grantedScopes(app, reply, refresh);
    const hasAll = (list: string[]) => list.every((s) => granted.has(s));
    // Gmail connections from before label changes renew with the older pair of scopes.
    const olderGmail = name === "gmail" && previous !== undefined && hasAll(OLDER_GMAIL_SCOPES);
    if (!hasAll(wanted) && !olderGmail) {
      throw new AppError(
        name === "gmail"
          ? "Gmail access needs both the mailbox and label permissions"
          : `Some permissions ${name} was asked for were not granted`,
      );
    }
  }
  if (refresh === null && (scoped || app.needsRefresh)) {
    throw new AppError(`${name} gave no long-lived access. Connect it again.`);
  }
  const absent = lifetime === undefined || lifetime === null;
  if (absent && scoped) throw new AppError(`${name} did not say when the access token expires`);
  let seconds: number | null = null;
  if (!absent) {
    seconds = Number(lifetime);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new AppError(`${name} gave an access token expiry that makes no sense`);
    }
  }
  return {
    access,
    refresh: refresh as string | null,
    expires: seconds === null ? null : now + seconds,
  };
}

/** Connects apps to signed-in accounts and hands out their tokens, renewed when due. */
export class AppConnections {
  readonly fetch: Fetch;
  readonly env: Env;
  readonly clock: () => number;
  readonly attempts: AttemptLimit;
  readonly telegram: TelegramLinks;
  /** Why Telegram linking is off, when its settings are unsafe. */
  readonly telegramError: string | undefined;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(readonly opts: ConnectionsOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.env = opts.env ?? process.env;
    this.clock = opts.clock ?? (() => Date.now() / 1000);
    this.attempts = opts.attempts ?? new MemoryAttempts(this.clock);
    const linker =
      opts.telegram ??
      new TelegramLinks(this.env[TELEGRAM_APP_TOKEN] ?? "", this.fetch, this.clock);
    const main = new TelegramLinks(opts.mainTelegramToken ?? this.env[TELEGRAM_MAIN_TOKEN] ?? "");
    if (linker.botId !== null && linker.botId === main.botId) {
      this.telegramError =
        "The Telegram link bot is the server's main Telegram bot. Give linking a bot of its own.";
      this.telegram = new TelegramLinks("", this.fetch, this.clock);
    } else {
      this.telegram = linker;
    }
  }

  // ---- What exists and what is connected ----

  /** The apps an account can connect, in the order people see them. */
  get names(): string[] {
    return [...Object.keys(OAUTH_APPS), ...Object.keys(KEY_APPS), "telegram"];
  }

  configured(name: string): boolean {
    if (name === "telegram") return this.telegram.ready;
    const app = OAUTH_APPS[name];
    if (name in KEY_APPS || app?.perAccountClient) return true;
    return app !== undefined && !!this.env[app.clientId] && !!this.env[app.secret];
  }

  async connected(account: string, name: string): Promise<boolean> {
    if (name === "telegram") return (await this.linkedChat(account)) !== null;
    if (!this.names.includes(name) || !this.configured(name)) return false;
    // A row that cannot be read still counts, so the account is told to reconnect.
    return this.opts.credentials.get(account, "app", name).then(
      (raw) => raw !== null,
      () => true,
    );
  }

  /** Every app with its state for the account and which bots may use it. */
  async list(caller: Caller) {
    const store = await this.opts.storeFor(caller.account);
    const bots = await store.bots();
    const grants = new Map<string, string[]>();
    for (const bot of bots) grants.set(bot.id, await store.pluginsFor(bot.id));
    return Promise.all(
      this.names.map(async (name) => ({
        id: name,
        configured: this.configured(name),
        connected: await this.connected(caller.account, name),
        saved:
          (await this.opts.credentials.get(caller.account, "app", name).catch(() => "")) !== null,
        keyAuth: name in KEY_APPS,
        ...(name === "telegram" && this.telegramError
          ? { configurationError: this.telegramError }
          : {}),
        bots: bots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          enabled: grants.get(bot.id)?.includes(name) ?? false,
        })),
      })),
    );
  }

  // ---- Starting and finishing a connection ----

  /** Starts a connection and returns where to send the browser. */
  async connect(caller: Caller, name: string): Promise<{ url: string }> {
    this.mustKnow(name);
    if (name === "telegram") return { url: await this.startTelegramLink(caller) };
    const keyed = KEY_APPS[name];
    if (keyed) {
      throw new ConnectionError(409, `${keyed.label} connects with an API key; add one in Apps`);
    }
    if (!this.configured(name)) {
      throw new ConnectionError(409, `The server has no OAuth client for ${name} yet`);
    }
    const app = OAUTH_APPS[name] as OAuthApp;
    const callback = this.callbackFor(name);
    const state = nonce();
    const verifier = nonce();
    let clientId = String(this.env[app.clientId]);
    await this.serial(caller.account, name, async () => {
      await this.requireSignedIn(caller, SIGN_IN_AGAIN);
      let stored = verifier;
      if (app.perAccountClient) {
        clientId = await this.accountClient(caller.account, callback).catch(() => {
          throw new ConnectionError(502, "Wispr Flow would not register a client for this server");
        });
        await this.requireSignedIn(caller, SIGN_IN_AGAIN);
        stored = JSON.stringify({ verifier, client_id: clientId, callback });
      }
      await this.opts.flows.start(caller.account, name, caller.session, state, stored);
    });
    return { url: signInLink(app, { clientId, callback, state, verifier }) };
  }

  /** Finishes a connection from the provider's redirect; returns where to send the browser. */
  async callback(
    caller: Caller,
    name: string,
    query: { state?: string | null; code?: string | null },
  ): Promise<string> {
    this.mustKnow(name);
    const state = query.state ?? "";
    const code = query.code ?? "";
    const oauth = OAUTH_APPS[name];
    if (!oauth || state.length !== STATE_LENGTH || !this.configured(name)) {
      throw new ConnectionError(400, "This sign-in link is not valid. Connect the app again.");
    }
    await this.serial(caller.account, name, async () => {
      const stored = await this.opts.flows.consume(caller.account, name, caller.session, state);
      if (stored === null || code.length < 1 || code.length > 4096) {
        throw new ConnectionError(400, "The app sign-in timed out or was turned down");
      }
      const token = await this.redeem(name, oauth, stored, code).catch(async (error) => {
        if (error instanceof ClientExpired) {
          await this.opts.credentials.delete(caller.account, "app-client", name);
        }
        throw new ConnectionError(502, `Connecting ${name} failed. Connect it again.`);
      });
      await this.requireSignedIn(caller, SIGN_IN_AGAIN);
      await this.replace(caller.account, name, token);
    });
    return "/?apps=1";
  }

  /** Trades the code from a redirect for a token, using the client the flow was started with. */
  private async redeem(name: string, app: OAuthApp, stored: string, code: string) {
    const redirect = this.callbackFor(name);
    let verifier = stored;
    let client: Client | undefined;
    if (app.perAccountClient) {
      const bound = JSON.parse(stored) as { verifier: string; client_id: string; callback: string };
      if (bound.callback !== redirect) {
        throw new AppError("The Wispr Flow callback address is not the one it started with");
      }
      verifier = bound.verifier;
      client = wisprClientFields(bound.client_id);
    }
    const reply = await this.postToken(
      name,
      { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect },
      client,
    );
    const token = readTokenReply(name, reply, this.clock());
    if (client) token.client_id = client.client_id;
    return token;
  }

  /** Saves an app's API key once the service has accepted it. */
  async saveKey(caller: Caller, name: string, body: unknown): Promise<{ connected: true }> {
    this.mustKnow(name);
    const keyed = KEY_APPS[name];
    if (!keyed) throw new ConnectionError(404, "That app does not connect with an API key");
    const key = (body as { key?: unknown } | null)?.key;
    if (!keyed.valid(key)) throw new ConnectionError(400, `Enter a ${keyed.label} API key`);
    const ended = `Your session ended. Sign in, then add the ${keyed.label} key again.`;
    await this.serial(caller.account, name, async () => {
      await this.requireSignedIn(caller, ended);
      if (!(await this.attempts.attempt(caller.account))) {
        throw new ConnectionError(429, "Too many key checks. Wait a few minutes, then try again.");
      }
      try {
        await keyed.check(this.fetch, key);
      } catch (error) {
        const refused = error instanceof HttpError && [401, 403].includes(error.status);
        throw refused
          ? new ConnectionError(422, `${keyed.label} rejected that key`)
          : new ConnectionError(502, `${keyed.label} could not be asked about that key`);
      }
      await this.requireSignedIn(caller, ended);
      await this.replace(caller.account, name, { access: key, refresh: null, expires: null });
    });
    return { connected: true };
  }

  // ---- Ending a connection and choosing bots ----

  /** Forgets the connection here and asks the provider to drop it. */
  async disconnect(caller: Caller, name: string) {
    this.mustKnow(name);
    let revoked = false;
    await this.serial(caller.account, name, async () => {
      await this.requireSignedIn(caller, "Your session ended. Sign in, then disconnect the app.");
      if (name === "telegram") this.telegram.forget(caller.account);
      await this.clearGrants(caller.account, name);
      try {
        const saved = await this.readSaved(caller.account, name);
        revoked = saved === null || (await this.askProviderToRevoke(caller.account, name, saved));
      } catch {
        revoked = false;
      } finally {
        await this.opts.credentials.delete(caller.account, "app", name);
        await this.opts.flows.forget(caller.account, name);
      }
    });
    return { connected: false, providerRevoked: revoked };
  }

  private async askProviderToRevoke(account: string, name: string, saved: SavedToken) {
    const app = OAUTH_APPS[name];
    if (!app?.revoke || !this.configured(name)) return false;
    const reply = await app.revoke(
      {
        fetch: this.fetch,
        client: () => this.serverClient(name),
        fresh: () => this.renewIfDue(account, name, saved),
      },
      saved,
    );
    return reply.ok;
  }

  /** Lets one bot use a connected app, or stops it. */
  async grant(caller: Caller, name: string, botId: string, body: unknown) {
    this.mustKnow(name);
    const fields = body && typeof body === "object" ? Object.keys(body) : [];
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (fields.length !== 1 || typeof enabled !== "boolean") {
      throw new ConnectionError(400, "Send only an enabled field set to true or false");
    }
    await this.serial(caller.account, name, async () => {
      await this.requireSignedIn(caller, "Your session ended. Sign in, then change bot access.");
      const store = await this.opts.storeFor(caller.account);
      const bot = await store.bot(botId);
      if (!bot || bot.temporary) throw new ConnectionError(404, "Unknown bot");
      if (enabled && !(await this.connected(caller.account, name))) {
        throw new ConnectionError(409, `${name} has to be connected before a bot can use it`);
      }
      await store.setPlugin(bot.id, name, enabled);
    });
    return { enabled };
  }

  // ---- Tokens for running tools ----

  /** A runner whose apps use this account's connections. */
  runner(account: string, opts: { fetch?: Fetch } = {}): AppRunner {
    return new AppRunner({
      fetch: opts.fetch ?? this.fetch,
      env: this.env,
      accessToken: (name) => this.token(account, name),
      recoverToken: (name, rejected) => this.token(account, name, rejected),
      available: (name) => this.connected(account, name),
      services: { telegramSend: (text) => this.sendToLinkedChat(account, text) },
    });
  }

  /** The account's current access token for the app; `rejected` forces a renewal. */
  async token(account: string, name: string, rejected?: string): Promise<string> {
    const notConnected = `${name} is not connected. Connect it in Apps.`;
    return this.serial(account, name, async () => {
      if (!(await this.connected(account, name))) throw new AppError(notConnected);
      try {
        const saved = await this.readSaved(account, name);
        if (!saved) throw new AppError(notConnected);
        return (await this.renewIfDue(account, name, saved, rejected === saved.access)).access;
      } catch (error) {
        if (error instanceof AuthorizationExpired) await this.dropExpired(account, name, error);
        throw error;
      }
    });
  }

  private async dropExpired(account: string, name: string, error: AuthorizationExpired) {
    await this.clearGrants(account, name);
    await this.opts.credentials.delete(account, "app", name);
    if (error instanceof ClientExpired) {
      await this.opts.credentials.delete(account, "app-client", name);
    }
  }

  /** Renews the token when it has under half a minute left, or when `force` is set. */
  private async renewIfDue(account: string, name: string, saved: SavedToken, force = false) {
    const due = saved.expires !== null && saved.expires <= this.clock() + RENEW_MARGIN;
    if (!force && !due) return saved;
    if (!saved.refresh) throw new AuthorizationExpired(`${name} needs to be connected again`);
    const perAccount = OAUTH_APPS[name]?.perAccountClient;
    const reply = await this.postToken(
      name,
      { grant_type: "refresh_token", refresh_token: saved.refresh },
      perAccount ? wisprClientFields(String(saved.client_id)) : undefined,
    );
    const renewed = readTokenReply(name, reply, this.clock(), saved);
    if (perAccount) renewed.client_id = saved.client_id as string;
    await this.write(account, name, renewed);
    return renewed;
  }

  /** Posts to the provider's token endpoint and returns the reply, spotting a dead grant. */
  private async postToken(
    name: string,
    fields: Client,
    client: Client = this.serverClient(name),
  ): Promise<Record<string, unknown>> {
    const app = OAUTH_APPS[name] as OAuthApp;
    const reply = await this.fetch(app.tokenUrl, {
      ...tokenRequest(app, client, fields),
      method: "POST",
      signal: AbortSignal.timeout(15000),
    });
    const body = parseJson(await reply.text());
    const fault =
      body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    if (reply.status === 200 || reply.status === 400 || reply.status === 401) {
      if (app.perAccountClient && fault === "invalid_client") {
        throw new ClientExpired("Wispr Flow dropped this server's client. Connect it again.");
      }
      const renewing = fields.grant_type === "refresh_token";
      if (renewing && (fault === "invalid_grant" || fault === "bad_refresh_token")) {
        throw new AuthorizationExpired(`${name} needs to be connected again`);
      }
    }
    if (!reply.ok) throw new HttpError(reply.status);
    if (!body || typeof body !== "object" || fault) {
      throw new AppError(`${name} turned the connection down`);
    }
    return body as Record<string, unknown>;
  }

  // ---- Telegram ----

  /** The account's linked private chat with the current app bot, if any. */
  private async linkedChat(account: string): Promise<number | null> {
    if (this.telegram.botId === null) return null;
    const saved = await this.readSaved<{ chat_id?: unknown; bot_id?: unknown }>(
      account,
      "telegram",
    ).catch(() => null);
    if (saved?.bot_id !== this.telegram.botId) return null;
    const chat = saved.chat_id;
    return Number.isInteger(chat) && (chat as number) > 0 ? (chat as number) : null;
  }

  private telegramUsable(): void {
    if (this.configured("telegram")) return;
    throw new ConnectionError(409, this.telegramError ?? "The server has no Telegram link bot yet");
  }

  private async startTelegramLink(caller: Caller): Promise<string> {
    this.telegramUsable();
    if (!(await this.attempts.attempt(caller.account))) {
      throw new ConnectionError(429, "Too many tries. Wait a few minutes, then try again.");
    }
    if (await this.connected(caller.account, "telegram")) {
      throw new ConnectionError(409, "A Telegram chat is already linked. Disconnect it first.");
    }
    return this.telegram.begin(caller.account).catch(() => {
      throw new ConnectionError(502, "Telegram did not let the link start");
    });
  }

  /** Links the account's chat once its code reached the app bot. */
  async confirmTelegram(caller: Caller): Promise<{ connected: boolean }> {
    this.telegramUsable();
    const link = async (owner: string, chat: number) =>
      this.replace(owner, "telegram", { chat_id: chat, bot_id: this.telegram.botId });
    await this.telegram.confirm(caller.account, link).catch(() => {
      throw new ConnectionError(502, "The Telegram link was not confirmed. Check again.");
    });
    return { connected: await this.connected(caller.account, "telegram") };
  }

  private sendToLinkedChat(account: string, text: string) {
    return this.serial(account, "telegram", async () => {
      const chat = await this.linkedChat(account);
      if (chat === null) throw new AppError("No Telegram chat is linked. Link one in Apps.");
      return this.telegram.send(chat, text);
    });
  }

  // ---- Storage and housekeeping ----

  private mustKnow(name: string): void {
    if (!this.names.includes(name)) throw new ConnectionError(404, "Unknown app");
  }

  private async requireSignedIn(caller: Caller, message: string): Promise<void> {
    if (caller.signedIn && !(await caller.signedIn())) throw new ConnectionError(401, message);
  }

  private callbackFor(name: string): string {
    return `${this.opts.origin}/auth/apps/${name}/callback`;
  }

  private serverClient(name: string): { client_id: string; client_secret: string } {
    const app = OAUTH_APPS[name] as OAuthApp;
    return {
      client_id: String(this.env[app.clientId]),
      client_secret: String(this.env[app.secret]),
    };
  }

  /** The account's own registered client for this callback, registered when there is none. */
  private async accountClient(account: string, callback: string): Promise<string> {
    const raw = await this.opts.credentials.get(account, "app-client", "wispr").catch(() => null);
    const saved = (raw ? parseJson(raw) : null) as { callback?: unknown; client_id?: unknown };
    if (saved?.callback === callback && typeof saved.client_id === "string" && saved.client_id) {
      return saved.client_id;
    }
    const clientId = await registerWisprClient(this.fetch, callback);
    const record = JSON.stringify({ callback, client_id: clientId });
    await this.opts.credentials.put(account, "app-client", "wispr", record);
    return clientId;
  }

  private async readSaved<T = SavedToken>(account: string, name: string): Promise<T | null> {
    let raw: string | null;
    try {
      raw = await this.opts.credentials.get(account, "app", name);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      throw new AppError(`The saved ${name} connection cannot be read. Connect it again.`);
    }
  }

  private write(account: string, name: string, value: unknown): Promise<void> {
    return this.opts.credentials.put(account, "app", name, JSON.stringify(value));
  }

  /** Saves a new connection; bots lose the app until they are granted it again. */
  private async replace(account: string, name: string, value: unknown): Promise<void> {
    await this.clearGrants(account, name);
    await this.write(account, name, value);
  }

  /** Takes the app away from every bot of the account. */
  private async clearGrants(account: string, name: string): Promise<void> {
    const store = await this.opts.storeFor(account);
    await store.ctx.db.run("DELETE FROM bot_plugins WHERE instance=? AND plugin=?", [
      store.ctx.instance,
      name,
    ]);
  }

  /** Runs `work` after earlier work for the same account and app has finished. */
  private serial<T>(account: string, name: string, work: () => Promise<T>): Promise<T> {
    const key = `${account}\u0000${name}`;
    const run = (this.queues.get(key) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => {});
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return run;
  }
}
