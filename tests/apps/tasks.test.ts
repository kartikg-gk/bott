import { describe, expect, it } from "vitest";
import { OAUTH_APPS } from "../../src/apps/connections.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { tasks } from "../../src/apps/tasks.ts";
import { fakeFetch, json } from "../support/fakeFetch.ts";

const API = "https://tasks.googleapis.com/tasks/v1";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

function account(routes: Parameters<typeof fakeFetch>[0]) {
  const fetcher = fakeFetch(routes);
  const apps = new AppRunner({
    fetch: fetcher,
    env: {},
    accessToken: async () => "tasks-token",
    available: async () => true,
  });
  return { fetcher, apps };
}

describe("tasks", () => {
  it("is an account app with the Google Tasks scope, and asks before each change", async () => {
    expect(APPS.tasks).toBe(tasks);
    expect(OAUTH_APPS.tasks?.scopes).toEqual(["https://www.googleapis.com/auth/tasks"]);
    expect(OAUTH_APPS.tasks?.clientId).toBe("BOTT_TASKS_CLIENT_ID");
    expect(tasks.configured({})).toBe(false);
    const flags = Object.fromEntries(tasks.tools.map((t) => [t.name, t.review]));
    expect(flags).toEqual({
      tasks_list_lists: false,
      tasks_list: false,
      tasks_create: true,
      tasks_update: true,
    });
  });

  it("lists task lists and the tasks in one, a page at a time", async () => {
    const { fetcher, apps } = account({
      [`GET ${API}/users/@me/lists`]: () => json({ items: [{ id: "L1" }], nextPageToken: "n" }),
      [`GET ${API}/lists/L%2F1/tasks`]: () => json({ items: [{ id: "t1", title: "Buy tea" }] }),
    });
    expect(parse(await apps.run("tasks_list_lists", {}))).toEqual({
      items: [{ id: "L1" }],
      nextPageToken: "n",
    });
    const listed = parse(await apps.run("tasks_list", { list_id: "L/1", show_completed: false }));
    expect(listed).toEqual({ items: [{ id: "t1", title: "Buy tea" }], nextPageToken: null });
    const q = fetcher.seen[1]?.url.searchParams;
    expect(q?.get("showCompleted")).toBe("false");
    expect(q?.get("showHidden")).toBe("false");
    expect(q?.get("maxResults")).toBe("20");
    expect(fetcher.seen[1]?.headers.get("authorization")).toBe("Bearer tasks-token");
    await apps.run("tasks_list", { list_id: "L/1", page_token: "p2" });
    expect(fetcher.seen[2]?.url.searchParams.get("showCompleted")).toBe("true");
    expect(fetcher.seen[2]?.url.searchParams.get("pageToken")).toBe("p2");
  });

  it("creates and changes tasks, with due dates as whole days", async () => {
    const { fetcher, apps } = account({
      [`POST ${API}/lists/L1/tasks`]: (req) => json({ id: "t2", ...req.json }),
      [`PATCH ${API}/lists/L1/tasks/t2`]: (req) => json({ id: "t2", ...req.json }),
    });
    await apps.run("tasks_create", { list_id: "L1", title: "Call", due: "2026-12-01" });
    expect(fetcher.seen[0]?.json).toEqual({ title: "Call", due: "2026-12-01T00:00:00.000Z" });
    await apps.run("tasks_update", { list_id: "L1", task_id: "t2", due: null });
    expect(fetcher.seen[1]?.json).toEqual({ due: null });
    await apps.run("tasks_update", { list_id: "L1", task_id: "t2", status: "needsAction" });
    expect(fetcher.seen[2]?.json).toEqual({ status: "needsAction", completed: null });
    await expect(
      apps.run("tasks_create", { list_id: "L1", title: "x", due: "next week" }),
    ).rejects.toThrow("YYYY-MM-DD");
    await expect(
      apps.run("tasks_create", { list_id: "L1", title: "x", due: "2026-02-30" }),
    ).rejects.toThrow("YYYY-MM-DD");
    await expect(apps.run("tasks_update", { list_id: "L1", task_id: "t2" })).rejects.toThrow(
      "at least one",
    );
    await expect(apps.run("tasks_list", { list_id: ".." })).rejects.toThrow("Google ID");
  });
});
