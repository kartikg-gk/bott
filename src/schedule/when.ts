/** Job timing: `every 30m`, `daily 08:00`, `at 2026-11-02T08:00+05:30` or `on event-name`. */

export const MIN_INTERVAL = 60;
const UNITS: Record<string, number> = { m: 60, h: 3600, d: 86400 };
const EVENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO_TIME_HINT = "Use an ISO time, for example at 2026-11-02T08:00+05:30";

const CLOCK = String.raw`(?:.(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?(z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?)?$`;
const CALENDAR = new RegExp(String.raw`^(\d{4})-?(\d{2})-?(\d{2})${CLOCK}`);
const WEEK = new RegExp(String.raw`^(\d{4})-?w(\d{2})(?:-?([1-7]))?${CLOCK}`);

/** The calendar day of an ISO week date, or null when that year has no such week. */
function weekDay(year: number, week: number, day: number): [number, number, number] | null {
  const jan4 = new Date(Date.UTC(2000, 0, 4));
  jan4.setUTCFullYear(year);
  const monday =
    jan4.getTime() + (-((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7 + (day - 1)) * 86400000;
  const thursday = new Date(monday + (4 - day) * 86400000);
  if (week < 1 || thursday.getUTCFullYear() !== year) return null;
  const date = new Date(monday);
  return [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
}

/** Reads an ISO 8601 date or date-time; a time without an offset is local time. Seconds, or null. */
function isoSeconds(text: string): number | null {
  const lower = text.toLowerCase();
  const week = WEEK.exec(lower);
  const m = week ?? CALENDAR.exec(lower);
  if (!m) return null;
  let year = Number(m[1]);
  let month = Number(m[2]);
  let day = Number(m[3]);
  if (week) {
    const found = weekDay(year, month, Number(m[3] ?? 1));
    if (!found) return null;
    [year, month, day] = found;
  }
  const hour = Number(m[4] ?? 0);
  const minute = Number(m[5] ?? 0);
  const second = Number(m[6] ?? 0);
  const millis = Math.floor(Number(`0.${(m[7] ?? "0").slice(0, 3).padEnd(3, "0")}`) * 1000);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const probe = new Date(Date.UTC(2000, month - 1, day));
  probe.setUTCFullYear(year);
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  if (m[8] === undefined) {
    const local = new Date(2000, 0, 1);
    local.setFullYear(year, month - 1, day);
    local.setHours(hour, minute, second, millis);
    return local.getTime() / 1000;
  }
  let offset = 0;
  if (m[8] !== "z") {
    const digits = m[8].slice(1).replace(/:/g, "");
    const h = Number(digits.slice(0, 2));
    const mi = Number(digits.slice(2, 4) || 0);
    const s = Number(digits.slice(4, 6) || 0);
    if (h >= 24 || mi > 59 || s > 59) return null;
    offset = (h * 3600 + mi * 60 + s) * (m[8].startsWith("-") ? -1 : 1);
  }
  const utc = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, millis));
  utc.setUTCFullYear(year);
  return utc.getTime() / 1000 - offset;
}

/** Returns the stored schedule and the first run time (null for a job that waits for an event). */
export function parseWhen(text: string, now: number): { spec: string; first: number | null } {
  const clean = text.trim().toLowerCase();
  if (clean.startsWith("on ") && EVENT_NAME.test(clean.slice(3).trim())) {
    return { spec: `event:${clean.slice(3).trim()}`, first: null };
  }
  let spec: string;
  const every = /^every\s+(\d{1,6})\s*([mhd])$/.exec(clean);
  const daily = /^daily\s+([01]?\d|2[0-3]):([0-5]\d)$/.exec(clean);
  const at = /^at\s+(\S+)$/.exec(clean);
  if (every) {
    const seconds = Number(every[1]) * (UNITS[every[2] as string] as number);
    if (seconds < MIN_INTERVAL) throw new Error("A job may repeat no more than once a minute");
    spec = `every:${seconds}`;
  } else if (daily) {
    spec = `daily:${String(Number(daily[1])).padStart(2, "0")}:${daily[2]}`;
  } else if (at) {
    const first = isoSeconds(at[1] as string);
    if (first === null) throw new Error(ISO_TIME_HINT);
    if (first <= now) throw new Error("That moment has already passed");
    return { spec: "once", first };
  } else {
    throw new Error("Write every 30m, daily 08:00, at ISO-time, or on event-name");
  }
  return { spec, first: nextRun(spec, now) };
}

/** The first run after `now` (seconds), or null when the job does not repeat. */
export function nextRun(spec: string, now: number): number | null {
  const colon = spec.indexOf(":");
  const kind = colon < 0 ? spec : spec.slice(0, colon);
  const value = colon < 0 ? "" : spec.slice(colon + 1);
  if (kind === "every") {
    const seconds = Number(value);
    if (!/^\d+$/.test(value) || seconds < MIN_INTERVAL) throw new Error(`Bad schedule: ${spec}`);
    return now + seconds;
  }
  if (kind === "daily") {
    const parts = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    if (!parts) throw new Error(`Bad schedule: ${spec}`);
    const [hour, minute] = [Number(parts[1]), Number(parts[2])] as [number, number];
    const current = new Date(now * 1000);
    for (let ahead = 0; ahead < 3; ahead++) {
      const target = new Date(
        current.getFullYear(),
        current.getMonth(),
        current.getDate() + ahead,
        hour,
        minute,
      );
      if (target.getTime() / 1000 > now) return target.getTime() / 1000;
    }
    return now + 86400;
  }
  return null;
}
