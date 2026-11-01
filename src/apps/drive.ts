import { z } from "zod";
import type { App, AppServices } from "./app.ts";
import { MAX_DOCUMENT_BYTES } from "./documents.ts";
import { type GoogleApi, googleApi, segment } from "./google.ts";
import { AppError, HttpError, jsonOutput, NetworkError, withParams } from "./http.ts";
import { offset, text, tool } from "./schema.ts";

export const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
export const GOOGLE_FILE = "application/vnd.google-apps.";
const EXPORTS: Record<string, string> = {
  [`${GOOGLE_FILE}document`]: "text/plain",
  [`${GOOGLE_FILE}spreadsheet`]: "text/csv",
  [`${GOOGLE_FILE}presentation`]: "text/plain",
  [`${GOOGLE_FILE}drawing`]: "image/png",
  [`${GOOGLE_FILE}script`]: "application/vnd.google-apps.script+json",
};

export const driveTools = [
  tool(
    "drive_search",
    "Find Drive files with a Drive query; files in the trash are left out.",
    { query: text, page_token: text, drive_id: text },
    { optional: "all" },
  ),
  tool(
    "drive_read_file",
    "Read a stored file or an export of a Google file, passing nextOffset and version for later pages. " +
      "Use base64 for binary content. A Google Sheets CSV export holds only the first sheet.",
    {
      file_id: text,
      format: z.enum(["text", "base64"]),
      export_mime: text,
      offset,
      version: text,
    },
    { optional: ["format", "export_mime", "offset", "version"] },
  ),
  tool(
    "drive_extract_document",
    "Extract text from an uploaded PDF, PNG or JPEG on the server. " +
      "Pick a page, and pass nextOffset to read on.",
    { file_id: text, page: z.number().int().min(1).max(100), offset },
    { optional: ["page", "offset"] },
  ),
];

// biome-ignore lint/suspicious/noExplicitAny: Drive replies are loose JSON
type Item = Record<string, any>;

/** Reads one page of a file's bytes, using a byte range for uploaded files. */
export async function mediaPage(
  api: GoogleApi,
  url: string,
  params: Record<string, string>,
  start: number,
  limit: number,
  exporting: boolean,
): Promise<{ data: Buffer; more: boolean }> {
  const headers: Record<string, string> = { ...api.headers, "Accept-Encoding": "identity" };
  if (!exporting) headers.Range = `bytes=${start}-${start + limit - 1}`;
  let reply: Response;
  try {
    reply = await api.fetch(withParams(url, params), {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new NetworkError("Could not reach Drive");
  }
  if (reply.status === 416) throw new AppError("That offset is past the end of the file");
  if (!reply.ok) throw new HttpError(reply.status);
  let total: number | undefined;
  let first = 0;
  let last = 0;
  let skip = start;
  if (reply.status === 206) {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(reply.headers.get("content-range") ?? "");
    if (exporting || !match || Number(match[1]) !== start) {
      throw new AppError("Drive answered with a content range that was not asked for");
    }
    [first, last, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (!(first <= last && last < total) || last >= first + limit) {
      throw new AppError("Drive answered with a content range that was not asked for");
    }
    skip = 0;
  } else if (!exporting && start) {
    throw new AppError("Drive ignored the byte range that was asked for");
  }
  const parts: Buffer[] = [];
  let size = 0;
  if (reply.body) {
    const reader = reply.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = Buffer.from(value);
      if (skip) {
        const consumed = Math.min(skip, chunk.length);
        chunk = chunk.subarray(consumed);
        skip -= consumed;
      }
      const kept = chunk.subarray(0, limit + 1 - size);
      parts.push(kept);
      size += kept.length;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  if (skip) throw new AppError("That offset is past the end of the file");
  const data = Buffer.concat(parts);
  if (total !== undefined && data.length !== last - first + 1) {
    throw new AppError("Drive answered with a partial content range");
  }
  const more = total !== undefined ? start + data.length < total : data.length > limit;
  return { data: data.subarray(0, limit), more };
}

/** How many bytes at the end start a UTF-8 character that the next page finishes. */
export function unfinishedTail(data: Buffer): number {
  for (let back = 1; back <= Math.min(3, data.length); back++) {
    const byte = data[data.length - back] as number;
    if ((byte & 0xc0) !== 0x80) {
      const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      return needed > back ? back : 0;
    }
  }
  return 0;
}

export async function fileMetadata(api: GoogleApi, fileId: string): Promise<Item> {
  return api.get<Item>(`${DRIVE_API}/${segment(fileId)}`, {
    fields: "id,name,mimeType,version,size,capabilities(canDownload),shortcutDetails(targetId)",
    supportsAllDrives: "true",
  });
}

export async function currentVersion(api: GoogleApi, fileId: string): Promise<unknown> {
  const now = await api.get<Item>(`${DRIVE_API}/${segment(fileId)}`, {
    fields: "version",
    supportsAllDrives: "true",
  });
  return now?.version;
}

async function search(api: GoogleApi, a: Item): Promise<Item> {
  const params: Record<string, string | number> = {
    q: a.query ? `trashed = false and (${a.query})` : "trashed = false",
    pageSize: 20,
    fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,size,version,webViewLink)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  };
  if (a.drive_id) Object.assign(params, { corpora: "drive", driveId: a.drive_id });
  if (a.page_token) params.pageToken = a.page_token;
  return api.get(DRIVE_API, params);
}

async function readFile(api: GoogleApi, a: Item): Promise<Item> {
  const fileId: string = a.file_id;
  let url = `${DRIVE_API}/${segment(fileId)}`;
  const metadata = await fileMetadata(api, fileId);
  let mime: string = metadata.mimeType;
  if (mime === `${GOOGLE_FILE}shortcut`) return { shortcut: metadata.shortcutDetails?.targetId };
  const version = metadata.version;
  if (a.version !== undefined && a.version !== version) {
    throw new AppError("The file has changed since; start again at byte zero to read the new one.");
  }
  if (metadata.capabilities?.canDownload === false) {
    throw new AppError("Drive does not let this file be downloaded");
  }
  const exporting = mime.startsWith(GOOGLE_FILE);
  const start: number = a.offset ?? 0;
  if (start && version && !a.version) {
    throw new AppError("When reading on, pass the version that the first page gave");
  }
  const format: string = a.format ?? "text";
  const limit = format === "base64" ? 9000 : 2500;
  let params: Record<string, string>;
  if (exporting) {
    const fallback = EXPORTS[mime];
    if (fallback === undefined && !("export_mime" in a)) {
      throw new AppError("There is no standard export for this kind of Google file");
    }
    mime = a.export_mime ?? fallback;
    url += "/export";
    params = { mimeType: mime };
    if (start > 10 * 1024 ** 2)
      throw new AppError("That offset is beyond what Drive lets an export hold");
  } else {
    if ("export_mime" in a) {
      throw new AppError("An export type can only be given for native Google file kinds");
    }
    params = { alt: "media", supportsAllDrives: "true" };
  }
  const size = !exporting && metadata.size !== undefined ? Number(metadata.size) : undefined;
  if (size !== undefined && start > size) throw new AppError("That offset is past the end of the file");
  const page =
    size === start
      ? { data: Buffer.alloc(0), more: false }
      : await mediaPage(api, url, params, start, limit, exporting);
  if (version && (page.more || start)) {
    if ((await currentVersion(api, fileId)) !== version) {
      throw new AppError("The file has changed since; start again at byte zero to read the new one.");
    }
  }
  let content: string;
  let pending = 0;
  if (format === "base64") {
    content = page.data.toString("base64");
  } else {
    pending = page.more ? unfinishedTail(page.data) : 0;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        page.data.subarray(0, page.data.length - pending),
      );
    } catch {
      throw new AppError("Pass a byte cursor that was returned, or use base64 for binary content");
    }
  }
  return {
    id: fileId,
    name: metadata.name ?? null,
    mimeType: mime,
    version: version ?? null,
    format,
    content,
    nextOffset: page.more ? start + page.data.length - pending : null,
  };
}

const EXTRACTABLE = new Set(["application/pdf", "image/png", "image/jpeg"]);

/** Downloads an uploaded document whole, within the size limit, and extracts a page of it. */
async function extractDocument(
  api: GoogleApi,
  a: Item,
  documents: NonNullable<AppServices["documents"]>,
): Promise<Item> {
  const fileId: string = a.file_id;
  const metadata = await fileMetadata(api, fileId);
  const mime: string = metadata.mimeType;
  if (mime === `${GOOGLE_FILE}shortcut`) return { shortcut: metadata.shortcutDetails?.targetId };
  const version = metadata.version;
  if (metadata.capabilities?.canDownload === false) {
    throw new AppError("Drive does not let this file be downloaded");
  }
  if (!EXTRACTABLE.has(mime)) throw new AppError("Pick a stored PDF, PNG or JPEG to read");
  if (Number(metadata.size ?? 0) > MAX_DOCUMENT_BYTES) {
    throw new AppError("Attachments over 8 MiB are not read");
  }
  const url = `${DRIVE_API}/${segment(fileId)}`;
  const params = { alt: "media", supportsAllDrives: "true" };
  const { data, more } = await mediaPage(api, url, params, 0, MAX_DOCUMENT_BYTES, false);
  if (more) throw new AppError("Attachments over 8 MiB are not read");
  if (version && (await currentVersion(api, fileId)) !== version) {
    throw new AppError("The attachment changed while downloading; please retry.");
  }
  return { id: fileId, version: version ?? null, ...(await documents.read(data, mime, a)) };
}

export const drive: App = {
  name: "drive",
  tools: driveTools,
  configured: () => false,
  async run(ctx, name, args) {
    const api = googleApi(ctx.fetch, await ctx.token());
    if (name === "drive_search") return jsonOutput(await search(api, args));
    if (name === "drive_read_file") return jsonOutput(await readFile(api, args));
    if (name === "drive_extract_document") {
      const documents = ctx.services.documents;
      if (!documents) throw new AppError("This server cannot turn documents into text");
      return jsonOutput(await extractDocument(api, args, documents));
    }
    throw new AppError("Unknown tool");
  },
};
