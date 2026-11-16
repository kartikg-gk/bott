import { type App, envSet } from "./app.ts";
import { AppError, jsonOutput, withParams } from "./http.ts";
import { publicUrl } from "./publicUrl.ts";
import { offset, text, tool } from "./schema.ts";
import { OPERATOR_ONLY } from "./webSearch.ts";

export const SCRAPER_KEY = "BOTT_SCRAPERAPI_API_KEY";
const PAGE = 2200;
const LIMIT = 200_000;
const UNREADABLE = "The page reader could not get that page";

export const webScrape: App = {
  name: "web_scrape",
  tools: [
    tool(
      "web_scrape",
      "Read a public page as Markdown; each read may use page reading credits.",
      { url: text, offset },
      { optional: ["offset"], write: true, review: true },
    ),
  ],
  configured: (env) => envSet(env, SCRAPER_KEY),
  async run(ctx, _name, args) {
    if (ctx.accounts) throw new AppError(OPERATOR_ONLY);
    const url = publicUrl(args.url);
    const key = ctx.env[SCRAPER_KEY]?.trim();
    if (!key) throw new AppError("Configure the page extraction provider on the server");
    const start = (args.offset as number | undefined) ?? 0;
    if (start < 0 || start >= LIMIT) throw new AppError("The page offset has to be below 200000");
    const end = Math.min(start + PAGE, LIMIT);
    let read = "";
    try {
      const reply = await ctx.fetch(
        withParams("https://api.scraperapi.com/", {
          url,
          output_format: "markdown",
          follow_redirect: "false",
        }),
        {
          headers: { "x-sapi-api_key": key },
          redirect: "manual",
          signal: AbortSignal.timeout(25000),
        },
      );
      if (!reply.ok || !reply.body) throw new Error("unreadable");
      const reader = reply.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.slice(0, end + 1 - read.length);
        if (read.length > end) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    } catch {
      throw new AppError(UNREADABLE);
    }
    return jsonOutput({
      url,
      text: read.slice(start, end),
      nextOffset: end < LIMIT && read.length > end ? end : null,
    });
  },
};
