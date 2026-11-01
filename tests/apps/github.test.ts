import { describe, expect, it } from "vitest";
import { github } from "../../src/apps/github.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { fakeFetch, json } from "../support/fakeFetch.ts";

const API = "https://api.github.com";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

function runner(routes: Parameters<typeof fakeFetch>[0], env = { BOTT_GITHUB_TOKEN: "ghp_x" }) {
  const fetcher = fakeFetch(routes);
  return { fetcher, apps: new AppRunner({ fetch: fetcher, env }) };
}

describe("github", () => {
  it("is registered and set up by the server token", async () => {
    expect(APPS.github).toBe(github);
    expect(await new AppRunner({ env: {} }).configured("github")).toBe(false);
    expect(await new AppRunner({ env: { BOTT_GITHUB_TOKEN: "t" } }).configured("github")).toBe(
      true,
    );
    const writes = github.tools.filter((t) => !t.readOnly).map((t) => [t.name, t.review]);
    expect(writes).toEqual([
      ["github_create_pull_request", true],
      ["github_create_issue", false],
      ["github_comment", false],
    ]);
  });

  it("lists repositories a page at a time with the token", async () => {
    const { fetcher, apps } = runner({
      [`GET ${API}/user/repos`]: () =>
        json([{ full_name: "o/r", description: "d", private: false, html_url: "u", extra: 1 }], {
          headers: { link: `<${API}/user/repos?page=3>; rel="next"` },
        }),
    });
    const out = parse(await apps.run("github_list_repositories", { page: 2 }));
    expect(out).toEqual({
      items: [{ full_name: "o/r", description: "d", private: false, html_url: "u" }],
      nextPage: 3,
    });
    const seen = fetcher.seen[0];
    expect(seen?.headers.get("authorization")).toBe("Bearer ghp_x");
    expect(seen?.url.searchParams.get("per_page")).toBe("10");
    expect(seen?.url.searchParams.get("page")).toBe("2");
  });

  it("shortens long bodies and flattens users and branches", async () => {
    const { apps } = runner({
      [`GET ${API}/repos/o/r/pulls/4`]: () =>
        json({
          number: 4,
          body: "b".repeat(1300),
          head: { ref: "feature", label: "o:feature", sha: "1", repo: {} },
          base: { ref: "main" },
          merged: false,
        }),
      [`GET ${API}/repos/o/r/issues/4/comments`]: () =>
        json([{ id: 1, user: { login: "ana", id: 9 }, body: "hi" }]),
    });
    const pr = parse(await apps.run("github_get_pull_request", { repo: "o/r", number: 4 }));
    expect(pr.body).toHaveLength(1200);
    expect(pr.bodyTruncated).toBe(true);
    expect(pr.head).toEqual({ ref: "feature", label: "o:feature", sha: "1" });
    expect(pr.base).toEqual({ ref: "main", label: null, sha: null });
    const comments = parse(
      await apps.run("github_list_issue_comments", { repo: "o/r", number: 4 }),
    );
    expect(comments).toEqual({ items: [{ id: 1, user: "ana", body: "hi" }], nextPage: null });
  });

  it("pages one file's patch by offset", async () => {
    const patch = "p".repeat(3000);
    const { apps } = runner({
      [`GET ${API}/repos/o/r/pulls/2/files`]: () =>
        json([
          { filename: "a.ts", status: "modified", patch },
          { filename: "b.ts", patch: "x" },
        ]),
    });
    const list = parse(
      await apps.run("github_list_pull_request_files", { repo: "o/r", number: 2 }),
    );
    expect(list.items[0].patch).toHaveLength(900);
    expect(list.items[0].patchTruncated).toBe(true);
    const page = parse(
      await apps.run("github_list_pull_request_files", {
        repo: "o/r",
        number: 2,
        filename: "a.ts",
        offset: 2500,
      }),
    );
    expect(page).toMatchObject({ filename: "a.ts", nextOffset: null });
    expect(page.patch).toHaveLength(500);
    await expect(
      apps.run("github_list_pull_request_files", { repo: "o/r", number: 2, filename: "z" }),
    ).rejects.toThrow("That file is not on this page of the pull request");
  });

  it("reads files raw and writes only what it is asked", async () => {
    const { fetcher, apps } = runner({
      [`GET ${API}/repos/o/r/contents/docs/a%20b.txt`]: () => new Response("file text"),
      [`GET ${API}/repos/o/r/issues`]: () => json([{ number: 1, title: "Bug" }]),
      [`GET ${API}/repos/o/r/issues/1`]: () => json({ title: "Bug", state: "open", body: null }),
      [`POST ${API}/repos/o/r/issues`]: () => json({ number: 7 }),
      [`POST ${API}/repos/o/r/issues/1/comments`]: () => json({ id: 1 }),
      [`POST ${API}/repos/o/r/pulls`]: () =>
        json({ number: 8, html_url: "u", draft: true, title: "t" }),
    });
    expect(
      await apps.run("github_read_file", { repo: "o/r", path: "docs/a b.txt", ref: "dev" }),
    ).toBe(`${UNTRUSTED}file text`);
    expect(fetcher.seen[0]?.headers.get("accept")).toBe("application/vnd.github.raw+json");
    expect(fetcher.seen[0]?.url.searchParams.get("ref")).toBe("dev");
    expect(await apps.run("github_list_issues", { repo: "o/r" })).toBe(`${UNTRUSTED}#1 Bug`);
    expect(await apps.run("github_get_issue", { repo: "o/r", number: 1 })).toBe(
      `${UNTRUSTED}Bug (open)\n`,
    );
    expect(await apps.run("github_create_issue", { repo: "o/r", title: "t", body: "b" })).toBe(
      "Created issue #7.",
    );
    expect(await apps.run("github_comment", { repo: "o/r", number: 1, body: "b" })).toBe(
      "Comment posted.",
    );
    const pr = parse(
      await apps.run("github_create_pull_request", {
        repo: "o/r",
        title: "t",
        head: "f",
        base: "main",
        draft: true,
      }),
    );
    expect(pr).toEqual({ number: 8, html_url: "u", draft: true });
    expect(fetcher.seen.at(-1)?.json).toEqual({ title: "t", head: "f", base: "main", draft: true });
  });

  it("refuses file paths with dot segments", async () => {
    const { fetcher, apps } = runner({});
    for (const path of ["../../user", "docs/../../../user", "./a"]) {
      await expect(apps.run("github_read_file", { repo: "o/r", path })).rejects.toThrow(
        "Use a file path inside the repository",
      );
    }
    expect(fetcher.seen).toHaveLength(0);
  });

  it("refuses repository names that could leave the repository path", async () => {
    const { fetcher, apps } = runner({});
    for (const repo of ["o", "o/r/x", "../r", "o/..", "o/r?x"]) {
      await expect(apps.run("github_get_repository", { repo })).rejects.toThrow(
        "Name the repository as owner/name",
      );
    }
    expect(fetcher.seen).toHaveLength(0);
  });

  it("uses the account's token when signed in", async () => {
    const fetcher = fakeFetch({ [`GET ${API}/repos/o/r`]: () => json({ full_name: "o/r" }) });
    const apps = new AppRunner({
      fetch: fetcher,
      env: { BOTT_GITHUB_TOKEN: "server" },
      accessToken: async (app) => `${app}-account`,
      available: async () => true,
    });
    await apps.run("github_get_repository", { repo: "o/r" });
    expect(fetcher.seen[0]?.headers.get("authorization")).toBe("Bearer github-account");
  });
});
