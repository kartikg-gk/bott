import { anthropicProvider } from "../agent/providers/anthropic.ts";
import { openAICompatibleProvider } from "../agent/providers/openai.ts";
import { type RetryOptions, withRetry } from "../agent/providers/retry.ts";
import type { FetchFn, ModelProvider, StreamEvent } from "../agent/providers/types.ts";
import { HttpError } from "./http.ts";
import { SealError } from "./sealing.ts";
import type { AccountStore } from "./store.ts";

/** Where each available provider's API lives, and the cheap call that proves a key works. */
export const PROVIDERS: Record<string, { base: string; check: string }> = {
  openai: { base: "https://api.openai.com/v1", check: "/models" },
  anthropic: { base: "https://api.anthropic.com", check: "/v1/models" },
  openrouter: { base: "https://openrouter.ai/api/v1", check: "/key" },
};

const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/;
const KEY_TEXT = /^[!-~]{1,4096}$/;
const CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY: RetryOptions = { attempts: 3, baseMs: 1000 };

const known = (name: unknown): name is string =>
  typeof name === "string" && Object.hasOwn(PROVIDERS, name);

export interface ModelSettings {
  provider: string | null;
  model: string | null;
  /** Providers with a saved key; the keys themselves never leave the server. */
  keys: string[];
}

export interface AccountModelsOptions {
  fetch?: FetchFn;
  /** True while any of the account's bots is working; credentials stay fixed until it ends. */
  busy?: (account: string) => boolean;
}

/** Each person's model choice and provider keys: checked with the provider, then sealed. */
export class AccountModels {
  private readonly fetch: FetchFn;
  private readonly busy: (account: string) => boolean;

  constructor(
    readonly store: AccountStore,
    opts: AccountModelsOptions = {},
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.busy = opts.busy ?? (() => false);
  }

  async settings(account: string): Promise<ModelSettings> {
    const row = await this.store.account(account);
    return {
      provider: row?.provider ?? null,
      model: row?.model ?? null,
      keys: await this.store.names(account, "model"),
    };
  }

  /** Asks the provider whether the key works, without spending anything. */
  async validate(provider: string, key: string): Promise<void> {
    const { base, check } = PROVIDERS[provider] as { base: string; check: string };
    const headers: Record<string, string> =
      provider === "anthropic"
        ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${key}` };
    let response: Response;
    try {
      response = await this.fetch(base + check, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      await response.body?.cancel();
    } catch {
      throw new HttpError(502, "The provider could not be reached to check this key");
    }
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(400, "The provider turned this key down");
    }
    if (response.status < 200 || response.status > 299) {
      throw new HttpError(502, "The provider was unable to check this key");
    }
  }

  private requireIdle(account: string): void {
    if (this.busy(account)) {
      throw new HttpError(409, "Wait until your bots are idle before changing model keys");
    }
  }

  /**
   * Saves the model choice from a request body, with a new key when one is sent. A new key is
   * checked with the provider first; `stillSignedIn` is asked again afterwards because the
   * session may have ended while the provider answered.
   */
  async save(
    account: string,
    data: unknown,
    stillSignedIn: () => Promise<boolean>,
  ): Promise<ModelSettings> {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new HttpError(400, "Invalid model settings");
    }
    const body = data as Record<string, unknown>;
    if (Object.keys(body).some((field) => !["provider", "model", "key"].includes(field))) {
      throw new HttpError(400, "Invalid model settings");
    }
    const { provider, model, key } = body;
    if (!known(provider) || typeof model !== "string" || !MODEL_ID.test(model)) {
      throw new HttpError(400, "Choose an available provider and a valid model ID");
    }
    const hasKey = Object.hasOwn(body, "key");
    if (hasKey && (typeof key !== "string" || !KEY_TEXT.test(key))) {
      throw new HttpError(400, "A key may only hold visible characters and no spaces");
    }
    this.requireIdle(account);
    if (hasKey) {
      if (!(await this.store.validationAttempt(account))) {
        throw new HttpError(429, "Too many key checks for now; wait five minutes and retry.");
      }
      await this.validate(provider, key as string);
      if (!(await stillSignedIn())) throw new HttpError(401, "Sign in again");
    } else if (!(await this.store.names(account, "model")).includes(provider)) {
      throw new HttpError(400, "Add a key for this provider before choosing it");
    }
    this.requireIdle(account);
    await this.store.setModel(account, provider, model, hasKey ? (key as string) : undefined);
    return this.settings(account);
  }

  async remove(account: string, provider: string): Promise<ModelSettings> {
    if (!known(provider)) throw new HttpError(404, "Unknown provider");
    this.requireIdle(account);
    await this.store.removeModelKey(account, provider);
    return this.settings(account);
  }
}

export interface AccountProviderOptions {
  fetch?: FetchFn;
  /** How failed requests are retried; false sends each request once. */
  retry?: RetryOptions | false;
  /** Wraps the provider a run uses, for example to count it against limits. */
  wrap?: (provider: ModelProvider, name: string) => ModelProvider;
}

export interface AccountModel {
  provider: ModelProvider;
  name: string;
  model: string;
}

/** The provider, named and keyed, that the account's saved choice points at. */
export async function resolveAccountModel(
  store: AccountStore,
  account: string,
  opts: AccountProviderOptions = {},
): Promise<AccountModel> {
  const row = await store.account(account);
  const name = row?.provider;
  const model = row?.model;
  if (!known(name) || !model) {
    throw new Error("Pick a model and add its key under Account settings");
  }
  let key: string | null;
  try {
    key = await store.credential(account, "model", name);
  } catch (error) {
    if (error instanceof SealError) {
      throw new Error("A saved key would not open with the master key of this server");
    }
    throw error;
  }
  if (key === null) throw new Error("No model key is saved for this account yet; add one under Account settings");
  const base = (PROVIDERS[name] as { base: string }).base;
  const raw =
    name === "anthropic"
      ? anthropicProvider({
          apiKey: key,
          baseUrl: base,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        })
      : openAICompatibleProvider({
          apiKey: key,
          baseUrl: base,
          id: name,
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        });
  const retry = opts.retry === undefined ? DEFAULT_RETRY : opts.retry;
  const retried = retry ? withRetry(raw, retry) : raw;
  return { provider: opts.wrap ? opts.wrap(retried, name) : retried, name, model };
}

/**
 * A provider that reads the account's saved model and key at the start of every request, so a
 * changed key or model applies to the next request without rebuilding the session.
 */
export function accountProvider(
  store: AccountStore,
  account: string,
  opts: AccountProviderOptions = {},
): ModelProvider {
  return {
    id: "account",
    async *stream(req): AsyncGenerator<StreamEvent> {
      const chosen = await resolveAccountModel(store, account, opts);
      yield* chosen.provider.stream({ ...req, model: chosen.model });
    },
  };
}
