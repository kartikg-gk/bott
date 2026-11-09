import { describe, expect, it } from "vitest";
import { OAUTH_APPS } from "../../src/apps/connections.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { sheets } from "../../src/apps/sheets.ts";
import { fakeFetch, json } from "../support/fakeFetch.ts";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

function account(routes: Parameters<typeof fakeFetch>[0]) {
  const fetcher = fakeFetch(routes);
  const apps = new AppRunner({
    fetch: fetcher,
    env: {},
    accessToken: async () => "sheets-token",
    available: async () => true,
  });
  return { fetcher, apps };
}

describe("sheets", () => {
  it("is an account app with the Sheets scope; reading runs, writing asks", () => {
    expect(APPS.sheets).toBe(sheets);
    expect(OAUTH_APPS.sheets?.scopes).toEqual(["https://www.googleapis.com/auth/spreadsheets"]);
    expect(sheets.configured({})).toBe(false);
    expect(sheets.tools.map((t) => [t.name, t.readOnly, t.review])).toEqual([
      ["sheets_read", true, false],
      ["sheets_append_rows", false, true],
      ["sheets_update_range", false, true],
      ["sheets_create", false, true],
    ]);
  });

  it("reads a range as plain rows and refuses one too big to hand over", async () => {
    const values = { range: "Sheet1!A1:B2", values: [["a", 1]] };
    const { fetcher, apps } = account({
      [`GET ${API}/s1/values/Sheet1!A1%3AB2`]: () => json(values),
      [`GET ${API}/s1/values/Big`]: () => json({ values: [["x".repeat(19_000)]] }),
    });
    expect(
      parse(await apps.run("sheets_read", { spreadsheet_id: "s1", range: "Sheet1!A1:B2" })),
    ).toEqual(values);
    const q = fetcher.seen[0]?.url.searchParams;
    expect(q?.get("valueRenderOption")).toBe("UNFORMATTED_VALUE");
    expect(q?.get("majorDimension")).toBe("ROWS");
    await expect(apps.run("sheets_read", { spreadsheet_id: "s1", range: "Big" })).rejects.toThrow(
      "smaller range",
    );
  });

  it("appends and replaces rows, literally unless asked to read them as typed", async () => {
    const { fetcher, apps } = account({
      [`POST ${API}/s1/values/Log:append`]: () => json({ updates: { updatedRows: 1 } }),
      [`PUT ${API}/s1/values/Log!A1`]: () => json({ updatedCells: 2 }),
    });
    await apps.run("sheets_append_rows", {
      spreadsheet_id: "s1",
      range: "Log",
      values: [[1, "=2"]],
    });
    expect(fetcher.seen[0]?.url.searchParams.get("valueInputOption")).toBe("RAW");
    expect(fetcher.seen[0]?.url.searchParams.get("insertDataOption")).toBe("INSERT_ROWS");
    expect(fetcher.seen[0]?.json).toEqual({ values: [[1, "=2"]], majorDimension: "ROWS" });
    await apps.run("sheets_update_range", {
      spreadsheet_id: "s1",
      range: "Log!A1",
      values: [["=1+1", true]],
      input_mode: "USER_ENTERED",
    });
    expect(fetcher.seen[1]?.url.searchParams.get("valueInputOption")).toBe("USER_ENTERED");
    await expect(
      apps.run("sheets_update_range", { spreadsheet_id: "s1", range: "Log", values: [] }),
    ).rejects.toThrow();
  });

  it("creates a spreadsheet, optionally naming its first tab", async () => {
    const { fetcher, apps } = account({
      [`POST ${API}`]: () => json({ spreadsheetId: "s9" }),
    });
    await apps.run("sheets_create", { title: "Budget", sheet_title: "2027" });
    expect(fetcher.seen[0]?.json).toEqual({
      properties: { title: "Budget" },
      sheets: [{ properties: { title: "2027" } }],
    });
    expect(fetcher.seen[0]?.url.searchParams.get("fields")).toContain("spreadsheetUrl");
    await apps.run("sheets_create", { title: "Plain" });
    expect(fetcher.seen[1]?.json).toEqual({ properties: { title: "Plain" } });
  });
});
