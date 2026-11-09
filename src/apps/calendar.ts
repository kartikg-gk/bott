import { z } from "zod";
import type { App } from "./app.ts";
import { type GoogleApi, googleApi, segment } from "./google.ts";
import { AppError, jsonOutput } from "./http.ts";
import { text, tool } from "./schema.ts";

const API = "https://www.googleapis.com/calendar/v3";
const notify = z.enum(["all", "externalOnly", "none"]);
const eventFields = {
  title: text,
  start: text,
  end: text,
  description: z.string(),
  location: z.string(),
  attendees: z.array(text).max(20),
  notify,
};
const optionalEvent = ["calendar_id", "description", "location", "attendees"];

const tools = [
  tool(
    "calendar_list_calendars",
    "Every calendar the person can see, with its ID.",
    { page_token: text },
    { optional: "all" },
  ),
  tool(
    "calendar_list_events",
    "Events that fall at least partly inside a time window. Give start and end as RFC 3339 times that include an offset.",
    { calendar_id: text, start: text, end: text, page_token: text },
    { optional: ["calendar_id", "page_token"] },
  ),
  tool(
    "calendar_find_free_time",
    "Times when all the given calendars are free, over at most 31 days. Gaps under 30 minutes are skipped unless a minimum is given.",
    {
      calendar_ids: z.array(text).min(1).max(50),
      start: text,
      end: text,
      minimum_minutes: z.number().int().min(1).max(44640),
    },
    { optional: ["minimum_minutes"] },
  ),
  tool(
    "calendar_create_event",
    "Adds an event. Use times with an offset, or whole-day dates where the end day is not included. " +
      "Say who gets an invitation.",
    { calendar_id: text, ...eventFields },
    { optional: optionalEvent, write: true, review: true },
  ),
  tool(
    "calendar_update_event",
    "Changes only the event fields given. A guest list, when given, takes the place of the old one. " +
      "Say who hears about the change.",
    { calendar_id: text, event_id: text, ...eventFields },
    { optional: [...optionalEvent, "title", "start", "end"], write: true, review: true },
  ),
  tool(
    "calendar_respond_to_event",
    "Sets the person's own answer to an invitation and says who hears about it.",
    {
      calendar_id: text,
      event_id: text,
      notify,
      response: z.enum(["accepted", "declined", "tentative"]),
    },
    { optional: ["calendar_id"], write: true, review: true },
  ),
  tool(
    "calendar_delete_event",
    "Removes an event and says who hears about it.",
    { calendar_id: text, event_id: text, notify },
    { optional: ["calendar_id"], write: true, review: true },
  ),
];

// biome-ignore lint/suspicious/noExplicitAny: Google replies are loose JSON
type Item = Record<string, any>;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Seconds since the epoch of an RFC 3339 timestamp that names its offset. */
export function timestamp(value: unknown): number {
  const parsed = typeof value === "string" && TIMESTAMP.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(parsed))
    throw new AppError(
      "Times need RFC 3339 form with an offset, such as 2026-01-05T09:00:00+01:00",
    );
  return parsed / 1000;
}

export function validDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/** A UTC time written with an explicit +00:00 offset. */
export function utc(seconds: number): string {
  const iso = new Date(seconds * 1000).toISOString();
  return `${iso.endsWith(".000Z") ? iso.slice(0, 19) : iso.slice(0, 23)}+00:00`;
}

function eventTime(value: string): Item {
  if (DATE.test(value)) {
    if (!validDate(value)) throw new AppError("Use a real date in YYYY-MM-DD");
    return { date: value };
  }
  timestamp(value);
  return { dateTime: value };
}

function window(a: Item): [number, number] {
  const start = timestamp(a.start);
  const end = timestamp(a.end);
  if (end <= start) throw new AppError("The end has to come after the start");
  return [start, end];
}

function eventPayload(a: Item): Item {
  const payload: Item = {};
  const names: [string, string][] = [
    ["title", "summary"],
    ["description", "description"],
    ["location", "location"],
  ];
  for (const [key, field] of names) if (key in a) payload[field] = a[key];
  for (const key of ["start", "end"]) if (key in a) payload[key] = eventTime(a[key]);
  if (payload.start && payload.end) {
    if ("date" in payload.start !== "date" in payload.end) {
      throw new AppError("Give start and end the same way: both whole days or both times");
    }
    if ("date" in payload.start) {
      if (payload.start.date >= payload.end.date) throw new AppError("The end has to come after the start");
    } else window(a);
  }
  if ("attendees" in a) payload.attendees = a.attendees.map((email: string) => ({ email }));
  if (Object.keys(payload).length === 0) {
    throw new AppError("Name at least one event field to change");
  }
  return payload;
}

async function freeTime(api: GoogleApi, a: Item): Promise<Item> {
  const [start, end] = window(a);
  const calendars = [...new Set<string>(a.calendar_ids)];
  if (calendars.length < 1 || calendars.length > 50 || end - start > 31 * 86400) {
    throw new AppError("Ask about 1 to 50 calendars over no more than 31 days");
  }
  const data = await api.call("POST", `${API}/freeBusy`, {
    json: { timeMin: a.start, timeMax: a.end, items: calendars.map((id) => ({ id })) },
  });
  const busy: [number, number][] = [];
  for (const id of calendars) {
    const entry = data?.calendars?.[id];
    if (!entry || typeof entry !== "object" || entry.errors || !Array.isArray(entry.busy)) {
      throw new AppError("Free times could not be checked on all of those calendars");
    }
    for (const item of entry.busy) {
      const lower = Math.max(start, timestamp(item.start));
      const upper = Math.min(end, timestamp(item.end));
      if (lower < upper) busy.push([lower, upper]);
    }
  }
  const minimum = (a.minimum_minutes ?? 30) * 60;
  const intervals: Item[] = [];
  let cursor = start;
  busy.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  busy.push([end, end]);
  for (const [lower, upper] of busy) {
    if (lower - cursor >= minimum) intervals.push({ start: utc(cursor), end: utc(lower) });
    cursor = Math.max(cursor, upper);
  }
  return { intervals };
}

async function page(
  api: GoogleApi,
  url: string,
  a: Item,
  fields: string,
  query: Record<string, string> = {},
) {
  const data = await api.get<Item>(url, {
    maxResults: 20,
    fields: `nextPageToken,items(${fields})`,
    ...query,
    pageToken: a.page_token,
  });
  return { items: data?.items ?? [], nextPageToken: data?.nextPageToken ?? null };
}

async function run(api: GoogleApi, name: string, a: Item): Promise<Item> {
  if (name === "calendar_list_calendars") {
    return page(api, `${API}/users/me/calendarList`, a, "id,primary,summary,accessRole,timeZone");
  }
  if (name === "calendar_find_free_time") return freeTime(api, a);
  const base = `${API}/calendars/${segment(a.calendar_id ?? "primary")}/events`;
  if (name === "calendar_list_events") {
    window(a);
    const fields = "id,status,summary,start,end,location,description,organizer,htmlLink";
    return page(api, base, a, fields, {
      timeMin: a.start,
      timeMax: a.end,
      singleEvents: "true",
      orderBy: "startTime",
    });
  }
  if (!notify.safeParse(a.notify).success) {
    throw new AppError("Set notify to all, externalOnly or none");
  }
  const params = { sendUpdates: a.notify };
  if (name === "calendar_create_event") {
    return api.call("POST", base, { params, json: eventPayload(a) });
  }
  const url = `${base}/${segment(a.event_id)}`;
  if (name === "calendar_update_event") {
    return api.call("PATCH", url, { params, json: eventPayload(a) });
  }
  if (name === "calendar_respond_to_event") {
    const event = await api.get<Item>(url, { fields: "attendees(self,email),etag" });
    const me = (event?.attendees ?? [])
      .filter((guest: Item) => guest.self && guest.email)
      .map((guest: Item) => guest.email);
    if (me.length !== 1 || !event?.etag) {
      throw new AppError("The connected account is not on this event's guest list");
    }
    return api.call("PATCH", url, {
      params,
      headers: { "If-Match": event.etag },
      json: { attendeesOmitted: true, attendees: [{ email: me[0], responseStatus: a.response }] },
    });
  }
  if (name === "calendar_delete_event") {
    await api.call("DELETE", url, { params });
    return { deleted: true, id: a.event_id };
  }
  throw new AppError("Unknown Calendar tool");
}

export const calendar: App = {
  name: "calendar",
  tools,
  configured: () => false,
  async run(ctx, name, args) {
    return jsonOutput(await run(googleApi(ctx.fetch, await ctx.token()), name, args));
  },
};
