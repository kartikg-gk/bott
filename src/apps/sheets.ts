import { z } from "zod";
import type { App } from "./app.ts";
import { googleApi, segment } from "./google.ts";
import { AppError, boundedBytes, jsonOutput, send } from "./http.ts";
import { text, tool } from "./schema.ts";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
/** The most a read hands back; a bigger range has to be read in smaller parts. */
const READ_LIMIT = 18_000;
const TOO_BIG = "That range holds too much to read at once; read a smaller range";

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const rows = z.array(z.array(cell).min(1).max(50)).min(1).max(100);
const mode = z.enum(["RAW", "USER_ENTERED"]);
const where = { spreadsheet_id: text, range: text };

const tools = [
  tool(
    "sheets_read",
    "The values in an A1 range or a named range of a spreadsheet. Keep ranges small on big sheets.",
    where,
  ),
  tool(
    "sheets_append_rows",
    "Adds rows below the table found in the range. Values go in as written unless input_mode " +
      "is USER_ENTERED, which reads them as if typed, formulas included.",
    { ...where, values: rows, input_mode: mode },
    { optional: ["input_mode"], write: true, review: true },
  ),
  tool(
    "sheets_update_range",
    "Writes rows over a range. Values go in as written unless input_mode is USER_ENTERED.",
    { ...where, values: rows, input_mode: mode },
    { optional: ["input_mode"], write: true, review: true },
  ),
  tool(
    "sheets_create",
    "Makes a new spreadsheet, with one tab named sheet_title when given.",
    { title: text, sheet_title: text },
    { optional: ["sheet_title"], write: true, review: true },
  ),
];

const writeArgs = z.object({ values: rows, input_mode: mode.optional() }).passthrough();

export const sheets: App = {
  name: "sheets",
  tools,
  configured: () => false,
  async run(ctx, name, args) {
    const api = googleApi(ctx.fetch, await ctx.token());
    if (name === "sheets_create") {
      const body: Record<string, unknown> = { properties: { title: args.title } };
      if (typeof args.sheet_title === "string" && args.sheet_title) {
        body.sheets = [{ properties: { title: args.sheet_title } }];
      }
      const fields =
        "spreadsheetId,spreadsheetUrl,properties(title),sheets(properties(sheetId,title))";
      return jsonOutput(await api.call("POST", API, { json: body, params: { fields } }));
    }
    const url = `${API}/${segment(args.spreadsheet_id)}/values/${segment(args.range)}`;
    if (name === "sheets_read") {
      const reply = await send(ctx.fetch, "GET", url, {
        headers: api.headers,
        params: { valueRenderOption: "UNFORMATTED_VALUE", majorDimension: "ROWS" },
      });
      const data = await boundedBytes(reply, READ_LIMIT, TOO_BIG);
      const value = JSON.parse(Buffer.from(data).toString("utf8"));
      if (JSON.stringify(value).length > READ_LIMIT + 1000) throw new AppError(TOO_BIG);
      return jsonOutput(value);
    }
    if (name !== "sheets_append_rows" && name !== "sheets_update_range") {
      throw new AppError("Unknown Sheets tool");
    }
    const checked = writeArgs.safeParse(args);
    if (!checked.success) {
      throw new AppError(
        "Send 1 to 100 rows of 1 to 50 cells, each text, a number, true, false or null",
      );
    }
    const params: Record<string, string> = {
      valueInputOption: checked.data.input_mode ?? "RAW",
    };
    const json = { values: checked.data.values, majorDimension: "ROWS" };
    if (name === "sheets_append_rows") {
      params.insertDataOption = "INSERT_ROWS";
      return jsonOutput(await api.call("POST", `${url}:append`, { params, json }));
    }
    return jsonOutput(await api.call("PUT", url, { params, json }));
  },
};
