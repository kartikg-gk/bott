import { z } from "zod";
import type { App } from "./app.ts";
import { googleApi } from "./google.ts";
import { AppError, jsonOutput } from "./http.ts";
import { text, tool } from "./schema.ts";

const SEARCH = "https://people.googleapis.com/v1/people:searchContacts";
/** Each field the search returns, and the value kept from each entry. */
const FIELDS: Record<string, string> = {
  names: "displayName",
  nicknames: "value",
  emailAddresses: "value",
  phoneNumbers: "value",
  organizations: "name",
};

// biome-ignore lint/suspicious/noExplicitAny: People replies are loose JSON
type Item = Record<string, any>;

export const contacts: App = {
  name: "contacts",
  tools: [
    tool(
      "contacts_search",
      "Look up Google contacts by name, email, phone or organization.",
      { query: text, limit: z.number().int().min(1).max(30) },
      { optional: ["limit"] },
    ),
  ],
  configured: () => false,
  async run(ctx, _name, args) {
    const query = String(args.query).trim();
    if (!query) throw new AppError("Give some text to search contacts for");
    const api = googleApi(ctx.fetch, await ctx.token());
    const params = { readMask: Object.keys(FIELDS).join(","), sources: "READ_SOURCE_TYPE_CONTACT" };
    // An empty search first warms the contact index, as the People API asks.
    await api.get(SEARCH, { ...params, query: "", pageSize: 1 });
    const result = await api.get<Item>(SEARCH, {
      ...params,
      query,
      pageSize: Number(args.limit ?? 10),
    });
    const found = (result?.results ?? []).map((item: Item) => {
      const person: Item = item.person ?? {};
      const record: Item = { id: person.resourceName ?? null };
      for (const [field, key] of Object.entries(FIELDS)) {
        record[field] = (person[field] ?? [])
          .map((entry: Item) => entry[key])
          .filter((value: unknown) => value);
      }
      return record;
    });
    return jsonOutput({ contacts: found });
  },
};
