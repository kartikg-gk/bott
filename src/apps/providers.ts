import { createHash } from "node:crypto";
import { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GOOGLE_TOKEN_URL } from "./gmail.ts";
import { basic, type Fetch } from "./http.ts";
import { NOTION_VERSION } from "./notion.ts";
import { TODOIST_MCP_URL, TODOIST_SCOPE } from "./todoist.ts";
import { WISPR_AUTH_URL, WISPR_MCP_URL, WISPR_SCOPES, WISPR_TOKEN_URL } from "./wispr.ts";

/** A saved app token, as it is stored: seconds since the epoch for `expires`. */
export interface SavedToken {
  access: string;
  refresh: string | null;
  expires: number | null;
  client_id?: string;
}

export type Client = Record<string, string>;

/** What a provider may need while it asks for a grant to be dropped. */
export interface RevokeContext {
  fetch: Fetch;
  /** The server's own client ID and secret for this provider. */
  client: () => { client_id: string; client_secret: string };
  /** The saved token, renewed first when it is due. */
  fresh: () => Promise<SavedToken>;
}

/** One OAuth provider: where it lives and the few ways it differs from plain OAuth 2.0. */
export interface OAuthApp {
  authUrl: string;
  tokenUrl: string;
  /** Environment variables holding the server's client ID and secret. */
  clientId: string;
  secret: string;
  scopes: string[];
  /** Query fields added to the sign-in link after the state and the PKCE challenge. */
  extraQuery?: (scopes: string[]) => Record<string, string>;
  /** Uses no PKCE and gets these query fields in place of the challenge. */
  withoutPkce?: Record<string, string>;
  /** Builds the token request; a form post carrying the client is used when left out. */
  tokenRequest?: (client: Client, fields: Client) => RequestInit;
  /** Fields this provider wants on every token request. */
  tokenFields?: Client;
  /** Scopes the provider grants without naming them in `scope`. */
  impliedScopes?: (reply: Record<string, unknown>, refresh: unknown) => string[];
  /** Must hand out a refresh token even though it names no scopes. */
  needsRefresh?: boolean;
  /** Registers a client per account instead of using one from the environment. */
  perAccountClient?: boolean;
  /** Asks the provider to drop the grant. Providers without it are only forgotten here. */
  revoke?: (ctx: RevokeContext, token: SavedToken) => Promise<Response>;
}

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
/** Gmail connections made before label changes existed keep working on renewal. */
export const OLDER_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

const sorted = (scopes: string[], glue: string) => [...scopes].sort().join(glue);

const formPost = (fields: Client, headers: Client = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(fields).toString(),
});

function googleApp(name: string, scopes: string[]): OAuthApp {
  const upper = name.toUpperCase();
  return {
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    clientId: `BOTT_${upper}_CLIENT_ID`,
    secret: `BOTT_${upper}_CLIENT_SECRET`,
    scopes,
    extraQuery: (s) => ({ scope: sorted(s, " "), access_type: "offline", prompt: "consent" }),
    revoke: ({ fetch }, token) =>
      fetch(
        "https://oauth2.googleapis.com/revoke",
        formPost({ token: token.refresh ?? token.access }),
      ),
  };
}

const github: OAuthApp = {
  authUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  clientId: "BOTT_GITHUB_CLIENT_ID",
  secret: "BOTT_GITHUB_CLIENT_SECRET",
  scopes: [],
  async revoke({ fetch, client, fresh }, _token) {
    const current = await fresh();
    const { client_id, client_secret } = client();
    return fetch(`https://api.github.com/applications/${encodeURIComponent(client_id)}/grant`, {
      method: "DELETE",
      headers: {
        authorization: basic(client_id, client_secret),
        "content-type": "application/json",
        accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ access_token: current.access }),
    });
  },
};

const notionJson = (client: Client): Client => ({
  "Notion-Version": NOTION_VERSION,
  authorization: basic(String(client.client_id), String(client.client_secret)),
  "content-type": "application/json",
});

const notion: OAuthApp = {
  authUrl: "https://api.notion.com/v1/oauth/authorize",
  tokenUrl: "https://api.notion.com/v1/oauth/token",
  clientId: "BOTT_NOTION_CLIENT_ID",
  secret: "BOTT_NOTION_CLIENT_SECRET",
  scopes: [],
  withoutPkce: { owner: "user" },
  needsRefresh: true,
  // The client goes in Basic auth and the body is JSON; the PKCE verifier is left out.
  tokenRequest(client, { code_verifier: _unused, ...fields }) {
    return {
      headers: { accept: "application/json", ...notionJson(client) },
      body: JSON.stringify(fields),
    };
  },
  revoke: ({ fetch, client }, token) =>
    fetch("https://api.notion.com/v1/oauth/revoke", {
      method: "POST",
      headers: notionJson(client()),
      body: JSON.stringify({ token: token.access }),
    }),
};

const linear: OAuthApp = {
  authUrl: "https://linear.app/oauth/authorize",
  tokenUrl: "https://api.linear.app/oauth/token",
  clientId: "BOTT_LINEAR_CLIENT_ID",
  secret: "BOTT_LINEAR_CLIENT_SECRET",
  scopes: ["read", "issues:create", "comments:create"],
  extraQuery: (s) => ({ scope: sorted(s, ","), actor: "user" }),
  // Linear may list scopes as an array rather than one string.
  impliedScopes: (reply) =>
    Array.isArray(reply.scope) ? reply.scope.filter((s) => typeof s === "string") : [],
  revoke({ fetch }, token) {
    const kind = token.refresh ? "refresh" : "access";
    return fetch(
      "https://api.linear.app/oauth/revoke",
      formPost({ token: String(token[kind]), token_type_hint: `${kind}_token` }),
    );
  },
};

const todoist: OAuthApp = {
  authUrl: "https://todoist.com/oauth/authorize",
  tokenUrl: "https://todoist.com/oauth/access_token",
  clientId: "BOTT_TODOIST_CLIENT_ID",
  secret: "BOTT_TODOIST_CLIENT_SECRET",
  scopes: [TODOIST_SCOPE],
  extraQuery: () => ({ scope: TODOIST_SCOPE, resource: TODOIST_MCP_URL }),
  tokenFields: { resource: TODOIST_MCP_URL },
  async revoke({ fetch, client, fresh }) {
    const current = await fresh();
    const { client_id, client_secret } = client();
    return fetch(
      "https://todoist.com/api/v1/revoke",
      formPost(
        { token: current.access, token_type_hint: "access_token" },
        { authorization: basic(client_id, client_secret) },
      ),
    );
  },
};

const wispr: OAuthApp = {
  authUrl: WISPR_AUTH_URL,
  tokenUrl: WISPR_TOKEN_URL,
  clientId: "",
  secret: "",
  scopes: WISPR_SCOPES,
  perAccountClient: true,
  extraQuery: (s) => ({ scope: sorted(s, " "), resource: WISPR_MCP_URL, prompt: "consent" }),
  // A refresh token is what offline access means here, whether or not the scope is echoed.
  impliedScopes: (_reply, refresh) => (refresh ? ["offline_access"] : []),
};

export const OAUTH_APPS: Record<string, OAuthApp> = {
  github,
  gmail: {
    ...googleApp("gmail", GMAIL_SCOPES),
    clientId: GMAIL_CLIENT_ID,
    secret: GMAIL_CLIENT_SECRET,
  },
  calendar: googleApp("calendar", [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.events.freebusy",
  ]),
  tasks: googleApp("tasks", ["https://www.googleapis.com/auth/tasks"]),
  drive: googleApp("drive", ["https://www.googleapis.com/auth/drive.readonly"]),
  contacts: googleApp("contacts", ["https://www.googleapis.com/auth/contacts.readonly"]),
  notion,
  linear,
  todoist,
  wispr,
};

/** The fields a per-account Wispr Flow client sends on token requests. */
export const wisprClientFields = (clientId: string): Client => ({
  client_id: clientId,
  resource: WISPR_MCP_URL,
});

/** The sign-in link for a provider, carrying the state and, unless it opts out, PKCE. */
export function signInLink(
  app: OAuthApp,
  fields: { clientId: string; callback: string; state: string; verifier: string },
): string {
  const query: Client = {
    client_id: fields.clientId,
    redirect_uri: fields.callback,
    response_type: "code",
    state: fields.state,
    ...(app.withoutPkce ?? {
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(fields.verifier).digest("base64url"),
    }),
    ...app.extraQuery?.(app.scopes),
  };
  return `${app.authUrl}?${new URLSearchParams(query)}`;
}

/** The body and headers of a token request to this provider. */
export function tokenRequest(app: OAuthApp, client: Client, fields: Client): RequestInit {
  if (app.tokenRequest) return app.tokenRequest(client, fields);
  return {
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...client, ...fields, ...app.tokenFields }).toString(),
  };
}
