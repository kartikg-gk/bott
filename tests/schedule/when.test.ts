import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextRun, parseWhen } from "../../src/schedule/when.js";

const NOW = 1_800_000_000; // 2027-01-15T08:00:00Z, 13:30 in Asia/Kolkata
const utc = (iso: string) => Date.parse(iso) / 1000;

let savedZone: string | undefined;
beforeAll(() => {
  savedZone = process.env.TZ;
  process.env.TZ = "Asia/Kolkata";
});
afterAll(() => {
  if (savedZone === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = savedZone;
});

describe("parseWhen", () => {
  const cases: [string, string, number | null][] = [
    ["every 30m", "every:1800", NOW + 1800],
    ["every 2h", "every:7200", NOW + 7200],
    ["every 1d", "every:86400", NOW + 86400],
    ["EVERY  15 M", "every:900", NOW + 900],
    ["  every 1m ", "every:60", NOW + 60],
    ["every 999999d", `every:${999999 * 86400}`, NOW + 999999 * 86400],
    ["daily 08:00", "daily:08:00", utc("2027-01-16T02:30:00Z")],
    ["daily 8:05", "daily:08:05", utc("2027-01-16T02:35:00Z")],
    ["daily 14:00", "daily:14:00", utc("2027-01-15T08:30:00Z")],
    ["daily 13:30", "daily:13:30", NOW + 86400],
    ["daily 23:59", "daily:23:59", utc("2027-01-15T18:29:00Z")],
    ["daily 00:00", "daily:00:00", utc("2027-01-15T18:30:00Z")],
    ["at 2027-02-01T08:00+05:30", "once", utc("2027-02-01T02:30:00Z")],
    ["at 2027-02-01T08:00:30Z", "once", utc("2027-02-01T08:00:30Z")],
    ["at 2027-02-01t08:00z", "once", utc("2027-02-01T08:00:00Z")],
    ["at 2027-02-01T08:00", "once", utc("2027-02-01T02:30:00Z")],
    ["at 2027-02-01", "once", utc("2027-01-31T18:30:00Z")],
    ["at 2027-02-01T08:00:00.500-04:00", "once", utc("2027-02-01T12:00:00.500Z")],
    ["at 20270201T0800Z", "once", utc("2027-02-01T08:00:00Z")],
    ["at 2027-W05-1", "once", utc("2027-01-31T18:30:00Z")],
    ["at 2027W051", "once", utc("2027-01-31T18:30:00Z")],
    ["at 2027-W05", "once", utc("2027-01-31T18:30:00Z")],
    ["at 2027-W05-3T08:00Z", "once", utc("2027-02-03T08:00:00Z")],
    ["at 2032-W53-7T00:00Z", "once", utc("2033-01-02T00:00:00Z")],
    ["on build.done", "event:build.done", null],
    ["On  deploy-ok ", "event:deploy-ok", null],
  ];
  it.each(cases)("%s", (text, spec, first) => {
    expect(parseWhen(text, NOW)).toEqual({ spec, first });
  });

  const forms = /every 30m.*daily 08:00.*at ISO-time.*on event-name/;
  it.each([
    "",
    "soon",
    "every 30",
    "every 5s",
    "daily 24:00",
    "daily 8:5",
    "weekly mon",
    "on",
    "on Bad Name",
  ])("rejects %j naming the accepted forms", (text) => {
    expect(() => parseWhen(text, NOW)).toThrow(forms);
  });

  it("limits repeats to once a minute", () => {
    expect(() => parseWhen("every 0m", NOW)).toThrow("A job may repeat no more than once a minute");
  });

  it("rejects past or unreadable one-off times", () => {
    expect(() => parseWhen("at 2020-01-01T00:00Z", NOW)).toThrow("That moment has already passed");
    expect(() => parseWhen("at 2027-01-15T08:00:00Z", NOW)).toThrow("already passed");
    expect(() => parseWhen("at tomorrow", NOW)).toThrow(
      "Use an ISO time, for example at 2026-11-02T08:00+05:30",
    );
    expect(() => parseWhen("at 2027-13-01T00:00Z", NOW)).toThrow("Use an ISO time");
    expect(() => parseWhen("at 2027-02-30", NOW)).toThrow("Use an ISO time");
    for (const bad of ["2027-W00-1", "2027-W53-1", "2027-W05-8", "2027-W54"]) {
      expect(() => parseWhen(`at ${bad}`, NOW)).toThrow("Use an ISO time");
    }
    expect(() => parseWhen("at 2027-02-01T25:00Z", NOW)).toThrow("Use an ISO time");
  });
});

describe("nextRun", () => {
  it("steps every-specs forward by their interval", () => {
    expect(nextRun("every:1800", NOW)).toBe(NOW + 1800);
  });

  it("gives null when the job does not repeat", () => {
    expect(nextRun("once", NOW)).toBeNull();
    expect(nextRun("event:build.done", NOW)).toBeNull();
    expect(nextRun("mystery", NOW)).toBeNull();
  });

  it("refuses corrupt specs instead of returning a time at or before now", () => {
    for (const spec of [
      "every",
      "every:",
      "every:0",
      "every:-5",
      "every:59",
      "every:x",
      "every:1.5",
    ]) {
      expect(() => nextRun(spec, NOW), spec).toThrow("Bad schedule");
    }
    for (const spec of [
      "daily",
      "daily:xx",
      "daily:25:99",
      "daily:8:05",
      "daily:08:60",
      "daily:08",
    ]) {
      expect(() => nextRun(spec, NOW), spec).toThrow("Bad schedule");
    }
  });

  it("finds the next daily time strictly after now", () => {
    expect(nextRun("daily:14:00", NOW)).toBe(utc("2027-01-15T08:30:00Z"));
    expect(nextRun("daily:13:30", NOW)).toBe(NOW + 86400);
    for (const offset of [0, 1, 59, 3600, 86399, 86400, 123456]) {
      const next = nextRun("daily:09:15", NOW + offset) as number;
      expect(next).toBeGreaterThan(NOW + offset);
      expect(next - (NOW + offset)).toBeLessThanOrEqual(86400);
    }
  });

  it("keeps the wall-clock time across a clock change", () => {
    process.env.TZ = "America/New_York";
    try {
      // 2027-03-14 is the spring-forward day; 08:00 stays 08:00 local.
      const before = utc("2027-03-13T14:00:00Z"); // 09:00 EST on the 13th
      expect(nextRun("daily:08:00", before)).toBe(utc("2027-03-14T12:00:00Z")); // 08:00 EDT
    } finally {
      process.env.TZ = "Asia/Kolkata";
    }
  });
});
