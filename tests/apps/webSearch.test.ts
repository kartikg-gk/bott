import { describe, expect, it } from "vitest";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { publicUrl } from "../../src/apps/publicUrl.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { webSearch } from "../../src/apps/webSearch.ts";
import { fakeFetch, json, status } from "../support/fakeFetch.ts";

const TAVILY = "POST https://api.tavily.com/search";
const EXA = "POST https://api.exa.ai/search";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

describe("public URLs", () => {
  it("accept public web hosts", () => {
    for (const url of ["https://example.com/a?b=1", "http://8.8.8.8/", "https://[2606:4700::1]/"]) {
      expect(publicUrl(url)).toBe(url);
    }
  });

  it("refuse local, private and credentialed addresses", () => {
    for (const url of [
      "ftp://example.com/",
      "https://user:pw@example.com/",
      "http://localhost/",
      "http://printer.local/",
      "http://db.internal/",
      "http://127.0.0.1/",
      "http://0x7f.1/",
      "http://2130706433/",
      "http://10.1.2.3/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://intranet/",
      "https://example.com/a b",
      "https://example.com\\@evil.test/",
    ]) {
      expect(() => publicUrl(url), url).toThrow("Give a public http or https address");
    }
  });
});

describe("web search", () => {
  it("is set up by either key and refused for signed-in accounts", async () => {
    expect(APPS.web_search).toBe(webSearch);
    expect(webSearch.configured({})).toBe(false);
    expect(webSearch.configured({ BOTT_EXA_API_KEY: "e" })).toBe(true);
    const account = new AppRunner({ env: { BOTT_EXA_API_KEY: "e" }, accessToken: async () => "t" });
    await expect(account.run("web_search", { query: "x" })).rejects.toThrow(
      "Server research keys are scoped to the operator instance",
    );
  });

  it("uses Tavily first and keeps short, public results", async () => {
    const fetcher = fakeFetch({
      [TAVILY]: () =>
        json({
          results: [
            {
              url: "https://a.example/",
              title: "A",
              content: "x".repeat(700),
              published_date: "d",
            },
            { url: "http://127.0.0.1/secret", title: "local" },
          ],
        }),
    });
    const apps = new AppRunner({
      fetch: fetcher,
      env: { BOTT_TAVILY_API_KEY: "tv", BOTT_EXA_API_KEY: "ex" },
    });
    const out = parse(await apps.run("web_search", { query: " news " }));
    expect(out.provider).toBe("Tavily");
    expect(out.results).toHaveLength(1);
    expect(out.results[0].snippet).toHaveLength(600);
    expect(fetcher.seen[0]?.headers.get("authorization")).toBe("Bearer tv");
    expect(fetcher.seen[0]?.json).toMatchObject({ query: "news", max_results: 5 });
  });

  it("falls back to Exa when Tavily fails", async () => {
    const fetcher = fakeFetch({
      [TAVILY]: () => status(500),
      [EXA]: () =>
        json({
          results: [{ url: "https://b.example/", highlights: [3, "line"], publishedDate: "p" }],
        }),
    });
    const apps = new AppRunner({
      fetch: fetcher,
      env: { BOTT_TAVILY_API_KEY: "tv", BOTT_EXA_API_KEY: "ex" },
    });
    expect(parse(await apps.run("web_search", { query: "x" }))).toEqual({
      provider: "Exa",
      results: [{ url: "https://b.example/", title: "", snippet: "line", published: "p" }],
    });
    expect(fetcher.seen[1]?.headers.get("x-api-key")).toBe("ex");
  });

  it("an empty answer is no results, and no answer is an error", async () => {
    const empty = new AppRunner({
      fetch: fakeFetch({ [EXA]: () => json({ results: [] }) }),
      env: { BOTT_EXA_API_KEY: "ex" },
    });
    expect(parse(await empty.run("web_search", { query: "x" }))).toEqual({ results: [] });
    const down = new AppRunner({ fetch: fakeFetch({}), env: { BOTT_EXA_API_KEY: "ex" } });
    await expect(down.run("web_search", { query: "x" })).rejects.toThrow(
      "None of the web search services set up here answered",
    );
    await expect(down.run("web_search", { query: "q".repeat(501) })).rejects.toThrow(
      "A search needs between 1 and 500 characters of text",
    );
  });
});
