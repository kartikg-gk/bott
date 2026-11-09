import type { App } from "./app.ts";
import { googleApi, segment } from "./google.ts";
import { AppError, jsonOutput } from "./http.ts";
import { text, tool } from "./schema.ts";

const API = "https://docs.googleapis.com/v1/documents";

const tools = [
  tool(
    "docs_create",
    "Makes a new, empty Google Doc with the given title.",
    { title: text },
    {
      write: true,
      review: true,
    },
  ),
  tool(
    "docs_append_text",
    "Adds plain text after the last line of a Google Doc, or of one of its tabs.",
    { document_id: text, text, tab_id: text },
    { optional: ["tab_id"], write: true, review: true },
  ),
];

export const docs: App = {
  name: "docs",
  tools,
  configured: () => false,
  async run(ctx, name, args) {
    const api = googleApi(ctx.fetch, await ctx.token());
    if (name === "docs_create") {
      return jsonOutput(await api.call("POST", API, { json: { title: args.title } }));
    }
    if (name !== "docs_append_text") throw new AppError("Unknown Docs tool");
    const end = typeof args.tab_id === "string" && args.tab_id ? { tabId: args.tab_id } : {};
    await api.call("POST", `${API}/${segment(args.document_id)}:batchUpdate`, {
      json: { requests: [{ insertText: { endOfSegmentLocation: end, text: args.text } }] },
    });
    return jsonOutput({ documentId: args.document_id, appended: true });
  },
};
