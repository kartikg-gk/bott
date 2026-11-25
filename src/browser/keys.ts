import { HttpError } from "../accounts/http.ts";
import { SealError } from "../accounts/sealing.ts";
import type { AccountStore } from "../accounts/store.ts";
import { API_BASE, type BrowserKey } from "./page.ts";

/** Where the key is sealed in `credentials`. */
const KIND = "browser";
const NAME = "cloudflare";

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[!-~]{20,512}$/;
const CHECK_TIMEOUT_MS = 10_000;

export interface BrowserKeySettings {
  /** Whether a key is saved; the token itself never leaves the server. */
  saved: boolean;
  /** The Cloudflare account the browsers run on, when a key is saved. */
  accountId: string | null;
}

export interface BrowserKeysOptions {
  fetch?: typeof fetch;
}

/** Each account's Cloudflare Browser Run key: checked with Cloudflare, then sealed. */
export class BrowserKeys {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly store: AccountStore,
    opts: BrowserKeysOptions = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
  }

  /** The saved key, or null when there is none or it no longer opens. */
  async load(account: string): Promise<BrowserKey | null> {
    let raw: string | null;
    try {
      raw = await this.store.credential(account, KIND, NAME);
    } catch (error) {
      if (error instanceof SealError) return null;
      throw error;
    }
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<BrowserKey>;
      if (typeof parsed.accountId !== "string" || typeof parsed.token !== "string") return null;
      return { accountId: parsed.accountId, token: parsed.token };
    } catch {
      return null;
    }
  }

  async settings(account: string): Promise<BrowserKeySettings> {
    const key = await this.load(account);
    return { saved: key !== null, accountId: key?.accountId ?? null };
  }

  /**
   * Asks Cloudflare whether the token may use Browser Run on that account. Listing the
   * account's browser sessions starts nothing and costs nothing.
   */
  async check(key: BrowserKey): Promise<void> {
    const url = `${API_BASE}/accounts/${key.accountId}/browser-run/devtools/session`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { authorization: `Bearer ${key.token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      await response.body?.cancel();
    } catch {
      throw new HttpError(502, "Cloudflare could not be reached to check this token");
    }
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(400, "Cloudflare turned this token down for Browser Run on that account");
    }
    if (response.status === 404) {
      throw new HttpError(400, "Cloudflare does not know that account ID");
    }
    if (response.status < 200 || response.status > 299) {
      throw new HttpError(502, "Cloudflare was unable to check this token");
    }
  }

  /**
   * Saves `{ accountId, token }` from a request body once Cloudflare accepts it.
   * `stillSignedIn` is asked again afterwards, since the session may have ended meanwhile.
   */
  async save(
    account: string,
    data: unknown,
    stillSignedIn: () => Promise<boolean>,
  ): Promise<BrowserKeySettings> {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new HttpError(400, "Send an account ID and a token");
    }
    const body = data as Record<string, unknown>;
    if (Object.keys(body).some((field) => field !== "accountId" && field !== "token")) {
      throw new HttpError(400, "Send only an account ID and a token");
    }
    const { accountId, token } = body;
    if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) {
      throw new HttpError(400, "A Cloudflare account ID is 32 lowercase hex characters");
    }
    if (typeof token !== "string" || !TOKEN.test(token)) {
      throw new HttpError(400, "The token must be 20 to 512 visible characters with no spaces");
    }
    if (!(await this.store.validationAttempt(account))) {
      throw new HttpError(429, "Too many key checks for now; wait five minutes and retry.");
    }
    const key = { accountId, token };
    await this.check(key);
    if (!(await stillSignedIn())) throw new HttpError(401, "Sign in again");
    await this.store.putCredential(account, KIND, NAME, JSON.stringify(key));
    return { saved: true, accountId };
  }

  async remove(account: string): Promise<BrowserKeySettings> {
    await this.store.deleteCredential(account, KIND, NAME);
    return { saved: false, accountId: null };
  }
}
