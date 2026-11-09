import { describe, expect, it } from "vitest";
import { AppConnections } from "../../src/apps/connections.ts";
import { MemoryCredentials, MemoryFlows } from "../../src/apps/credentials.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { linear } from "../../src/apps/linear.ts";
import { notion, notionId } from "../../src/apps/notion.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { Store } from "../../src/store/store.ts";
import { database } from "../support/fakeD1.ts";
import { fakeFetch, json, status } from "../support/fakeFetch.ts";

const NOTION = "https://api.notion.com/v1";
const LINEAR = "https://api.linear.app/graphql";
const PAGE = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

function account(routes: Parameters<typeof fakeFetch>[0]) {
  const fetcher = fakeFetch(routes);
  const apps = new AppRunner({
    fetch: fetcher,
    env: {},
    accessToken: async () => "tok",
    recoverToken: async () => "renewed",
    available: async () => true,
  });
  return { fetcher, apps };
}

describe("notion", () => {
  it("accepts only Notion IDs and writes them dashed", () => {
    expect(APPS.notion).toBe(notion);
    expect(notionId(PAGE.replaceAll("-", "").toUpperCase())).toBe(PAGE);
    expect(notionId(`{${PAGE}}`)).toBe(PAGE);
    expect(() => notionId("../pages")).toThrow("Use an ID that a search");
    expect(notion.tools.filter((t) => !t.readOnly).every((t) => t.review)).toBe(true);
  });

  it("searches and lists blocks as short summaries", async () => {
    const { fetcher, apps } = account({
      [`POST ${NOTION}/search`]: () =>
        json({
          results: [
            {
              id: PAGE,
              object: "page",
              url: "u",
              properties: { Name: { type: "title", title: [{ plain_text: "Plan" }] } },
            },
          ],
          next_cursor: "c2",
        }),
      [`GET ${NOTION}/blocks/${PAGE}/children`]: () =>
        json({
          results: [
            {
              id: "b1",
              type: "paragraph",
              has_children: false,
              paragraph: { rich_text: [{ plain_text: "x".repeat(1300) }] },
            },
          ],
        }),
    });
    expect(parse(await apps.run("notion_search", { query: "plan", cursor: "c1" }))).toEqual({
      items: [{ id: PAGE, type: "page", title: "Plan", url: "u", parent: null }],
      nextCursor: "c2",
    });
    expect(fetcher.seen[0]?.json).toEqual({ page_size: 10, start_cursor: "c1", query: "plan" });
    expect(fetcher.seen[0]?.headers.get("notion-version")).toBe("2026-03-11");
    const blocks = parse(await apps.run("notion_list_blocks", { block_id: PAGE }));
    expect(blocks.items[0].rich_text).toHaveLength(1200);
    expect(blocks.items[0].textTruncated).toBe(true);
  });

  it("creates a page in a data source under its title property", async () => {
    const { fetcher, apps } = account({
      [`GET ${NOTION}/data_sources/${PAGE}`]: () =>
        json({ properties: { Task: { type: "title" }, Due: { type: "date" } } }),
      [`POST ${NOTION}/pages`]: () => json({ id: PAGE, object: "page", title: [] }),
    });
    await apps.run("notion_create_page", {
      parent_id: PAGE,
      parent_type: "data_source",
      title: "New",
      text: "Body",
    });
    expect(fetcher.seen.at(-1)?.json).toEqual({
      parent: { type: "data_source_id", data_source_id: PAGE },
      properties: { Task: { type: "title", title: [{ type: "text", text: { content: "New" } }] } },
      children: [
        {
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "Body" } }] },
        },
      ],
    });
  });

  it("retries once with a renewed token when Notion refuses the token", async () => {
    const { fetcher, apps } = account({
      [`GET ${NOTION}/pages/${PAGE}`]: (req) =>
        req.headers.get("authorization") === "Bearer renewed" ? json({ id: PAGE }) : status(401),
    });
    expect(parse(await apps.run("notion_get_page", { page_id: PAGE }))).toEqual({ id: PAGE });
    expect(fetcher.seen).toHaveLength(2);
  });
});

describe("linear", () => {
  it("reads through GraphQL with team filters", async () => {
    expect(APPS.linear).toBe(linear);
    const { fetcher, apps } = account({
      [`POST ${LINEAR}`]: () =>
        json({
          data: { searchIssues: { nodes: [{ id: "i1" }], pageInfo: { hasNextPage: false } } },
        }),
    });
    const out = parse(await apps.run("linear_search_issues", { query: "bug", team_id: "t1" }));
    expect(out.nodes).toEqual([{ id: "i1" }]);
    expect(fetcher.seen[0]?.json.variables).toEqual({
      after: null,
      filter: { team: { id: { eq: "t1" } } },
      term: "bug",
    });
  });

  it("writes only what is given and refuses unconfirmed writes", async () => {
    let success = true;
    const { fetcher, apps } = account({
      [`POST ${LINEAR}`]: () =>
        json({ data: { issueCreate: { success, issue: { id: "i9", identifier: "ENG-9" } } } }),
    });
    expect(
      parse(await apps.run("linear_create_issue", { team_id: "t1", title: "Bug", priority: 2 })),
    ).toEqual({ id: "i9", identifier: "ENG-9" });
    expect(fetcher.seen[0]?.json.variables).toEqual({
      input: { title: "Bug", priority: 2, teamId: "t1" },
    });
    success = false;
    await expect(apps.run("linear_create_issue", { team_id: "t1", title: "Bug" })).rejects.toThrow(
      "Linear did not say the change was saved. Look at the issue before trying again.",
    );
    await expect(apps.run("linear_update_issue", { issue_id: "i9" })).rejects.toThrow(
      "Name at least one issue field to set",
    );
  });

  it("treats GraphQL errors as an incomplete result", async () => {
    const { apps } = account({
      [`POST ${LINEAR}`]: () => json({ errors: [{ message: "x" }], data: null }),
    });
    await expect(apps.run("linear_get_issue", { issue_id: "ENG-1" })).rejects.toThrow(
      "answer was missing data",
    );
  });
});

describe("workspace connections", () => {
  async function setup(routes: Parameters<typeof fakeFetch>[0]) {
    const { db } = database("sqlite");
    const store = await Store.open(db, "main");
    const fetcher = fakeFetch(routes);
    const credentials = new MemoryCredentials();
    const connections = new AppConnections({
      credentials,
      flows: new MemoryFlows(),
      storeFor: async () => store,
      origin: "https://bott.test",
      fetch: fetcher,
      env: {
        BOTT_NOTION_CLIENT_ID: "n-id",
        BOTT_NOTION_CLIENT_SECRET: "n-secret",
        BOTT_LINEAR_CLIENT_ID: "l-id",
        BOTT_LINEAR_CLIENT_SECRET: "l-secret",
      },
    });
    return { db, fetcher, credentials, connections };
  }
  const caller = { account: "a", session: "s" };

  it("Notion connects without PKCE, with JSON and Basic auth, and needs a refresh token", async () => {
    let refresh: string | undefined = "nr";
    const { db, fetcher, connections } = await setup({
      "POST https://api.notion.com/v1/oauth/token": () =>
        json({ access_token: "ntn_1", ...(refresh ? { refresh_token: refresh } : {}) }),
      "POST https://api.notion.com/v1/oauth/revoke": () => json({}),
    });
    const url = new URL((await connections.connect(caller, "notion")).url);
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.has("code_challenge")).toBe(false);
    await connections.callback(caller, "notion", {
      state: url.searchParams.get("state"),
      code: "c",
    });
    const exchange = fetcher.seen.at(-1);
    expect(exchange?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("n-id:n-secret").toString("base64")}`,
    );
    expect(exchange?.json).toEqual({
      grant_type: "authorization_code",
      code: "c",
      redirect_uri: "https://bott.test/auth/apps/notion/callback",
    });
    expect(await connections.disconnect(caller, "notion")).toEqual({
      connected: false,
      providerRevoked: true,
    });
    expect(fetcher.seen.at(-1)?.json).toEqual({ token: "ntn_1" });

    refresh = undefined;
    const again = new URL((await connections.connect(caller, "notion")).url);
    await expect(
      connections.callback(caller, "notion", { state: again.searchParams.get("state"), code: "c" }),
    ).rejects.toMatchObject({ status: 502 });
    await db.close();
  });

  it("Linear asks for its scopes as a comma list and accepts them back as a list", async () => {
    const { db, credentials, fetcher, connections } = await setup({
      "POST https://api.linear.app/oauth/token": () =>
        json({
          access_token: "lin_1",
          refresh_token: "lr",
          expires_in: 3600,
          scope: ["read", "issues:create", "comments:create"],
        }),
      "POST https://api.linear.app/oauth/revoke": () => json({}),
    });
    const url = new URL((await connections.connect(caller, "linear")).url);
    expect(url.searchParams.get("scope")).toBe("comments:create,issues:create,read");
    expect(url.searchParams.get("actor")).toBe("user");
    await connections.callback(caller, "linear", {
      state: url.searchParams.get("state"),
      code: "c",
    });
    expect(JSON.parse((await credentials.get("a", "app", "linear")) as string).refresh).toBe("lr");
    await connections.disconnect(caller, "linear");
    expect(fetcher.seen.at(-1)?.form.get("token")).toBe("lr");
    expect(fetcher.seen.at(-1)?.form.get("token_type_hint")).toBe("refresh_token");
    await db.close();
  });
});
