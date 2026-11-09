import { describe, expect, it } from "vitest";
import { OAUTH_APPS } from "../../src/apps/connections.ts";
import { contacts } from "../../src/apps/contacts.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { fakeFetch, json } from "../support/fakeFetch.ts";

const SEARCH = "https://people.googleapis.com/v1/people:searchContacts";

describe("contacts", () => {
  it("warms the index, then searches and keeps the useful values", async () => {
    expect(APPS.contacts).toBe(contacts);
    expect(OAUTH_APPS.contacts?.scopes).toEqual([
      "https://www.googleapis.com/auth/contacts.readonly",
    ]);
    const fetcher = fakeFetch({
      [`GET ${SEARCH}`]: (req) =>
        req.url.searchParams.get("query")
          ? json({
              results: [
                {
                  person: {
                    resourceName: "people/c1",
                    names: [{ displayName: "Ana Ruiz" }, { displayName: "" }],
                    emailAddresses: [{ value: "ana@x.com" }],
                  },
                },
              ],
            })
          : json({}),
    });
    const apps = new AppRunner({
      fetch: fetcher,
      env: {},
      accessToken: async () => "t",
      available: async () => true,
    });
    const out = await apps.run("contacts_search", { query: " ana ", limit: 5 });
    expect(JSON.parse(out.slice(UNTRUSTED.length))).toEqual({
      contacts: [
        {
          id: "people/c1",
          names: ["Ana Ruiz"],
          nicknames: [],
          emailAddresses: ["ana@x.com"],
          phoneNumbers: [],
          organizations: [],
        },
      ],
    });
    expect(fetcher.seen.map((s) => s.url.searchParams.get("query"))).toEqual(["", "ana"]);
    expect(fetcher.seen[1]?.url.searchParams.get("pageSize")).toBe("5");
    expect(fetcher.seen[1]?.url.searchParams.get("sources")).toBe("READ_SOURCE_TYPE_CONTACT");
    await expect(apps.run("contacts_search", { query: "  " })).rejects.toThrow(
      "Say who to look for",
    );
  });
});
