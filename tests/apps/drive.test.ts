import { describe, expect, it } from "vitest";
import { OAUTH_APPS } from "../../src/apps/connections.ts";
import { drive, unfinishedTail } from "../../src/apps/drive.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { fakeFetch, json, type Seen } from "../support/fakeFetch.ts";

const API = "https://www.googleapis.com/drive/v3/files";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));

/** Serves a file's bytes honouring byte ranges, as Drive does. */
function ranged(bytes: Buffer) {
  return (req: Seen) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
    if (!match) return new Response(new Uint8Array(bytes));
    const start = Number(match[1]);
    if (start >= bytes.length) return new Response(null, { status: 416 });
    const end = Math.min(Number(match[2]), bytes.length - 1);
    return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${bytes.length}` },
    });
  };
}

function account(routes: Parameters<typeof fakeFetch>[0]) {
  const fetcher = fakeFetch(routes);
  const apps = new AppRunner({
    fetch: fetcher,
    env: {},
    accessToken: async () => "drive-token",
    available: async () => true,
  });
  return { fetcher, apps };
}

describe("drive", () => {
  it("is a read-only account app", () => {
    expect(APPS.drive).toBe(drive);
    expect(OAUTH_APPS.drive?.scopes).toEqual(["https://www.googleapis.com/auth/drive.readonly"]);
    expect(drive.tools.every((t) => t.readOnly)).toBe(true);
  });

  it("searches without trashed files", async () => {
    const { fetcher, apps } = account({ [`GET ${API}`]: () => json({ files: [] }) });
    await apps.run("drive_search", { query: "name contains 'plan'", drive_id: "d1" });
    const q = fetcher.seen[0]?.url.searchParams;
    expect(q?.get("q")).toBe("trashed = false and (name contains 'plan')");
    expect(q?.get("corpora")).toBe("drive");
    expect(q?.get("driveId")).toBe("d1");
  });

  it("pages an uploaded file by byte range and keeps characters whole", async () => {
    const bytes = Buffer.from(`${"a".repeat(2499)}é${"b".repeat(100)}`);
    let version = "5";
    const { apps } = account({
      [`GET ${API}/f1`]: (req) =>
        req.url.searchParams.get("alt") === "media"
          ? ranged(bytes)(req)
          : json({ id: "f1", name: "a.txt", mimeType: "text/plain", version, size: bytes.length }),
    });
    const first = parse(await apps.run("drive_read_file", { file_id: "f1" }));
    expect(first.content).toBe("a".repeat(2499));
    expect(first.nextOffset).toBe(2499);
    expect(first.version).toBe("5");
    await expect(apps.run("drive_read_file", { file_id: "f1", offset: 2499 })).rejects.toThrow(
      "pass the version that the first page gave",
    );
    const second = parse(
      await apps.run("drive_read_file", { file_id: "f1", offset: 2499, version: "5" }),
    );
    expect(second.content).toBe(`é${"b".repeat(100)}`);
    expect(second.nextOffset).toBeNull();
    const binary = parse(
      await apps.run("drive_read_file", {
        file_id: "f1",
        format: "base64",
        offset: 2499,
        version: "5",
      }),
    );
    expect(Buffer.from(binary.content, "base64").toString()).toBe(`é${"b".repeat(100)}`);
    version = "6";
    await expect(
      apps.run("drive_read_file", { file_id: "f1", offset: 2499, version: "5" }),
    ).rejects.toThrow("The file has changed since; start again at byte zero to read the new one.");
    await expect(
      apps.run("drive_read_file", { file_id: "f1", offset: 99999, version: "6" }),
    ).rejects.toThrow("That offset is past the end of the file");
  });

  it("exports Google files and refuses what cannot be read", async () => {
    const { fetcher, apps } = account({
      [`GET ${API}/doc`]: () =>
        json({ id: "doc", mimeType: "application/vnd.google-apps.document", version: "1" }),
      [`GET ${API}/doc/export`]: () => new Response("Doc text"),
      [`GET ${API}/form`]: () => json({ id: "form", mimeType: "application/vnd.google-apps.form" }),
      [`GET ${API}/locked`]: () =>
        json({ id: "locked", mimeType: "text/plain", capabilities: { canDownload: false } }),
      [`GET ${API}/link`]: () =>
        json({
          mimeType: "application/vnd.google-apps.shortcut",
          shortcutDetails: { targetId: "t" },
        }),
    });
    expect(parse(await apps.run("drive_read_file", { file_id: "doc" }))).toMatchObject({
      mimeType: "text/plain",
      content: "Doc text",
      nextOffset: null,
    });
    expect(fetcher.seen.at(-1)?.url.searchParams.get("mimeType")).toBe("text/plain");
    await expect(apps.run("drive_read_file", { file_id: "form" })).rejects.toThrow(
      "There is no standard export for this kind of Google file",
    );
    await expect(apps.run("drive_read_file", { file_id: "locked" })).rejects.toThrow(
      "Drive does not let this file be downloaded",
    );
    expect(parse(await apps.run("drive_read_file", { file_id: "link" }))).toEqual({
      shortcut: "t",
    });
    await expect(apps.run("drive_read_file", { file_id: ".." })).rejects.toThrow(
      "That Google resource ID is not valid",
    );
  });

  it("finds an unfinished character at the end of a page", () => {
    const e = Buffer.from("é");
    expect(unfinishedTail(Buffer.from("abc"))).toBe(0);
    expect(unfinishedTail(Buffer.concat([Buffer.from("a"), e]))).toBe(0);
    expect(unfinishedTail(Buffer.concat([Buffer.from("a"), e.subarray(0, 1)]))).toBe(1);
    expect(unfinishedTail(Buffer.from("€").subarray(0, 2))).toBe(2);
  });
});
