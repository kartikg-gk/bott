import { describe, expect, it } from "vitest";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { webScrape } from "../../src/apps/webScrape.ts";
import { fakeFetch, status } from "../support/fakeFetch.ts";

const SCRAPER = "GET https://api.scraperapi.com/";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));
const ENV = { BOTT_SCRAPERAPI_API_KEY: "sk" };

describe("page reading", () => {
  it("always asks first and serves only the operator", async () => {
    expect(APPS.web_scrape).toBe(webScrape);
    expect(webScrape.tools[0]).toMatchObject({ readOnly: false, review: true });
    const account = new AppRunner({ env: ENV, accessToken: async () => "t" });
    await expect(account.run("web_scrape", { url: "https://a.example/" })).rejects.toThrow(
      "Server research keys are scoped to the operator instance",
    );
  });

  it("reads a public page a page at a time without following redirects", async () => {
    const fetcher = fakeFetch({ [SCRAPER]: () => new Response("m".repeat(5000)) });
    const apps = new AppRunner({ fetch: fetcher, env: ENV });
    const first = parse(await apps.run("web_scrape", { url: "https://a.example/p" }));
    expect(first).toEqual({ url: "https://a.example/p", text: "m".repeat(2200), nextOffset: 2200 });
    const q = fetcher.seen[0]?.url.searchParams;
    expect(q?.get("url")).toBe("https://a.example/p");
    expect(q?.get("follow_redirect")).toBe("false");
    expect(q?.get("output_format")).toBe("markdown");
    expect(fetcher.seen[0]?.headers.get("x-sapi-api_key")).toBe("sk");
    const last = parse(await apps.run("web_scrape", { url: "https://a.example/p", offset: 4400 }));
    expect(last.text).toHaveLength(600);
    expect(last.nextOffset).toBeNull();
  });

  it("refuses private pages before spending a request", async () => {
    const fetcher = fakeFetch({ [SCRAPER]: () => status(500) });
    const apps = new AppRunner({ fetch: fetcher, env: ENV });
    await expect(apps.run("web_scrape", { url: "http://10.0.0.1/" })).rejects.toThrow(
      "Give a public http or https address",
    );
    expect(fetcher.seen).toHaveLength(0);
    await expect(apps.run("web_scrape", { url: "https://a.example/" })).rejects.toThrow(
      "The page reading service could not get that page",
    );
    await expect(
      apps.run("web_scrape", { url: "https://a.example/", offset: 200000 }),
    ).rejects.toThrow("The offset has to stay under 200000 characters");
  });
});
