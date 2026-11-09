/** A fixed master key for tests: the bytes 0 to 31 in URL-safe base64. */
export const KEY = `${Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64url")}=`;
