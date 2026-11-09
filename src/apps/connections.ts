import { createHash, randomBytes } from "node:crypto";
import type { Store } from "../store/store.ts";
import type { Env } from "./app.ts";
import type { AttemptLimit, CredentialStore, FlowStore } from "./credentials.ts";
import { MemoryAttempts } from "./credentials.ts";
import { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GOOGLE_TOKEN_URL } from "./gmail.ts";
import { AppError, basic, type Fetch, HttpError } from "./http.ts";
import { AppRunner } from "./registry.ts";

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
class AuthorizationExpired extends AppError {}
/** The registered client is gone too; it is registered afresh on the next connection. */
class ClientExpired extends AuthorizationExpired {}

/** How an app is authorized with OAuth. */
export interface OAuthApp {
  authUrl: string;
  tokenUrl: string;
  /** Environment variables holding the server's client ID and secret. */
  clientId: string;
  secret: string;
  scopes: string[];
}

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const google = (app: string, scopes: string[]): OAuthApp => ({
  authUrl: GOOGLE_AUTH_URL,
  tokenUrl: GOOGLE_TOKEN_URL,
  clientId: `BOTT_${app.toUpperCase()}_CLIENT_ID`,
  secret: `BOTT_${app.toUpperCase()}_CLIENT_SECRET`,
  scopes,
});

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
/** Gmail connections made before label changes existed keep working on renewal. */
const OLDER_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

export const OAUTH_APPS: Record<string, OAuthApp> = {
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    clientId: "BOTT_GITHUB_CLIENT_ID",
    secret: "BOTT_GITHUB_CLIENT_SECRET",
    scopes: [],
  },
  gmail: {
    ...google("gmail", GMAIL_SCOPES),
    clientId: GMAIL_CLIENT_ID,
    secret: GMAIL_CLIENT_SECRET,
  },
  calendar: google("calendar", [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ]),
  drive: google("drive", ["https://www.googleapis.com/auth/drive.readonly"]),
};

/** A saved app token, as it is stored: seconds since the epoch for `expires`. */
export interface SavedToken {
  access: string;
  refresh: string | null;
  expires: number | null;
  client_id?: string;
}

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
  fetch?: Fetch;
  env?: Env;
  /** Seconds since the epoch, as a float. */
  clock?: () => number;
}

const randomToken = () => randomBytes(32).toString("base64url");
const challenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Connects apps to signed-in accounts and hands out their tokens, renewed when due. */
export class AppConnections {
  readonly fetch: Fetch;
  readonly env: Env;
  readonly clock: () => number;
  readonly attempts: AttemptLimit;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(readonly opts: ConnectionsOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.env = opts.env ?? process.env;
    this.clock = opts.clock ?? (() => Date.now() / 1000);
    this.attempts = opts.attempts ?? new MemoryAttempts(this.clock);
  }

  /** The apps an account can connect, in the order people see them. */
  get names(): string[] {
    return Object.keys(OAUTH_APPS);
  }

  configured(name: string): boolean {
    const app = OAUTH_APPS[name];
    return !!app && !!this.env[app.clientId] && !!this.env[app.secret];
  }

  async connected(account: string, name: string): Promise<boolean> {
    if (!this.names.includes(name) || !this.configured(name)) return false;
    try {
      return (await this.opts.credentials.get(account, "app", name)) !== null;
    } catch {
      return true;
    }
  }

  /** Runs `work` alone for this account and app. */
  async locked<T>(account: string, name: string, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([account, name]);
    const before = this.locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => held);
    this.locks.set(key, tail);
    await before;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async credential<T = SavedToken>(account: string, name: string): Promise<T | null> {
    try {
      const raw = await this.opts.credentials.get(account, "app", name);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      throw new AppError(`Reconnect ${name} to restore its credentials`);
    }
  }

  async save(account: string, name: string, value: unknown): Promise<void> {
    await this.opts.credentials.put(account, "app", name, JSON.stringify(value));
  }

  callbackUrl(name: string): string {
    return `${this.opts.origin}/auth/apps/${name}/callback`;
  }

  clientFields(name: string): { client_id: string; client_secret: string } {
    const app = OAUTH_APPS[name] as OAuthApp;
    return {
      client_id: String(this.env[app.clientId]),
      client_secret: String(this.env[app.secret]),
    };
  }

  /** Calls the app's token endpoint and reads its reply, recognising an expired grant. */
  async exchange(name: string, data: Record<string, string>): Promise<Record<string, unknown>> {
    const app = OAUTH_APPS[name] as OAuthApp;
    const reply = await this.fetch(app.tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...this.clientFields(name), ...data }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const text = await reply.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const code =
      body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
    if ([200, 400, 401].includes(reply.status)) {
      if (
        data.grant_type === "refresh_token" &&
        (code === "invalid_grant" || code === "bad_refresh_token")
      ) {
        throw new AuthorizationExpired(`Reconnect ${name} to renew access`);
      }
    }
    if (!reply.ok) throw new HttpError(reply.status);
    if (!body || typeof body !== "object" || code) {
      throw new AppError(`${name} did not authorize this connection`);
    }
    return body as Record<string, unknown>;
  }

  /** Checks a token reply and turns it into what is saved. */
  normalize(name: string, result: Record<string, unknown>, previous?: SavedToken): SavedToken {
    const access = result.access_token;
    const refresh = "refresh_token" in result ? result.refresh_token : (previous?.refresh ?? null);
    if (typeof access !== "string" || !access || /\s/.test(access)) {
      throw new AppError(`${name} did not return an access token`);
    }
    if (refresh !== null && (typeof refresh !== "string" || !refresh)) {
      throw new AppError(`${name} returned an invalid refresh token`);
    }
    const required = OAUTH_APPS[name]?.scopes ?? [];
    if (required.length && result.scope !== undefined && result.scope !== null) {
      const granted = new Set(
        typeof result.scope === "string" ? result.scope.trim().split(/[,\s]+/) : [],
      );
      const older =
        name === "gmail" &&
        previous !== undefined &&
        OLDER_GMAIL_SCOPES.every((s) => granted.has(s));
      if (!required.every((s) => granted.has(s)) && !older) {
        throw new AppError(
          name === "gmail"
            ? "Gmail access needs both mailbox and label permission"
            : `${name} requires its requested permissions`,
        );
      }
    }
    if (required.length && refresh === null) {
      throw new AppError(`${name} did not provide offline authorization. Reconnect.`);
    }
    let expiry = result.expires_in;
    if ((expiry === undefined || expiry === null) && required.length) {
      throw new AppError(`${name} did not report the access token lifetime`);
    }
    if (expiry !== undefined && expiry !== null) {
      expiry = Number(expiry);
      if (!Number.isFinite(expiry) || (expiry as number) <= 0) {
        throw new AppError(`${name} returned an invalid token lifetime`);
      }
    }
    return {
      access,
      refresh: refresh as string | null,
      expires: typeof expiry === "number" ? this.clock() + expiry : null,
    };
  }

  /** Renews the token when it is within 30 seconds of expiring, or when forced. */
  async refresh(account: string, name: string, token: SavedToken, force = false) {
    if (!force && (token.expires === null || token.expires > this.clock() + 30)) return token;
    if (!token.refresh) throw new AuthorizationExpired(`Reconnect ${name} to renew access`);
    const reply = await this.exchange(name, {
      grant_type: "refresh_token",
      refresh_token: token.refresh,
    });
    const updated = this.normalize(name, reply, token);
    await this.save(account, name, updated);
    return updated;
  }

  /** The account's current access token for the app; `rejected` forces a renewal. */
  async token(account: string, name: string, rejected?: string): Promise<string> {
    return this.locked(account, name, async () => {
      if (!(await this.connected(account, name))) {
        throw new AppError(`Connect ${name} in Apps first`);
      }
      try {
        const current = await this.credential(account, name);
        if (!current) throw new AppError(`Connect ${name} in Apps first`);
        return (await this.refresh(account, name, current, rejected === current.access)).access;
      } catch (error) {
        if (error instanceof AuthorizationExpired) {
          await this.clearGrants(account, name);
          await this.opts.credentials.delete(account, "app", name);
          if (error instanceof ClientExpired) {
            await this.opts.credentials.delete(account, "app-client", name);
          }
        }
        throw error;
      }
    });
  }

  /** A runner whose apps use this account's connections. */
  runner(account: string, opts: { fetch?: Fetch } = {}): AppRunner {
    return new AppRunner({
      fetch: opts.fetch ?? this.fetch,
      env: this.env,
      accessToken: (name) => this.token(account, name),
      recoverToken: (name, rejected) => this.token(account, name, rejected),
      available: (name) => this.connected(account, name),
    });
  }

  /** Takes the app away from every bot of the account, as a new connection must be granted anew. */
  async clearGrants(account: string, name: string): Promise<void> {
    const store = await this.opts.storeFor(account);
    await store.ctx.db.run("DELETE FROM bot_plugins WHERE instance=? AND plugin=?", [
      store.ctx.instance,
      name,
    ]);
  }

  private known(name: string): void {
    if (!this.names.includes(name)) throw new ConnectionError(404, "Unknown app");
  }

  private async stillSignedIn(caller: Caller, message: string): Promise<void> {
    if (caller.signedIn && !(await caller.signedIn())) throw new ConnectionError(401, message);
  }

  /** Every app with its state for the account and which bots may use it. */
  async list(caller: Caller) {
    const store = await this.opts.storeFor(caller.account);
    const bots = await store.bots();
    const out = [];
    for (const name of this.names) {
      const saved =
        (await this.opts.credentials.get(caller.account, "app", name).catch(() => "")) !== null;
      const enabled = [];
      for (const bot of bots) {
        enabled.push({
          id: bot.id,
          name: bot.name,
          enabled: (await store.pluginsFor(bot.id)).includes(name),
        });
      }
      out.push({
        id: name,
        configured: this.configured(name),
        connected: await this.connected(caller.account, name),
        saved,
        keyAuth: false,
        bots: enabled,
      });
    }
    return out;
  }

  /** Starts an OAuth connection and returns where to send the browser. */
  async connect(caller: Caller, name: string): Promise<{ url: string }> {
    this.known(name);
    if (!this.configured(name)) {
      throw new ConnectionError(409, `Configure the ${name} OAuth client on the server`);
    }
    const app = OAUTH_APPS[name] as OAuthApp;
    const state = randomToken();
    const verifier = randomToken();
    const callback = this.callbackUrl(name);
    await this.locked(caller.account, name, async () => {
      await this.stillSignedIn(caller, "Your session ended; sign in before connecting an app");
      await this.opts.flows.start(caller.account, name, caller.session, state, verifier);
    });
    const query: Record<string, string> = {
      client_id: String(this.env[app.clientId]),
      redirect_uri: callback,
      response_type: "code",
      state,
      code_challenge_method: "S256",
      code_challenge: challenge(verifier),
    };
    if (app.tokenUrl === GOOGLE_TOKEN_URL) {
      Object.assign(query, {
        scope: [...app.scopes].sort().join(" "),
        access_type: "offline",
        prompt: "consent",
      });
    }
    return { url: `${app.authUrl}?${new URLSearchParams(query)}` };
  }

  /** Finishes a connection from the provider's redirect; returns where to send the browser. */
  async callback(
    caller: Caller,
    name: string,
    query: { state?: string | null; code?: string | null },
  ): Promise<string> {
    this.known(name);
    const state = query.state ?? "";
    const code = query.code ?? "";
    if (state.length !== 43 || !this.configured(name)) {
      throw new ConnectionError(400, "Begin connecting the app again");
    }
    await this.locked(caller.account, name, async () => {
      const verifier = await this.opts.flows.consume(caller.account, name, caller.session, state);
      if (verifier === null || code.length < 1 || code.length > 4096) {
        throw new ConnectionError(400, "The app sign-in timed out or was turned down");
      }
      let token: SavedToken;
      try {
        const reply = await this.exchange(name, {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri: this.callbackUrl(name),
        });
        token = this.normalize(name, reply);
      } catch {
        throw new ConnectionError(502, `Could not connect ${name}. Start a new connection.`);
      }
      await this.stillSignedIn(caller, "Your session ended; sign in before connecting an app");
      await this.clearGrants(caller.account, name);
      await this.save(caller.account, name, token);
    });
    return "/?apps=1";
  }

  /** Asks the provider to drop the grant; true when it confirmed. */
  async revoke(account: string, name: string, token: SavedToken): Promise<boolean> {
    if (!this.configured(name)) return false;
    const app = OAUTH_APPS[name] as OAuthApp;
    let reply: Response;
    if (app.tokenUrl === GOOGLE_TOKEN_URL) {
      reply = await this.fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: token.refresh ?? token.access }).toString(),
      });
    } else {
      const current = await this.refresh(account, name, token);
      const fields = this.clientFields(name);
      reply = await this.fetch(
        `https://api.github.com/applications/${encodeURIComponent(fields.client_id)}/grant`,
        {
          method: "DELETE",
          headers: {
            authorization: basic(fields.client_id, fields.client_secret),
            "content-type": "application/json",
            accept: "application/vnd.github+json",
          },
          body: JSON.stringify({ access_token: current.access }),
        },
      );
    }
    return reply.ok;
  }

  /** Forgets the connection here and asks the provider to drop it. */
  async disconnect(caller: Caller, name: string) {
    this.known(name);
    let revoked = false;
    await this.locked(caller.account, name, async () => {
      await this.stillSignedIn(caller, "Your session ended; sign in before disconnecting an app");
      await this.clearGrants(caller.account, name);
      try {
        const token = await this.credential(caller.account, name);
        revoked = token === null || (await this.revoke(caller.account, name, token));
      } catch {
        revoked = false;
      } finally {
        await this.opts.credentials.delete(caller.account, "app", name);
        await this.opts.flows.forget(caller.account, name);
      }
    });
    return { connected: false, providerRevoked: revoked };
  }

  /** Lets one bot use a connected app, or stops it. */
  async grant(caller: Caller, name: string, botId: string, body: unknown) {
    this.known(name);
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      typeof (body as { enabled?: unknown }).enabled !== "boolean"
    ) {
      throw new ConnectionError(400, "Send enabled as true or false");
    }
    const enabled = (body as { enabled: boolean }).enabled;
    await this.locked(caller.account, name, async () => {
      await this.stillSignedIn(caller, "Your session ended; sign in before changing app access");
      const store = await this.opts.storeFor(caller.account);
      const bot = await store.bot(botId);
      if (!bot || bot.temporary) throw new ConnectionError(404, "Unknown bot");
      if (enabled && !(await this.connected(caller.account, name))) {
        throw new ConnectionError(409, `Connect ${name} before granting bot access`);
      }
      await store.setPlugin(bot.id, name, enabled);
    });
    return { enabled };
  }
}

export { AuthorizationExpired, ClientExpired };
