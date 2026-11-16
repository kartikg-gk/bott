import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "./http.ts";

export const MAX_DOCUMENT_BYTES = 8 * 1024 ** 2;
export const MAX_GMAIL_RESPONSE = 12 * 1024 ** 2;
const MAX_TEXT_BYTES = 128 * 1024;
const PAGE_CHARS = 2400;
const TIMEOUT_MS = 20000;
const ALLOWED_ENV = new Set([
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TESSDATA_PREFIX",
  "LANG",
]);

/** Runs a program with `input` on stdin and returns at most `limit` bytes of its output. */
export type Execute = (
  program: string,
  args: string[],
  input: Uint8Array,
  limit: number,
) => Promise<Buffer>;

/** Runs an extraction program with a small environment, a time limit and an output cap. */
export const execute: Execute = (program, args, input, limit) =>
  new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && ALLOWED_ENV.has(key.toUpperCase())) env[key] = value;
    }
    const child = spawn(program, args, { env, stdio: ["pipe", "pipe", "ignore"] });
    const parts: Buffer[] = [];
    let size = 0;
    let failure: AppError | undefined;
    const stop = (error: AppError) => {
      failure ??= error;
      child.kill();
    };
    const timer = setTimeout(
      () => stop(new AppError("Reading the document took too long")),
      TIMEOUT_MS,
    );
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure ??=
        error.code === "ENOENT"
          ? new AppError(`Install ${program} on the server for document extraction`)
          : new AppError("The server could not extract this document page");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) stop(new AppError("Reading the document gave more output than allowed"));
      else parts.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(input));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new AppError("The server could not extract this document page"));
      else resolve(Buffer.concat(parts));
    });
  });

function checkDimensions(width: number, height: number): void {
  if (
    !(width > 0 && width <= 6000 && height > 0 && height <= 6000) ||
    width * height > 16_000_000
  ) {
    throw new AppError("The image is too large to read text from");
  }
}

export function jpegDimensions(data: Buffer): [number, number] {
  let at = 2;
  while (at < data.length && data[at] === 0xff) {
    while (at < data.length && data[at] === 0xff) at++;
    if (at + 2 >= data.length) break;
    const marker = data[at] as number;
    const length = data.readUInt16BE(at + 1);
    if (marker === 0xda || marker === 0xd9 || length < 2 || at + 1 + length > data.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      return [data.readUInt16BE(at + 6), data.readUInt16BE(at + 4)];
    }
    at += 1 + length;
  }
  throw new AppError("Invalid or unreadable JPEG attachment");
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Which extraction a file needs, judged by its type and its first bytes together. */
export function documentKind(data: Buffer, mime: string | undefined): "pdf" | "image" {
  if (mime === "application/pdf" && data.subarray(0, 5).toString("latin1") === "%PDF-") {
    return "pdf";
  }
  if (mime === "image/png" && data.subarray(0, 8).equals(PNG)) {
    if (data.length < 24 || data.subarray(12, 16).toString("latin1") !== "IHDR") {
      throw new AppError("Invalid PNG attachment");
    }
    checkDimensions(data.readUInt32BE(16), data.readUInt32BE(20));
    return "image";
  }
  if (mime === "image/jpeg" && data[0] === 0xff && data[1] === 0xd8) {
    checkDimensions(...jpegDimensions(data));
    return "image";
  }
  throw new AppError("Only PDF, PNG and JPEG attachments can be read");
}

/** Turns PDFs and images into text with pdftotext, pdftoppm and tesseract on the server. */
export class Documents {
  private readonly cache = new Map<string, [string, string]>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly run: Execute = execute) {}

  private async slot(): Promise<() => void> {
    if (this.running >= 2) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    return () => {
      this.running--;
      this.waiting.shift()?.();
    };
  }

  private async extract(data: Buffer, kind: string, page: number): Promise<[string, string]> {
    let image = data;
    if (kind === "pdf") {
      const folder = await mkdtemp(join(tmpdir(), "bott-doc-"));
      try {
        const file = join(folder, "source.pdf");
        await writeFile(file, data, { mode: 0o600 });
        const range = ["-f", String(page), "-l", String(page)];
        const words = (
          await this.run(
            "pdftotext",
            [...range, "-layout", "-enc", "UTF-8", file, "-"],
            new Uint8Array(),
            MAX_TEXT_BYTES,
          )
        )
          .toString("utf8")
          .trim();
        if (words) return [words, "pdf-text"];
        image = await this.run(
          "pdftoppm",
          [...range, "-singlefile", "-scale-to", "1800", "-png", file],
          new Uint8Array(),
          MAX_DOCUMENT_BYTES,
        );
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    }
    const words = await this.run(
      "tesseract",
      ["stdin", "stdout", "-l", "eng"],
      image,
      MAX_TEXT_BYTES,
    );
    return [words.toString("utf8").trim(), "ocr"];
  }

  /** One page of a document's text, from `offset`, with where the next page starts. */
  async read(
    bytes: Uint8Array,
    mime: string | undefined,
    args: { page?: number; offset?: number },
  ): Promise<Record<string, unknown>> {
    const data = Buffer.from(bytes);
    if (data.length > MAX_DOCUMENT_BYTES) throw new AppError("The attachment is larger than 8 MiB");
    const kind = documentKind(data, mime);
    const page = args.page ?? 1;
    const start = args.offset ?? 0;
    if (!(page >= 1 && page <= 100) || (kind === "image" && page !== 1)) {
      throw new AppError("Pick page 1 for an image, or a PDF page between 1 and 100");
    }
    const key = `${createHash("sha256").update(data).digest("hex")}:${kind}:${page}`;
    const release = await this.slot();
    let result: [string, string];
    try {
      result = this.cache.get(key) ?? (await this.extract(data, kind, page));
      this.cache.delete(key);
      this.cache.set(key, result);
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value as string);
    } finally {
      release();
    }
    const [text, method] = result;
    if (start < 0 || start > text.length) {
      throw new AppError("That offset is past the end of the page text");
    }
    const end = start + PAGE_CHARS;
    return {
      page,
      method,
      markdown: text.slice(start, end),
      nextOffset: end < text.length ? end : null,
    };
  }
}
