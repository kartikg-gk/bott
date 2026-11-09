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
    "Show the calendars and the ID of each.",
    { page_token: text },
    { optional: "all" },
  ),
  tool(
    "calendar_list_events",
    "Show events overlapping a time range given as RFC 3339 times with offsets.",
    { calendar_id: text, start: text, end: text, page_token: text },
    { optional: ["calendar_id", "page_token"] },
  ),
  tool(
    "calendar_find_free_time",
    "Find times when everyone listed is free, within 31 days; 30 minutes by default.",
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
    "Make an event from times with offsets or whole-day dates; the end is exclusive. " +
      "Pick who gets notified.",
    { calendar_id: text, ...eventFields },
    { optional: optionalEvent, write: true, review: true },
  ),
  tool(
    "calendar_update_event",
    "Change chosen fields of an event; attendees, when given, become the full guest list. " +
      "Pick who gets notified.",
    { calendar_id: text, event_id: text, ...eventFields },
    { optional: [...optionalEvent, "title", "start", "end"], write: true, review: true },
  ),
  tool(
    "calendar_respond_to_event",
    "Set your own reply to the invite and pick who gets notified.",
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
    "Remove an event and pick who gets notified.",
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
  if (Number.isNaN(parsed)) throw new AppError("Give an RFC 3339 time that includes its offset");
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
      throw new AppError("Start and end must both be whole days or both be times");
    }
    if ("date" in payload.start) {
      if (payload.start.date >= payload.end.date) throw new AppError("The end has to come after the start");
    } else window(a);
  }
  if ("attendees" in a) payload.attendees = a.attendees.map((email: string) => ({ email }));
  if (Object.keys(payload).length === 0) {
    throw new AppError("Give at least one event field to change");
  }
  return payload;
}

async function freeTime(api: GoogleApi, a: Item): Promise<Item> {
  const [start, end] = window(a);
  const calendars = [...new Set<string>(a.calendar_ids)];
  if (calendars.length < 1 || calendars.length > 50 || end - start > 31 * 86400) {
    throw new AppError("Ask about 1 to 50 calendars over at most 31 days");
  }
  const data = await api.call("POST", `${API}/freeBusy`, {
    json: { timeMin: a.start, timeMax: a.end, items: calendars.map((id) => ({ id })) },
  });
  const busy: [number, number][] = [];
  for (const id of calendars) {
    const entry = data?.calendars?.[id];
    if (!entry || typeof entry !== "object" || entry.errors || !Array.isArray(entry.busy)) {
      throw new AppError("Free time could not be confirmed for each calendar asked about");
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
    return page(api, `${API}/users/me/calendarList`, a, "id,summary,primary,timeZone,accessRole");
  }
  if (name === "calendar_find_free_time") return freeTime(api, a);
  const base = `${API}/calendars/${segment(a.calendar_id ?? "primary")}/events`;
  if (name === "calendar_list_events") {
    window(a);
    const fields = "id,summary,description,start,end,status,location,htmlLink,organizer";
    return page(api, base, a, fields, {
      timeMin: a.start,
      timeMax: a.end,
      singleEvents: "true",
      orderBy: "startTime",
    });
  }
  if (!notify.safeParse(a.notify).success) {
    throw new AppError("Pick who gets notified: all, externalOnly, or none");
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
    const event = await api.get<Item>(url, { fields: "etag,attendees(email,self)" });
    const me = (event?.attendees ?? [])
      .filter((guest: Item) => guest.self && guest.email)
      .map((guest: Item) => guest.email);
    if (me.length !== 1 || !event?.etag) {
      throw new AppError("This account could not be found among the attendees of the event");
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
