import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The environment variable holding the key that seals stored credentials. */
export const MASTER_KEY_VARIABLE = "BOTT_MASTER_KEY";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** A sealed value could not be opened: wrong key, wrong owner or a damaged row. */
export class SealError extends Error {
  override name = "SealError";
}

/**
 * The 32-byte master key, written as padded base64 in either alphabet. Anything else is refused
 * before a single credential is read or written.
 */
export function masterKey(env: Record<string, string | undefined> = process.env): Buffer {
  const encoded = env[MASTER_KEY_VARIABLE] ?? "";
  if (/^[A-Za-z0-9+/_-]{43}=$/.test(encoded)) {
    const key = Buffer.from(encoded.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    if (key.length === 32) return key;
  }
  throw new Error(`${MASTER_KEY_VARIABLE} must encode 32 random bytes as base64`);
}

/** A JSON string with every character outside printable ASCII written as \uXXXX. */
function asciiString(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * What a sealed value is bound to. The exact bytes matter: rows already stored were sealed with
 * a JSON list separated by ", " and escaped to ASCII, so the same layout is produced here.
 */
export function associatedData(realm: string, account: string, kind: string, name: string): Buffer {
  return Buffer.from(`[${[realm, account, kind, name].map(asciiString).join(", ")}]`, "utf8");
}

/** AES-256-GCM with a fresh 12-byte nonce in front of the ciphertext and its tag. */
export class Sealer {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("A sealing key must be 32 bytes");
  }

  seal(value: string, bound: Buffer): Uint8Array {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(bound);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return new Uint8Array(Buffer.concat([nonce, body, cipher.getAuthTag()]));
  }

  open(sealed: Uint8Array, bound: Buffer): string {
    if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new SealError("Sealed value is too short");
    const bytes = Buffer.from(sealed);
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, NONCE_BYTES));
    decipher.setAAD(bound);
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    try {
      const plain = Buffer.concat([
        decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)),
        decipher.final(),
      ]);
      return new TextDecoder("utf-8", { fatal: true }).decode(plain);
    } catch {
      throw new SealError("Sealed value could not be opened");
    }
  }
}
