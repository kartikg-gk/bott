import { z } from "zod";
import type { App } from "./app.ts";
import { AppError, type Fetch, jsonOutput, request } from "./http.ts";
import { publicUrl } from "./publicUrl.ts";
import { offset, text, tool } from "./schema.ts";

const SEARCH = "https://api.search.tinyfish.ai";
const FETCH = "https://api.fetch.tinyfish.ai";
const AGENT = "https://agent.tinyfish.ai/v1";
/** Characters of a fetched page handed over per call. */
const SLICE = 2200;
const runId = { run_id: text };

const tools = [
  tool(
    "tinyfish_search",
    "Searches the public web and returns one page of links with short excerpts.",
    { query: text, page: z.number().int().min(0).max(10) },
    { optional: ["page"] },
  ),
  tool(
    "tinyfish_fetch",
    "Reads a public web page as Markdown, a slice at a time from offset. Each read may cost " +
      "TinyFish credits.",
    { url: text, offset },
    { optional: ["offset"], write: true, review: true },
  ),
  tool(
    "tinyfish_agent",
    "Starts a browser that works toward a goal on a site and returns its run ID. " +
      "duration_seconds caps how long it runs; what it costs depends on what it does.",
    { url: text, goal: text, duration_seconds: z.number().int().min(30).max(300) },
    { write: true, review: true },
  ),
  tool("tinyfish_get_run", "Where a TinyFish browser run stands, and its result once done.", runId),
  tool("tinyfish_cancel_run", "Stops a TinyFish browser run that has not finished.", runId, {
    write: true,
    review: true,
  }),
];

// biome-ignore lint/suspicious/noExplicitAny: TinyFish replies are loose JSON
type Item = Record<string, any>;

/** Keys for services that hand out their own API keys: printable, without spaces. */
export function providerKeyValid(key: unknown): key is string {
  return typeof key === "string" && /^[\x21-\x7e]{8,512}$/.test(key);
}

/** An ID the service handed back, safe to put in a path. */
export function serviceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new AppError("Use an ID the service gave back");
  }
  return value;
}

/** Proves a key works by listing one browser run. */
export async function checkTinyfishKey(fetcher: Fetch, key: string): Promise<void> {
  const body = await request<Item>(fetcher, "GET", `${AGENT}/runs`, {
    headers: { "x-api-key": key },
    params: { limit: 1 },
    timeoutMs: 15000,
  });
  if (!body || !Array.isArray(body.data)) throw new AppError("TinyFish sent back no run list");
}

const RUN_FIELDS = [
  "run_id",
  "status",
  "result",
  "error",
  "created_at",
  "started_at",
  "finished_at",
];

export const tinyfish: App = {
  name: "tinyfish",
  tools,
  configured: () => false,
  async run(ctx, name, a) {
    const headers = { "x-api-key": await ctx.token() };
    const call = (method: string, url: string, opts: { params?: Item; json?: unknown } = {}) =>
      request<Item>(ctx.fetch, method, url, { headers, ...opts });
    if (name === "tinyfish_search") {
      const data = await call("GET", SEARCH, { params: { query: a.query, page: a.page ?? 0 } });
      const results = Array.isArray(data?.results) ? data.results : [];
      return jsonOutput({
        ...data,
        results: results.map((item: Item) => ({
          ...item,
          snippet: String(item?.snippet ?? "").slice(0, 600),
        })),
      });
    }
    if (name === "tinyfish_fetch") {
      const data = await call("POST", FETCH, {
        json: { urls: [publicUrl(a.url)], format: "markdown" },
      });
      const found = Array.isArray(data?.results) ? data.results[0] : undefined;
      if (!found) throw new AppError("TinyFish sent back no page");
      const body = String(found.text ?? "");
      const start = typeof a.offset === "number" ? a.offset : 0;
      const end = start + SLICE;
      return jsonOutput({
        url: found.url ?? null,
        title: found.title ?? null,
        error: found.error ?? null,
        text: body.slice(start, end),
        nextOffset: end < body.length ? end : null,
      });
    }
    if (name === "tinyfish_agent") {
      const seconds = a.duration_seconds as number;
      if (!Number.isInteger(seconds) || seconds < 30 || seconds > 300) {
        throw new AppError("Give duration_seconds from 30 to 300");
      }
      const data = await call("POST", `${AGENT}/automation/run-async`, {
        json: {
          url: publicUrl(a.url),
          goal: a.goal,
          agent_config: { max_duration_seconds: seconds },
        },
      });
      if (typeof data?.run_id !== "string" || !data.run_id) {
        throw new AppError(
          "TinyFish did not confirm a run; look at its run list before starting another",
        );
      }
      return jsonOutput({ run_id: data.run_id, status: data.status ?? null });
    }
    const url = `${AGENT}/runs/${serviceId(a.run_id)}`;
    if (name === "tinyfish_cancel_run") return jsonOutput(await call("POST", `${url}/cancel`));
    if (name !== "tinyfish_get_run") throw new AppError("Unknown TinyFish tool");
    const data = (await call("GET", url)) ?? {};
    return jsonOutput(
      Object.fromEntries(RUN_FIELDS.filter((f) => f in data).map((f) => [f, data[f]])),
    );
  },
};
