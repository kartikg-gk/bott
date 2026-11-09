/**
 * Composio: one hosted service that signs accounts in to many outside tools. bott uses it only
 * for services it has no integration of its own for, so Gmail, GitHub and the rest stay native.
 *
 * - The server holds one Composio project key (BOTT_COMPOSIO_API_KEY). Without it, nothing here
 *   is offered.
 * - Each bott account is one Composio user, keyed by the account id. Connecting a toolkit opens
 *   Composio's hosted sign-in page; bott keeps only the connected account id, sealed.
 * - A bot is granted one toolkit at a time (`composio:slack`), through the same app loader as
 *   every other app, and loads that toolkit's tools only when it needs them.
 */

import { z } from "zod";
import type { HostTool } from "../agent/session.ts";
import { errorOutput, type ToolOutput } from "../agent/tools.ts";
import type { Store } from "../store/store.ts";
import type { Env } from "./app.ts";
import { type Caller, ConnectionError } from "./connections.ts";
import type { AttemptLimit, CredentialStore } from "./credentials.ts";
import { MemoryAttempts } from "./credentials.ts";
import {
  AppError,
  type Fetch,
  HttpError,
  jsonOutput,
  limited,
  NetworkError,
  request,
} from "./http.ts";

export const COMPOSIO_KEY = "BOTT_COMPOSIO_API_KEY";
export const COMPOSIO_API = "https://backend.composio.dev/api/v3.1";
/** Grant names for Composio toolkits start with this, as in `composio:slack`. */
export const COMPOSIO_GRANT = "composio:";
/** Where the sealed connected account ids are kept, one per toolkit. */
const CREDENTIAL_KIND = "composio";

/** The toolkits offered through Composio, by Composio's slug, with the names people see. */
export const TOOLKITS: Record<string, string> = {
  slack: "Slack",
  outlook: "Outlook",
  microsoft_teams: "Microsoft Teams",
  one_drive: "OneDrive",
  jira: "Jira",
  confluence: "Confluence",
  asana: "Asana",
  trello: "Trello",
  airtable: "Airtable",
  hubspot: "HubSpot",
  dropbox: "Dropbox",
  zoom: "Zoom",
  discord: "Discord",
};

/** Most tools one toolkit hands a bot, so a large toolkit cannot swamp the conversation. */
export const MAX_TOOLS = 60;
const PAGE = 100;
const DESCRIPTION_LIMIT = 1000;

export const composioReady = (env: Env): boolean => Boolean(env[COMPOSIO_KEY]?.trim());
export const grantName = (toolkit: string): string => `${COMPOSIO_GRANT}${toolkit}`;

/** The toolkit a grant name stands for, or undefined when it is not a Composio grant. */
export function toolkitOf(grant: string): string | undefined {
  if (!grant.startsWith(COMPOSIO_GRANT)) return undefined;
  const slug = grant.slice(COMPOSIO_GRANT.length);
  return slug in TOOLKITS ? slug : undefined;
}

/** The toolkit a Composio tool slug belongs to, read from its prefix (`SLACK_...`). */
export function toolkitOfTool(tool: string): string | undefined {
  if (!/^[A-Z][A-Z0-9_]*$/.test(tool)) return undefined;
  let best: string | undefined;
  for (const slug of Object.keys(TOOLKITS)) {
    const prefix = `${slug.toUpperCase()}_`;
    if (tool.startsWith(prefix) && (!best || slug.length > best.length)) best = slug;
  }
  return best;
}

/** One Composio tool as bott sees it. */
export interface ComposioTool {
  slug: string;
  toolkit: string;
  description: string;
  schema: Record<string, unknown>;
  readOnly: boolean;
}

/** A connected account's state on Composio's side. */
export interface RemoteAccount {
  id: string;
  status: string;
  toolkit: string | undefined;
  user: string | undefined;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Talks to Composio's REST API with the server's project key. */
export class ComposioClient {
  constructor(
    private readonly fetcher: Fetch,
    private readonly key: string,
    private readonly base = COMPOSIO_API,
  ) {}

  private call<T>(method: string, path: string, opts: Parameters<typeof request>[3] = {}) {
    return request<T>(this.fetcher, method, `${this.base}${path}`, {
      ...opts,
      headers: { "x-api-key": this.key, accept: "application/json", ...opts.headers },
      timeoutMs: opts.timeoutMs ?? 30000,
    });
  }

  /** Throws unless the key is accepted; the smallest listing Composio has. */
  async check(): Promise<void> {
    await this.call("GET", "/auth_configs", { params: { limit: 1 }, timeoutMs: 10000 });
  }

  /** The id of a Composio-managed sign-in setup for the toolkit, made when there is none. */
  async authConfig(toolkit: string): Promise<string> {
    const listed = await this.call<{ items?: unknown[] }>("GET", "/auth_configs", {
      params: { toolkit_slug: toolkit, is_composio_managed: true, limit: 20 },
    });
    for (const item of listed?.items ?? []) {
      const entry = item as { id?: unknown; status?: unknown; toolkit?: { slug?: unknown } };
      const sameToolkit = entry.toolkit?.slug === undefined || entry.toolkit.slug === toolkit;
      if (text(entry.id) && entry.status !== "DISABLED" && sameToolkit) return text(entry.id);
    }
    const made = await this.call<{ auth_config?: { id?: unknown } }>("POST", "/auth_configs", {
      json: { toolkit: { slug: toolkit }, auth_config: { type: "use_composio_managed_auth" } },
    });
    const id = text(made?.auth_config?.id);
    if (!id) throw new AppError("Composio did not set up sign-in for that toolkit");
    return id;
  }

  /** Starts Composio's hosted sign-in for one user; returns where to send the browser. */
  async link(
    authConfig: string,
    user: string,
    callback: string,
  ): Promise<{ url: string; id: string }> {
    const reply = await this.call<{ redirect_url?: unknown; connected_account_id?: unknown }>(
      "POST",
      "/connected_accounts/link",
      { json: { auth_config_id: authConfig, user_id: user, callback_url: callback } },
    );
    const url = text(reply?.redirect_url);
    const id = text(reply?.connected_account_id);
    if (!url.startsWith("https://") || !id) {
      throw new AppError("Composio did not return a sign-in link");
    }
    return { url, id };
  }

  async account(id: string): Promise<RemoteAccount> {
    const reply = await this.call<{
      id?: unknown;
      status?: unknown;
      user_id?: unknown;
      toolkit?: { slug?: unknown };
    }>("GET", `/connected_accounts/${encodeURIComponent(id)}`);
    return {
      id: text(reply?.id) || id,
      status: text(reply?.status) || "UNKNOWN",
      toolkit: text(reply?.toolkit?.slug) || undefined,
      user: text(reply?.user_id) || undefined,
    };
  }

  async remove(id: string): Promise<void> {
    await this.call("DELETE", `/connected_accounts/${encodeURIComponent(id)}`);
  }

  /**
   * The toolkit's tools, at most `MAX_TOOLS`. The ones Composio marks important come first;
   * when it marks none, the plain listing is used.
   */
  async tools(toolkit: string): Promise<ComposioTool[]> {
    const important = await this.listTools(toolkit, true);
    const all = important.length > 0 ? important : await this.listTools(toolkit, false);
    return all.slice(0, MAX_TOOLS);
  }

  private async listTools(toolkit: string, important: boolean): Promise<ComposioTool[]> {
    const found: ComposioTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call<{ items?: unknown[]; next_cursor?: unknown }>("GET", "/tools", {
        params: {
          toolkit_slug: toolkit,
          limit: PAGE,
          cursor,
          ...(important ? { important: true } : {}),
        },
      });
      for (const item of page?.items ?? []) {
        const tool = readTool(item, toolkit);
        if (tool) found.push(tool);
      }
      cursor = text(page?.next_cursor) || undefined;
    } while (cursor && found.length < MAX_TOOLS);
    return found;
  }

  /** Runs one tool for a user's connected account. */
  async execute(
    tool: string,
    account: string,
    user: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ successful: boolean; data: unknown; error: string }> {
    const fetcher: Fetch = signal
      ? (input, init) =>
          this.fetcher(input, {
            ...init,
            signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
          })
      : this.fetcher;
    const reply = await request<{ successful?: unknown; data?: unknown; error?: unknown }>(
      fetcher,
      "POST",
      `${this.base}/tools/execute/${encodeURIComponent(tool)}`,
      {
        headers: { "x-api-key": this.key, accept: "application/json" },
        json: { connected_account_id: account, user_id: user, arguments: args },
        timeoutMs: 60000,
      },
    );
    return {
      successful: reply?.successful === true,
      data: reply?.data ?? null,
      error: text(reply?.error),
    };
  }
}

/** Composio tags that mark a tool as only reading. Anything else counts as a write. */
const READ_TAGS = new Set(["readOnlyHint", "readonlyhint", "read_only", "readOnly"]);

/** Reads one listed tool; skips entries without a usable slug or schema. */
export function readTool(item: unknown, toolkit: string): ComposioTool | undefined {
  const entry = item as {
    slug?: unknown;
    description?: unknown;
    name?: unknown;
    input_parameters?: unknown;
    tags?: unknown;
    is_deprecated?: unknown;
  };
  const slug = text(entry?.slug);
  if (!/^[A-Z][A-Z0-9_]{1,120}$/.test(slug) || entry.is_deprecated === true) return undefined;
  const schema = entry.input_parameters;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const tags = Array.isArray(entry.tags) ? entry.tags.filter((t) => typeof t === "string") : [];
  const description = (text(entry.description) || text(entry.name) || slug).slice(
    0,
    DESCRIPTION_LIMIT,
  );
  return {
    slug,
    toolkit,
    description,
    schema: schema as Record<string, unknown>,
    readOnly: tags.some((tag) => READ_TAGS.has(tag)),
  };
}

/** A zod schema from Composio's JSON schema; a loose object when it cannot be read. */
export function inputSchema(schema: Record<string, unknown>): z.ZodTypeAny {
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return z.record(z.string(), z.unknown());
  }
}

export function composioHostTool(tool: ComposioTool): HostTool {
  const label = TOOLKITS[tool.toolkit] ?? tool.toolkit;
  return {
    name: tool.slug,
    description: `${label} (through Composio): ${tool.description}`,
    input: inputSchema(tool.schema),
    readOnly: tool.readOnly,
  };
}

/** Apps beyond the built-in registry that a bot may load, such as Composio toolkits. */
export interface ExtraApps {
  /** Whether this grant name is one of these apps. */
  serves(grant: string): boolean;
  /** Of the granted names it serves, those ready for the account. */
  ready(grants: string[]): Promise<string[]>;
  /** The tools of one granted app. Throws with words the bot can read. */
  load(grant: string): Promise<HostTool[]>;
  owns(tool: string): boolean;
  /** Runs a tool when its app is among `grants`. */
  call(grants: string[], tool: string, input: unknown, signal?: AbortSignal): Promise<ToolOutput>;
}

export interface ComposioOptions {
  credentials: CredentialStore;
  /** The bots and grants of the account's instance. */
  storeFor: (account: string) => Promise<Store>;
  /** Where the browser reaches this server; Composio sends people back here after sign-in. */
  origin: string;
  attempts?: AttemptLimit;
  fetch?: Fetch;
  env?: Env;
  clock?: () => number;
  /** Composio's API address; tests point it at a fake. */
  base?: string;
}

/** Composio connections for signed-in accounts, and their bots' grants. */
export class ComposioAccounts {
  private readonly fetcher: Fetch;
  private readonly env: Env;
  private readonly attempts: AttemptLimit;
  /** Tool lists already read, by toolkit; they change rarely and are the same for everyone. */
  private readonly toolCache = new Map<string, ComposioTool[]>();
  /** The toolkit of every tool slug listed so far, for slugs whose prefix does not say. */
  private readonly slugs = new Map<string, string>();

  constructor(private readonly opts: ComposioOptions) {
    this.fetcher = opts.fetch ?? fetch;
    this.env = opts.env ?? process.env;
    const clock = opts.clock ?? (() => Date.now() / 1000);
    this.attempts = opts.attempts ?? new MemoryAttempts(clock);
  }

  get configured(): boolean {
    return composioReady(this.env);
  }

  private client(): ComposioClient {
    if (!this.configured) throw new ConnectionError(404, "Composio is not set up on this server");
    return new ComposioClient(this.fetcher, String(this.env[COMPOSIO_KEY]).trim(), this.opts.base);
  }

  private known(toolkit: string): void {
    if (!(toolkit in TOOLKITS)) throw new ConnectionError(404, "Unknown toolkit");
  }

  /** The saved connected account id for the toolkit, or null. */
  async savedId(account: string, toolkit: string): Promise<string | null> {
    const raw = await this.opts.credentials
      .get(account, CREDENTIAL_KIND, toolkit)
      .catch(() => null);
    if (raw === null) return null;
    try {
      const id = (JSON.parse(raw) as { id?: unknown }).id;
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  }

  /** Every toolkit, whether the account saved a connection for it, and which bots may use it. */
  async list(caller: Caller) {
    if (!this.configured) return { configured: false, toolkits: [] };
    const store = await this.opts.storeFor(caller.account);
    const bots = (await store.bots()).filter((bot) => !bot.temporary);
    const grants = new Map<string, string[]>();
    for (const bot of bots) grants.set(bot.id, await store.pluginsFor(bot.id));
    const toolkits = await Promise.all(
      Object.entries(TOOLKITS).map(async ([id, label]) => ({
        id,
        label,
        saved: (await this.savedId(caller.account, id)) !== null,
        bots: bots.map((bot) => ({
          id: bot.id,
          name: bot.name,
          enabled: grants.get(bot.id)?.includes(grantName(id)) ?? false,
        })),
      })),
    );
    return { configured: true, toolkits };
  }

  /** Starts Composio's hosted sign-in for one toolkit and returns where to send the browser. */
  async connect(
    caller: Caller,
    toolkit: string,
  ): Promise<{ url: string; connectedAccountId: string }> {
    this.known(toolkit);
    const client = this.client();
    await this.requireSignedIn(caller);
    if (!(await this.attempts.attempt(caller.account))) {
      throw new ConnectionError(429, "Too many tries. Wait a few minutes, then try again.");
    }
    const callback = `${this.opts.origin}/?apps=composio&toolkit=${toolkit}`;
    let started: { url: string; id: string };
    try {
      const config = await client.authConfig(toolkit);
      started = await client.link(config, caller.account, callback);
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError(502, `Composio would not start ${TOOLKITS[toolkit]} sign-in`);
    }
    await this.requireSignedIn(caller);
    const previous = await this.savedId(caller.account, toolkit);
    await this.clearGrants(caller.account, toolkit);
    await this.opts.credentials.put(
      caller.account,
      CREDENTIAL_KIND,
      toolkit,
      JSON.stringify({ id: started.id }),
    );
    if (previous && previous !== started.id) await client.remove(previous).catch(() => {});
    return { url: started.url, connectedAccountId: started.id };
  }

  /** Asks Composio how the account's connection for the toolkit stands. */
  async status(caller: Caller, toolkit: string): Promise<{ connected: boolean; status: string }> {
    this.known(toolkit);
    const client = this.client();
    const id = await this.savedId(caller.account, toolkit);
    if (!id) return { connected: false, status: "NONE" };
    let remote: RemoteAccount;
    try {
      remote = await client.account(id);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return { connected: false, status: "NONE" };
      }
      throw new ConnectionError(502, "Composio could not be asked about that connection");
    }
    // A connection that belongs to another user or toolkit is never used here.
    const ours = (remote.user ?? caller.account) === caller.account;
    const right = (remote.toolkit ?? toolkit) === toolkit;
    const status = ours && right ? remote.status : "MISMATCH";
    return { connected: status === "ACTIVE", status };
  }

  /** Forgets the toolkit here and asks Composio to delete the connection. */
  async disconnect(caller: Caller, toolkit: string) {
    this.known(toolkit);
    await this.requireSignedIn(caller);
    const id = await this.savedId(caller.account, toolkit);
    await this.clearGrants(caller.account, toolkit);
    let removed = id === null;
    if (id && this.configured) {
      removed = await this.client()
        .remove(id)
        .then(
          () => true,
          (error) => error instanceof HttpError && error.status === 404,
        );
    }
    await this.opts.credentials.delete(caller.account, CREDENTIAL_KIND, toolkit);
    return { connected: false, providerRevoked: removed };
  }

  /** Lets one bot use a connected toolkit, or stops it. */
  async grant(caller: Caller, toolkit: string, botId: string, body: unknown) {
    this.known(toolkit);
    const fields = body && typeof body === "object" ? Object.keys(body) : [];
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (fields.length !== 1 || typeof enabled !== "boolean") {
      throw new ConnectionError(400, "Send only an enabled field set to true or false");
    }
    await this.requireSignedIn(caller);
    const store = await this.opts.storeFor(caller.account);
    const bot = await store.bot(botId);
    if (!bot || bot.temporary) throw new ConnectionError(404, "Unknown bot");
    if (enabled && !(await this.status(caller, toolkit)).connected) {
      throw new ConnectionError(
        409,
        `${TOOLKITS[toolkit]} has to be connected before a bot can use it`,
      );
    }
    await store.setPlugin(bot.id, grantName(toolkit), enabled);
    return { enabled };
  }

  /** What one account's bots may load and run through Composio. */
  forAccount(account: string): ExtraApps {
    return {
      serves: (grant) => toolkitOf(grant) !== undefined,
      ready: async (grants) => {
        if (!this.configured) return [];
        const names: string[] = [];
        for (const grant of grants) {
          const toolkit = toolkitOf(grant);
          if (toolkit && (await this.savedId(account, toolkit))) names.push(grant);
        }
        return names;
      },
      load: async (grant) => {
        const toolkit = toolkitOf(grant) as string;
        const tools = await this.toolsOf(toolkit).catch(() => {
          throw new AppError(`Composio did not list the ${TOOLKITS[toolkit]} tools. Try later.`);
        });
        return tools.map(composioHostTool);
      },
      owns: (tool) => this.toolkitFor(tool) !== undefined,
      call: (grants, tool, input, signal) => this.run(account, grants, tool, input, signal),
    };
  }

  private toolkitFor(tool: string): string | undefined {
    return this.slugs.get(tool) ?? toolkitOfTool(tool);
  }

  private async toolsOf(toolkit: string): Promise<ComposioTool[]> {
    const cached = this.toolCache.get(toolkit);
    if (cached) return cached;
    const tools = await this.client().tools(toolkit);
    if (tools.length > 0) this.toolCache.set(toolkit, tools);
    for (const tool of tools) this.slugs.set(tool.slug, toolkit);
    return tools;
  }

  private async run(
    account: string,
    grants: string[],
    tool: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolOutput> {
    const toolkit = this.toolkitFor(tool);
    if (!toolkit) return errorOutput("Unknown tool");
    const label = TOOLKITS[toolkit] as string;
    if (!grants.includes(grantName(toolkit))) {
      return errorOutput(`This bot has no grant for ${grantName(toolkit)}.`);
    }
    if (!this.configured) return errorOutput("Composio is not set up on the server.");
    const id = await this.savedId(account, toolkit);
    if (!id) return errorOutput(`${label} is not connected. Connect it in Apps.`);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return errorOutput(`Invalid arguments for ${tool}.`);
    }
    const spec = (await this.toolsOf(toolkit).catch(() => [])).find((t) => t.slug === tool);
    if (spec && !inputSchema(spec.schema).safeParse(input).success) {
      return errorOutput(`Invalid arguments for ${tool}.`);
    }
    try {
      const reply = await this.client().execute(
        tool,
        id,
        account,
        input as Record<string, unknown>,
        signal,
      );
      if (reply.successful) return say(jsonOutput(reply.data));
      const detail = reply.error ? `\n${limited(reply.error.slice(0, 2000))}` : "";
      return errorOutput(`${label} turned the call down.${detail}`);
    } catch (error) {
      if (error instanceof HttpError) return errorOutput(`Composio returned HTTP ${error.status}.`);
      if (error instanceof NetworkError || (error as Error)?.name === "TimeoutError") {
        return errorOutput(
          "Composio did not answer. A change may already have been made, so do not repeat the call.",
        );
      }
      return errorOutput(`${label} could not complete the request.`);
    }
  }

  private async requireSignedIn(caller: Caller): Promise<void> {
    if (caller.signedIn && !(await caller.signedIn())) {
      throw new ConnectionError(401, "Your session ended. Sign in, then try again.");
    }
  }

  /** Takes the toolkit away from every bot of the account. */
  private async clearGrants(account: string, toolkit: string): Promise<void> {
    const store = await this.opts.storeFor(account);
    await store.ctx.db.run("DELETE FROM bot_plugins WHERE instance=? AND plugin=?", [
      store.ctx.instance,
      grantName(toolkit),
    ]);
  }
}

const say = (value: string): ToolOutput => ({ content: [{ type: "text", text: value }] });
