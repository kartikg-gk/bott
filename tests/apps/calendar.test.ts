import { describe, expect, it } from "vitest";
import { calendar } from "../../src/apps/calendar.ts";
import { OAUTH_APPS } from "../../src/apps/connections.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { fakeFetch, json } from "../support/fakeFetch.ts";

const API = "https://www.googleapis.com/calendar/v3";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

function account(routes: Parameters<typeof fakeFetch>[0]) {
  const fetcher = fakeFetch(routes);
  const apps = new AppRunner({
    fetch: fetcher,
    env: {},
    accessToken: async () => "cal-token",
    available: async () => true,
  });
  return { fetcher, apps };
}

describe("calendar", () => {
  it("is an account app with offline Google scopes", async () => {
    expect(APPS.calendar).toBe(calendar);
    expect(OAUTH_APPS.calendar?.scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
    ]);
    expect(calendar.configured({})).toBe(false);
    await expect(new AppRunner({ env: {} }).run("calendar_list_calendars", {})).rejects.toThrow(
      "Connect calendar from a signed-in account",
    );
    const writes = calendar.tools.filter((t) => !t.readOnly).map((t) => t.review);
    expect(writes).toEqual([true, true, true, true]);
  });

  it("lists events in a window with explicit offsets", async () => {
    const { fetcher, apps } = account({
      [`GET ${API}/calendars/team%40x.com/events`]: () =>
        json({ items: [{ id: "e1" }], nextPageToken: "p2" }),
    });
    const out = parse(
      await apps.run("calendar_list_events", {
        calendar_id: "team@x.com",
        start: "2026-11-02T09:00:00+05:30",
        end: "2026-11-02T18:00:00+05:30",
        page_token: "p1",
      }),
    );
    expect(out).toEqual({ items: [{ id: "e1" }], nextPageToken: "p2" });
    const q = fetcher.seen[0]?.url.searchParams;
    expect(q?.get("timeMin")).toBe("2026-11-02T09:00:00+05:30");
    expect(q?.get("singleEvents")).toBe("true");
    expect(q?.get("pageToken")).toBe("p1");
    expect(q?.get("maxResults")).toBe("20");
    expect(fetcher.seen[0]?.headers.get("authorization")).toBe("Bearer cal-token");
    await expect(
      apps.run("calendar_list_events", { start: "2026-11-02", end: "2026-11-03T00:00:00Z" }),
    ).rejects.toThrow("Give an RFC 3339 time that includes its offset");
    await expect(
      apps.run("calendar_list_events", {
        start: "2026-11-02T10:00:00Z",
        end: "2026-11-02T09:00:00Z",
      }),
    ).rejects.toThrow("The end has to come after the start");
  });

  it("finds common free time across calendars", async () => {
    const { fetcher, apps } = account({
      [`POST ${API}/freeBusy`]: () =>
        json({
          calendars: {
            a: { busy: [{ start: "2026-11-02T10:00:00Z", end: "2026-11-02T11:00:00Z" }] },
            b: { busy: [{ start: "2026-11-02T10:30:00Z", end: "2026-11-02T12:00:00Z" }] },
          },
        }),
    });
    const out = parse(
      await apps.run("calendar_find_free_time", {
        calendar_ids: ["a", "b", "a"],
        start: "2026-11-02T09:00:00Z",
        end: "2026-11-02T12:20:00Z",
      }),
    );
    expect(out).toEqual({
      intervals: [{ start: "2026-11-02T09:00:00+00:00", end: "2026-11-02T10:00:00+00:00" }],
    });
    expect(fetcher.seen[0]?.json.items).toEqual([{ id: "a" }, { id: "b" }]);
    await expect(
      apps.run("calendar_find_free_time", {
        calendar_ids: ["a"],
        start: "2026-11-01T00:00:00Z",
        end: "2026-12-05T00:00:00Z",
      }),
    ).rejects.toThrow("Ask about 1 to 50 calendars over at most 31 days");
  });

  it("refuses free time it could not verify for every calendar", async () => {
    const { apps } = account({
      [`POST ${API}/freeBusy`]: () =>
        json({ calendars: { a: { busy: [] }, b: { errors: [{ reason: "notFound" }] } } }),
    });
    await expect(
      apps.run("calendar_find_free_time", {
        calendar_ids: ["a", "b"],
        start: "2026-11-02T09:00:00Z",
        end: "2026-11-02T10:00:00Z",
      }),
    ).rejects.toThrow("Free time could not be confirmed for each calendar asked about");
  });

  it("creates, updates, answers and deletes events with a guest notice", async () => {
    const { fetcher, apps } = account({
      [`POST ${API}/calendars/primary/events`]: () => json({ id: "e1" }),
      [`PATCH ${API}/calendars/primary/events/e1`]: () => json({ id: "e1" }),
      [`GET ${API}/calendars/primary/events/e1`]: () =>
        json({ etag: '"7"', attendees: [{ email: "me@x.com", self: true }, { email: "o@x.com" }] }),
      [`DELETE ${API}/calendars/primary/events/e1`]: () => new Response(null, { status: 204 }),
    });
    await apps.run("calendar_create_event", {
      title: "Plan",
      start: "2026-11-02",
      end: "2026-11-03",
      attendees: ["o@x.com"],
      notify: "none",
    });
    const created = fetcher.seen.at(-1);
    expect(created?.json).toEqual({
      summary: "Plan",
      start: { date: "2026-11-02" },
      end: { date: "2026-11-03" },
      attendees: [{ email: "o@x.com" }],
    });
    expect(created?.url.searchParams.get("sendUpdates")).toBe("none");
    await expect(
      apps.run("calendar_create_event", {
        title: "x",
        start: "2026-11-02",
        end: "2026-11-02T10:00:00Z",
        notify: "all",
      }),
    ).rejects.toThrow("Start and end must both be whole days or both be times");
    await expect(
      apps.run("calendar_update_event", { event_id: "e1", notify: "all" }),
    ).rejects.toThrow("Give at least one event field to change");

    await apps.run("calendar_respond_to_event", {
      event_id: "e1",
      response: "accepted",
      notify: "all",
    });
    const answered = fetcher.seen.at(-1);
    expect(answered?.headers.get("if-match")).toBe('"7"');
    expect(answered?.json).toEqual({
      attendeesOmitted: true,
      attendees: [{ email: "me@x.com", responseStatus: "accepted" }],
    });
    expect(
      parse(await apps.run("calendar_delete_event", { event_id: "e1", notify: "externalOnly" })),
    ).toEqual({ deleted: true, id: "e1" });
  });
});
