import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import type { FetchFn } from "../agent/providers/types.ts";
import { HttpError, noStoreJson } from "./http.ts";
import { type Account, type AccountStore, FLOW_SECONDS, SESSION_SECONDS } from "./store.ts";

export const LOGIN_COOKIE = "gateway_login";
export const SESSION_COOKIE = "gateway_session";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const KEYS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const CLIENT_ID_VARIABLE = "BOTT_GOOGLE_CLIENT_ID";
export const CLIENT_SECRET_VARIABLE = "BOTT_GOOGLE_CLIENT_SECRET";

const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const REQUIRED_CLAIMS = ["sub", "iss", "aud", "exp", "iat", "nonce", "email"];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TIMEOUT_MS = 10_000;
const TOKEN_LENGTH = 43;

/**
 * The origin Google sends people back to, written one way: HTTPS anywhere, or HTTP on this
 * machine only, with no path, query, fragment or credentials, and the default port left out.
 */
export function canonicalOrigin(value: string | null | undefined): string {
  const refuse = () =>
    new Error("Google sign-in needs an HTTPS origin, or HTTP on a loopback address");
  let parsed: URL;
  try {
    parsed = new URL(value ?? "");
  } catch {
    throw refuse();
  }
  const local = LOOPBACK.has(parsed.hostname);
  const path = (value ?? "").replace(/^[a-z]+:\/\/[^/?#]*/i, "");
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    !["", "/"].includes(path) ||
    parsed.port === "0" ||
    !(parsed.protocol === "https:" || (local && parsed.protocol === "http:"))
  ) {
    throw refuse();
  }
  // URL already lowercases the host, drops the default port and brackets IPv6 addresses.
  return `${parsed.protocol}//${parsed.host}`;
}

/** Whether this origin may serve sign-in from that bind address: plain HTTP stays on loopback. */
export function checkGoogleBind(origin: string, host: string): void {
  if (origin.startsWith("http:") && !["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("Google sign-in over plain HTTP only works when bound to a loopback address");
  }
}

/** The named cookie from a request, or null. */
export function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

const decodeJson = (part: string): Record<string, unknown> => {
  const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Google token");
  }
  return value as Record<string, unknown>;
};

export interface GoogleLoginOptions {
  origin: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** Addresses admitted one by one. */
  emails: string[];
  /** Workspace domains whose verified members are admitted. */
  domains: string[];
  fetch?: FetchFn;
  /** Seconds since the epoch. */
  clock?: () => number;
}

/**
 * Google sign-in with the authorization-code flow: PKCE, a flow bound to the browser that
 * started it, and an ID token whose signature, audience, issuer, expiry and nonce are checked
 * before anyone on the allow list gets a session.
 */
export class GoogleLogin {
  readonly origin: string;
  readonly host: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly emails: Set<string>;
  private readonly domains: Set<string>;
  private readonly fetch: FetchFn;
  private readonly clock: () => number;
  private keys = new Map<string, JsonWebKey>();
  private keysUntil = 0;

  constructor(
    readonly store: AccountStore,
    opts: GoogleLoginOptions,
  ) {
    this.origin = canonicalOrigin(opts.origin);
    this.host = new URL(this.origin).host;
    if (!opts.clientId || !opts.clientSecret) {
      throw new Error(`Set ${CLIENT_ID_VARIABLE} and ${CLIENT_SECRET_VARIABLE}`);
    }
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    const folded = (values: string[]) =>
      new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
    this.emails = folded(opts.emails);
    this.domains = folded(opts.domains);
    if (this.emails.size === 0 && this.domains.size === 0) {
      throw new Error("Set at least one Google address or Workspace domain that may sign in");
    }
    this.fetch = opts.fetch ?? fetch;
    this.clock = opts.clock ?? (() => Date.now() / 1000);
  }

  /** On the allow list by address, or by a Workspace domain that the address belongs to. */
  permitted(email: string, domain: string | null | undefined): boolean {
    const address = email.toLowerCase();
    if (this.emails.has(address)) return true;
    if (typeof domain !== "string") return false;
    const workspace = domain.toLowerCase();
    return this.domains.has(workspace) && address.slice(address.lastIndexOf("@") + 1) === workspace;
  }

  /**
   * Requests must name this host (a trusted proxy may rewrite it), and anything but a plain
   * read must come from this origin.
   */
  requestAllowed(request: Request, opts: { trustedProxy?: boolean } = {}): boolean {
    if (!opts.trustedProxy && (request.headers.get("host") ?? "").toLowerCase() !== this.host) {
      return false;
    }
    const origin = request.headers.get("origin");
    return origin === this.origin || (origin === null && ["GET", "HEAD"].includes(request.method));
  }

  /** The signed-in account behind a session token, while it is still on the allow list. */
  async identity(token: string | null | undefined): Promise<Account | null> {
    const account = await this.store.session(token);
    return account && this.permitted(account.email, account.domain) ? account : null;
  }

  private setCookie(response: Response, name: string, value: string, age: number): void {
    const secure = this.origin.startsWith("https:") ? "; Secure" : "";
    response.headers.append(
      "Set-Cookie",
      `${name}=${value}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Lax${secure}`,
    );
  }

  private dropCookie(response: Response, name: string): void {
    response.headers.append(
      "Set-Cookie",
      `${name}=""; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/`,
    );
  }

  private redirect(location: string): Response {
    return new Response(null, {
      status: 302,
      headers: { Location: location, "Cache-Control": "no-store" },
    });
  }

  /** Sends the browser to Google, remembering the flow against a cookie for this browser. */
  async start(request: Request): Promise<Response> {
    const [state, nonce, verifier] = [0, 1, 2].map(() => randomBytes(32).toString("base64url")) as [
      string,
      string,
      string,
    ];
    let browser = cookie(request, LOGIN_COOKIE) ?? "";
    if (browser.length !== TOKEN_LENGTH) browser = randomBytes(32).toString("base64url");
    try {
      await this.store.startFlow(state, browser, verifier, nonce);
    } catch (error) {
      throw new HttpError(429, (error as Error).message);
    }
    const query = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: `${this.origin}/auth/callback`,
      response_type: "code",
      scope: "openid email",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const response = this.redirect(`${AUTH_URL}?${query}`);
    this.setCookie(response, LOGIN_COOKIE, browser, FLOW_SECONDS);
    return response;
  }

  private async signingKey(kid: string): Promise<JsonWebKey> {
    if (this.clock() >= this.keysUntil || !this.keys.has(kid)) {
      const response = await this.fetch(KEYS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!response.ok) throw new Error("Google keys could not be fetched");
      const body = (await response.json()) as { keys: (JsonWebKey & { kid: string })[] };
      this.keys = new Map(body.keys.map((key) => [key.kid, key]));
      const age = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "");
      this.keysUntil = this.clock() + Math.min(3600, age ? Number(age[1]) : 300);
    }
    const key = this.keys.get(kid);
    if (!key) throw new Error("Unknown Google signing key");
    return key;
  }

  /** The ID token's claims, once every check has passed. */
  async claims(token: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid Google token");
    const [head, body, signature] = parts as [string, string, string];
    const header = decodeJson(head);
    const kid = header.kid;
    if (header.alg !== "RS256" || typeof kid !== "string" || !kid) {
      throw new Error("The Google token header is not valid");
    }
    const key = createPublicKey({ key: await this.signingKey(kid), format: "jwk" });
    if (key.asymmetricKeyType !== "rsa") throw new Error("Google signing key is not RSA");
    const signed = Buffer.from(`${head}.${body}`);
    if (!verify("sha256", signed, key, Buffer.from(signature, "base64url"))) {
      throw new Error("Invalid Google token signature");
    }
    const claims = decodeJson(body);
    for (const name of REQUIRED_CLAIMS) {
      if (!(name in claims)) throw new Error(`Google token has no ${name}`);
    }
    const now = this.clock();
    const { exp, iat, nbf, iss, aud } = claims;
    if (typeof exp !== "number" || exp <= now) throw new Error("Google token has expired");
    if (typeof iat !== "number" || iat > now) throw new Error("Google token is not yet valid");
    if (nbf !== undefined && (typeof nbf !== "number" || nbf > now)) {
      throw new Error("Google token is not yet valid");
    }
    if (typeof iss !== "string" || !ISSUERS.has(iss)) throw new Error("Google token issuer");
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(this.clientId)) throw new Error("Google token audience");
    const actual = claims.nonce;
    if (typeof actual !== "string" || !sameText(actual, nonce)) {
      throw new Error("The Google token was issued for a different sign-in attempt");
    }
    if ((claims.azp ?? this.clientId) !== this.clientId) {
      throw new Error("The Google token was issued to a different client");
    }
    if (Array.isArray(aud) && aud.length > 1 && !("azp" in claims)) {
      throw new Error("The Google token does not name the client it was issued to");
    }
    return claims;
  }

  /** Finishes the sign-in Google sent the browser back from, and starts a session. */
  async callback(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const browser = cookie(request, LOGIN_COOKIE) ?? "";
    const flow =
      state.length === TOKEN_LENGTH && browser.length === TOKEN_LENGTH
        ? await this.store.consumeFlow(state, browser)
        : null;
    if (!flow || !code || code.length > 4096) {
      throw new HttpError(400, "The sign-in timed out or was cancelled. Please begin again.");
    }
    let claims: Record<string, unknown>;
    try {
      const response = await this.fetch(TOKEN_URL, {
        method: "POST",
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: `${this.origin}/auth/callback`,
          code_verifier: flow.verifier,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error("Google refused the code");
      const tokens = (await response.json()) as { id_token?: unknown };
      if (typeof tokens.id_token !== "string") throw new Error("Google sent no ID token");
      claims = await this.claims(tokens.id_token, flow.nonce);
    } catch {
      throw new HttpError(401, "The Google sign-in could not be confirmed");
    }
    const { email, hd: domain, sub: subject } = claims;
    if (
      claims.email_verified !== true ||
      typeof email !== "string" ||
      email.length > 320 ||
      typeof subject !== "string" ||
      subject.length < 1 ||
      subject.length > 255 ||
      (domain !== undefined && domain !== null && typeof domain !== "string") ||
      !this.permitted(email, domain as string | null | undefined)
    ) {
      throw new HttpError(403, "This Google account may not sign in here");
    }
    await this.store.signOut(cookie(request, SESSION_COOKIE));
    const token = await this.store.signIn(subject, email, (domain as string | undefined) ?? null);
    const response = this.redirect("/");
    this.dropCookie(response, LOGIN_COOKIE);
    this.setCookie(response, SESSION_COOKIE, token, SESSION_SECONDS);
    return response;
  }

  /** Ends the browser's session on the server and clears its cookie. */
  async logout(request: Request): Promise<Response> {
    await this.store.signOut(cookie(request, SESSION_COOKIE));
    const response = noStoreJson({ signedOut: true });
    this.dropCookie(response, SESSION_COOKIE);
    return response;
  }
}
