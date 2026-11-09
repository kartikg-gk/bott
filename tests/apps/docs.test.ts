import { describe, expect, it } from "vitest";
import { OAUTH_APPS } from "../../src/apps/connections.ts";
import { docs } from "../../src/apps/docs.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { fakeFetch, json } from "../support/fakeFetch.ts";

const API = "https://docs.googleapis.com/v1/documents";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

function account(routes: Parameters<typeof fakeFetch>[0]) {
  const fetcher = fakeFetch(routes);
  const apps = new AppRunner({
    fetch: fetcher,
    env: {},
    accessToken: async () => "docs-token",
    available: async () => true,
  });
  return { fetcher, apps };
}

describe("docs", () => {
  it("is an account app with the Google Docs scope whose every tool asks first", () => {
    expect(APPS.docs).toBe(docs);
    expect(OAUTH_APPS.docs?.scopes).toEqual(["https://www.googleapis.com/auth/documents"]);
    expect(docs.configured({})).toBe(false);
    expect(docs.tools.map((t) => [t.name, t.readOnly, t.review])).toEqual([
      ["docs_create", false, true],
      ["docs_append_text", false, true],
    ]);
  });

  it("creates a document and adds text at the end of it or of one tab", async () => {
    const { fetcher, apps } = account({
      [`POST ${API}`]: (req) => json({ documentId: "d1", title: req.json.title }),
      [`POST ${API}/d%2F1:batchUpdate`]: () => json({ replies: [{}] }),
    });
    expect(parse(await apps.run("docs_create", { title: "Plan" }))).toEqual({
      documentId: "d1",
      title: "Plan",
    });
    const out = parse(await apps.run("docs_append_text", { document_id: "d/1", text: "Hi" }));
    expect(out).toEqual({ documentId: "d/1", appended: true });
    expect(fetcher.seen[1]?.json).toEqual({
      requests: [{ insertText: { endOfSegmentLocation: {}, text: "Hi" } }],
    });
    await apps.run("docs_append_text", { document_id: "d/1", text: "Tab", tab_id: "t.2" });
    expect(fetcher.seen[2]?.json.requests[0].insertText.endOfSegmentLocation).toEqual({
      tabId: "t.2",
    });
    expect(fetcher.seen[2]?.headers.get("authorization")).toBe("Bearer docs-token");
    await expect(apps.run("docs_append_text", { document_id: "..", text: "x" })).rejects.toThrow(
      "Google ID",
    );
  });
});
