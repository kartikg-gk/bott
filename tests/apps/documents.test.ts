import { describe, expect, it } from "vitest";
import { Documents, documentKind, type Execute, execute } from "../../src/apps/documents.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { AppRunner } from "../../src/apps/registry.ts";
import { fakeFetch, json } from "../support/fakeFetch.ts";

const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));
const pdf = Buffer.from("%PDF-1.7 fake");

function png(width: number, height: number): Buffer {
  const data = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(data);
  data.write("IHDR", 12, "latin1");
  data.writeUInt32BE(width, 16);
  data.writeUInt32BE(height, 20);
  return data;
}

function jpeg(width: number, height: number): Buffer {
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, Buffer.alloc(12)]);
}

/** Pretends to be the extraction programs and records what ran. */
function programs(outputs: Record<string, string>) {
  const ran: { program: string; args: string[]; input: number }[] = [];
  const run: Execute = async (program, args, input) => {
    ran.push({ program, args, input: input.length });
    return Buffer.from(outputs[program] ?? "");
  };
  return { ran, run };
}

describe("documents", () => {
  it("recognises files by type and first bytes together", () => {
    expect(documentKind(pdf, "application/pdf")).toBe("pdf");
    expect(documentKind(png(100, 100), "image/png")).toBe("image");
    expect(documentKind(jpeg(640, 480), "image/jpeg")).toBe("image");
    expect(() => documentKind(pdf, "image/png")).toThrow("Only PDF, PNG and JPEG files");
    expect(() => documentKind(png(7000, 10), "image/png")).toThrow("too large in width or height");
    expect(() => documentKind(jpeg(5000, 5000), "image/jpeg")).toThrow("too large in width or height");
  });

  it("uses the PDF's own text first and pages it", async () => {
    const { ran, run } = programs({ pdftotext: `  ${"w".repeat(3000)}  ` });
    const documents = new Documents(run);
    const first = await documents.read(pdf, "application/pdf", { page: 2 });
    expect(first).toEqual({
      page: 2,
      method: "pdf-text",
      markdown: "w".repeat(2400),
      nextOffset: 2400,
    });
    expect(ran[0]?.program).toBe("pdftotext");
    expect(ran[0]?.args.slice(0, 4)).toEqual(["-f", "2", "-l", "2"]);
    const next = await documents.read(pdf, "application/pdf", { page: 2, offset: 2400 });
    expect(next.markdown).toHaveLength(600);
    expect(ran).toHaveLength(1);
    await expect(documents.read(pdf, "application/pdf", { page: 2, offset: 9999 })).rejects.toThrow(
      "That offset is past the end of the page's text",
    );
  });

  it("falls back to OCR for scanned PDFs and reads images with OCR", async () => {
    const { ran, run } = programs({ pdftoppm: "PNGDATA", tesseract: "scanned words\n" });
    const documents = new Documents(run);
    expect(await documents.read(pdf, "application/pdf", {})).toMatchObject({
      method: "ocr",
      markdown: "scanned words",
    });
    expect(ran.map((r) => r.program)).toEqual(["pdftotext", "pdftoppm", "tesseract"]);
    expect(ran[2]?.input).toBe(7);
    await expect(documents.read(png(10, 10), "image/png", { page: 2 })).rejects.toThrow(
      "An image has only page 1",
    );
  });

  it("names a missing program", async () => {
    await expect(execute("bott-no-such-program", [], new Uint8Array(), 10)).rejects.toThrow(
      "Install bott-no-such-program on the server for document extraction",
    );
  });

  it("extracts Gmail attachments and Drive files on the server", async () => {
    const { run } = programs({ pdftotext: "invoice total" });
    const gmail = "https://gmail.googleapis.com/gmail/v1/users/me";
    const drive = "https://www.googleapis.com/drive/v3/files";
    const fetcher = fakeFetch({
      [`GET ${gmail}/messages/m1`]: () =>
        json({
          payload: {
            parts: [
              {
                filename: "a.pdf",
                mimeType: "application/pdf",
                body: { attachmentId: "x1", size: 13 },
              },
              {
                filename: "big.pdf",
                mimeType: "application/pdf",
                body: { attachmentId: "x2", size: 9e6 },
              },
            ],
          },
        }),
      [`GET ${gmail}/messages/m1/attachments/x1`]: () => json({ data: pdf.toString("base64url") }),
      [`GET ${drive}/f1`]: (req) =>
        req.url.searchParams.get("alt") === "media"
          ? new Response(new Uint8Array(pdf), {
              status: 206,
              headers: { "content-range": `bytes 0-${pdf.length - 1}/${pdf.length}` },
            })
          : json({ id: "f1", mimeType: "application/pdf", version: "3", size: pdf.length }),
    });
    const apps = new AppRunner({
      fetch: fetcher,
      env: {},
      accessToken: async () => "t",
      available: async () => true,
      services: { documents: new Documents(run) },
    });
    expect(
      parse(await apps.run("gmail_extract_attachment", { message_id: "m1", part: "0.0" })),
    ).toEqual({
      filename: "a.pdf",
      page: 1,
      method: "pdf-text",
      markdown: "invoice total",
      nextOffset: null,
    });
    await expect(
      apps.run("gmail_extract_attachment", { message_id: "m1", part: "0.1" }),
    ).rejects.toThrow("Attachments over 8 MiB are not read");
    expect(parse(await apps.run("drive_extract_document", { file_id: "f1" }))).toMatchObject({
      id: "f1",
      version: "3",
      markdown: "invoice total",
    });
  });
});
