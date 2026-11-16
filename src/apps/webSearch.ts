import { type App, envSet } from "./app.ts";
import { AppError, jsonOutput, request } from "./http.ts";
import { publicUrl } from "./publicUrl.ts";
import { text, tool } from "./schema.ts";

export const TAVILY_KEY = "BOTT_TAVILY_API_KEY";
export const EXA_KEY = "BOTT_EXA_API_KEY";
export const OPERATOR_ONLY = "Server research keys are scoped to the operator instance";

// biome-ignore lint/suspicious/noExplicitAny: search replies are loose JSON
type Item = Record<string, any>;

interface Provider {
  name: string;
  key: string;
  url: string;
  headers: (key: string) => Record<string, string>;
  body: (query: string) => Item;
}

const PROVIDERS: Provider[] = [
  {
    name: "Tavily",
    key: TAVILY_KEY,
    url: "https://api.tavily.com/search",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: (query) => ({
      query,
      search_depth: "basic",
      max_results: 5,
      include_published_date: true,
    }),
  },
  {
    name: "Exa",
    key: EXA_KEY,
    url: "https://api.exa.ai/search",
    headers: (key) => ({ "x-api-key": key }),
    body: (query) => ({ query, numResults: 5, contents: { highlights: true } }),
  },
];

/** One result as the bot sees it; results without a public link are dropped. */
function result(item: unknown): Item | null {
  if (!item || typeof item !== "object") return null;
  const found = item as Item;
  let link: string;
  try {
    link = publicUrl(found.url ?? "");
  } catch {
    return null;
  }
  let snippet = found.content || found.text;
  if (!snippet && Array.isArray(found.highlights)) {
    snippet = found.highlights.find((line: unknown) => typeof line === "string") ?? "";
  }
  return {
    url: link,
    title: String(found.title ?? "").slice(0, 200),
    snippet: String(snippet ?? "").slice(0, 600),
    published: String(found.published_date ?? found.publishedDate ?? "").slice(0, 40),
  };
}

export const webSearch: App = {
  name: "web_search",
  tools: [tool("web_search", "Search the open web and get links with short excerpts.", { query: text })],
  configured: (env) => envSet(env, TAVILY_KEY) || envSet(env, EXA_KEY),
  async run(ctx, _name, args) {
    if (ctx.accounts) throw new AppError(OPERATOR_ONLY);
    const query = String(args.query).trim();
    if (!query || query.length > 500) {
      throw new AppError("A search needs 1 to 500 characters");
    }
    const ready = PROVIDERS.filter((p) => envSet(ctx.env, p.key));
    if (ready.length === 0) throw new AppError("Configure a search provider on the server");
    let answered = false;
    for (const provider of ready) {
      let data: Item;
      try {
        data = await request<Item>(ctx.fetch, "POST", provider.url, {
          headers: provider.headers(String(ctx.env[provider.key]).trim()),
          json: provider.body(query),
          timeoutMs: 12000,
        });
      } catch {
        continue;
      }
      if (!data || typeof data !== "object" || !Array.isArray(data.results)) continue;
      answered = true;
      const results = data.results.slice(0, 5).map(result).filter(Boolean);
      if (results.length) return jsonOutput({ provider: provider.name, results });
    }
    if (answered) return jsonOutput({ results: [] });
    throw new AppError("None of the web search services set up could be reached");
  },
};
