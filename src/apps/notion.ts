import { z } from "zod";
import type { App } from "./app.ts";
import { AppError, bearer, jsonOutput, request } from "./http.ts";
import { text, tool } from "./schema.ts";

export const NOTION_VERSION = "2026-03-11";
const API = "https://api.notion.com/v1";

const tools = [
  tool(
    "notion_search",
    "Search the Notion pages and data sources shared with this app by title.",
    { query: text, cursor: text },
    { optional: "all" },
  ),
  tool("notion_get_page", "Read the details and properties of a Notion page.", { page_id: text }),
  tool(
    "notion_list_blocks",
    "Show the child blocks under a page or block.",
    { block_id: text, cursor: text },
    { optional: ["cursor"] },
  ),
  tool(
    "notion_create_page",
    "Make a Notion page below a shared page or inside a shared data source.",
    { parent_id: text, parent_type: z.enum(["page", "data_source"]), title: text, text },
    { optional: ["parent_type", "text"], write: true, review: true },
  ),
  tool(
    "notion_append_text",
    "Add a paragraph of plain text to the end of a Notion page or block.",
    { block_id: text, text },
    { write: true, review: true },
  ),
];

// biome-ignore lint/suspicious/noExplicitAny: Notion replies are loose JSON
type Item = Record<string, any>;

/** A Notion ID in its canonical dashed form; anything else is refused. */
export function notionId(value: unknown): string {
  const raw = String(value)
    .trim()
    .replace(/^urn:uuid:/i, "")
    .replace(/^\{(.*)\}$/, "$1")
    .replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/i.test(raw)) {
    throw new AppError("Give a Notion ID returned by search or by listing blocks");
  }
  const hex = raw.toLowerCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

const richText = (value: string) => {
  const parts = [];
  for (let i = 0; i < value.length; i += 1000) {
    parts.push({ type: "text", text: { content: value.slice(i, i + 1000) } });
  }
  return parts;
};

const paragraph = (value: string) => ({
  type: "paragraph",
  paragraph: { rich_text: richText(value) },
});

const plain = (parts: Item[] = []) =>
  parts.map((item) => item.plain_text ?? item.text?.content ?? "").join("");

export function pageSummary(item: Item): Item {
  let title = item.title;
  if (!Array.isArray(title)) {
    const field = Object.values<Item>(item.properties ?? {}).find((f) => f?.type === "title");
    title = field?.title ?? [];
  }
  return {
    id: item.id,
    type: item.object ?? null,
    title: plain(title).slice(0, 500),
    url: item.url ?? null,
    parent: item.parent ?? null,
  };
}

export function blockSummary(item: Item): Item {
  const kind: string = item.type;
  const detail: Item = item[kind] ?? {};
  const out: Item = { id: item.id, type: kind, hasChildren: item.has_children ?? false };
  for (const field of ["rich_text", "caption"]) {
    if (field in detail) {
      const words = plain(detail[field]);
      out[field] = words.slice(0, 1200);
      if (words.length > 1200) out.textTruncated = true;
    }
  }
  if ("cells" in detail) {
    out.cells = detail.cells.slice(0, 20).map((cell: Item[]) => plain(cell).slice(0, 250));
  }
  for (const field of ["title", "url", "checked", "language", "expression"]) {
    if (field in detail) out[field] = detail[field];
  }
  return out;
}

export const notion: App = {
  name: "notion",
  tools,
  configured: () => false,
  retryOnRefusal: true,
  async run(ctx, name, a) {
    const headers = { ...bearer(await ctx.token()), "Notion-Version": NOTION_VERSION };
    const call = (method: string, url: string, opts: { json?: unknown; params?: Item } = {}) =>
      request<Item>(ctx.fetch, method, url, { headers, ...opts });
    const paging: Item = { page_size: 10 };
    if (a.cursor) paging.start_cursor = a.cursor;
    if (name === "notion_search") {
      if (a.query) paging.query = a.query;
      const found = await call("POST", `${API}/search`, { json: paging });
      return jsonOutput({
        items: found.results.map(pageSummary),
        nextCursor: found.next_cursor ?? null,
      });
    }
    if (name === "notion_get_page") {
      return jsonOutput(await call("GET", `${API}/pages/${notionId(a.page_id)}`));
    }
    if (name === "notion_create_page") {
      const parentId = notionId(a.parent_id);
      const parentType = String(a.parent_type ?? "page");
      let titleProperty: string | undefined = "title";
      if (parentType === "data_source") {
        const source = await call("GET", `${API}/data_sources/${parentId}`);
        titleProperty = Object.entries<Item>(source.properties ?? {}).find(
          ([, value]) => value?.type === "title",
        )?.[0];
        if (titleProperty === undefined) {
          throw new AppError("The chosen Notion data source has no title property");
        }
      }
      const body: Item = {
        parent: { type: `${parentType}_id`, [`${parentType}_id`]: parentId },
        properties: { [titleProperty]: { type: "title", title: richText(String(a.title)) } },
      };
      if (a.text) body.children = [paragraph(String(a.text))];
      return jsonOutput(pageSummary(await call("POST", `${API}/pages`, { json: body })));
    }
    const url = `${API}/blocks/${notionId(a.block_id)}/children`;
    if (name === "notion_list_blocks") {
      const found = await call("GET", url, { params: paging });
      return jsonOutput({
        items: found.results.map(blockSummary),
        nextCursor: found.next_cursor ?? null,
      });
    }
    if (name === "notion_append_text") {
      await call("PATCH", url, { json: { children: [paragraph(String(a.text))] } });
      return jsonOutput({ appended: true, blockId: a.block_id });
    }
    throw new AppError("Unknown tool");
  },
};
