import { createHash } from "node:crypto";

/**
 * Where an account's secrets live, sealed to the account, kind and name. The accounts layer
 * supplies the sealed one; `get` throws when a saved value cannot be opened.
 */
export interface CredentialStore {
  get(account: string, kind: string, name: string): Promise<string | null>;
  put(account: string, kind: string, name: string, value: string): Promise<void>;
  delete(account: string, kind: string, name: string): Promise<void>;
}

/** Started app authorizations: each state works once, for the browser session that began it. */
export interface FlowStore {
  start(
    account: string,
    app: string,
    session: string,
    state: string,
    verifier: string,
  ): Promise<void>;
  /** The flow's verifier, removing the flow; null when it is unknown, used or expired. */
  consume(account: string, app: string, session: string, state: string): Promise<string | null>;
  /** Drops every started flow for the app, a held link code among them. */
  forget(account: string, app: string): Promise<void>;
  /** Keeps `code` as the account's one link code for the app, replacing any earlier one. */
  holdCode(account: string, app: string, code: string): Promise<void>;
  /** The account whose unexpired link code for the app this is, if any. */
  codeOwner(app: string, code: string): Promise<string | null>;
  /** Whether the account holds an unexpired link code for the app. */
  codeWaiting(account: string, app: string): Promise<boolean>;
}

/** One-time link codes for an app, one per account, as `TelegramLinks` uses them. */
export interface LinkCodes {
  hold(account: string, code: string): Promise<void>;
  owner(code: string): Promise<string | null>;
  waiting(account: string): Promise<boolean>;
  drop(account: string): Promise<void>;
}

/** The app's link codes, kept wherever the flows are kept. */
export function linkCodes(flows: FlowStore, app: string): LinkCodes {
  return {
    hold: (account, code) => flows.holdCode(account, app, code),
    owner: (code) => flows.codeOwner(app, code),
    waiting: (account) => flows.codeWaiting(account, app),
    drop: (account) => flows.forget(account, app),
  };
}

/** Limits how often an account may ask the server to check a key or start a link. */
export interface AttemptLimit {
  attempt(account: string): Promise<boolean>;
}

export const FLOW_SECONDS = 600;
export const ATTEMPT_SECONDS = 300;
export const ATTEMPT_LIMIT = 5;

export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const wallClock = () => Date.now() / 1000;

export class MemoryCredentials implements CredentialStore {
  readonly values = new Map<string, string>();

  private key(account: string, kind: string, name: string): string {
    return JSON.stringify([account, kind, name]);
  }

  async get(account: string, kind: string, name: string): Promise<string | null> {
    return this.values.get(this.key(account, kind, name)) ?? null;
  }

  async put(account: string, kind: string, name: string, value: string): Promise<void> {
    this.values.set(this.key(account, kind, name), value);
  }

  async delete(account: string, kind: string, name: string): Promise<void> {
    this.values.delete(this.key(account, kind, name));
  }
}

/** Flows kept in memory, holding only digests of the session and state. */
export class MemoryFlows implements FlowStore {
  private readonly flows = new Map<string, { state: string; verifier: string; expires: number }>();
  private readonly codes = new Map<string, { code: string; expires: number }>();

  constructor(private readonly clock: () => number = wallClock) {}

  private key(account: string, app: string, session: string): string {
    return JSON.stringify([account, app, digest(session)]);
  }

  async start(account: string, app: string, session: string, state: string, verifier: string) {
    const now = this.clock();
    for (const [key, flow] of this.flows) if (flow.expires <= now) this.flows.delete(key);
    this.flows.set(this.key(account, app, session), {
      state: digest(state),
      verifier,
      expires: now + FLOW_SECONDS,
    });
  }

  async consume(account: string, app: string, session: string, state: string) {
    const key = this.key(account, app, session);
    const flow = this.flows.get(key);
    if (!flow || flow.state !== digest(state) || flow.expires <= this.clock()) return null;
    this.flows.delete(key);
    return flow.verifier;
  }

  async forget(account: string, app: string) {
    for (const key of [...this.flows.keys()]) {
      const [owner, name] = JSON.parse(key) as string[];
      if (owner === account && name === app) this.flows.delete(key);
    }
    this.codes.delete(JSON.stringify([account, app]));
  }

  async holdCode(account: string, app: string, code: string) {
    const now = this.clock();
    for (const [key, held] of this.codes) if (held.expires <= now) this.codes.delete(key);
    this.codes.set(JSON.stringify([account, app]), {
      code: digest(code),
      expires: now + FLOW_SECONDS,
    });
  }

  async codeOwner(app: string, code: string) {
    const now = this.clock();
    for (const [key, held] of this.codes) {
      const [owner, name] = JSON.parse(key) as string[];
      if (name === app && held.code === digest(code) && held.expires > now) return owner ?? null;
    }
    return null;
  }

  async codeWaiting(account: string, app: string) {
    const held = this.codes.get(JSON.stringify([account, app]));
    return held !== undefined && held.expires > this.clock();
  }
}

export class MemoryAttempts implements AttemptLimit {
  private readonly seen = new Map<string, number[]>();

  constructor(private readonly clock: () => number = wallClock) {}

  async attempt(account: string): Promise<boolean> {
    const now = this.clock();
    const recent = (this.seen.get(account) ?? []).filter((at) => at > now - ATTEMPT_SECONDS);
    if (recent.length >= ATTEMPT_LIMIT) {
      this.seen.set(account, recent);
      return false;
    }
    this.seen.set(account, [...recent, now]);
    return true;
  }
}
