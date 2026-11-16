import { BlockList, isIP } from "node:net";
import { AppError } from "./http.ts";

/** Addresses that are not on the public internet, or not one host. */
const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const) {
  PRIVATE.addSubnet(network, prefix, "ipv6");
}
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !PRIVATE.check(address, "ipv4");
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return publicAddress(mapped[1] as string);
    return GLOBAL_V6.check(address, "ipv6") && !PRIVATE.check(address, "ipv6");
  }
  return false;
}

const REFUSED = "Give a public http or https address with no user name or password in it";

/** The URL itself when it names a public web host; anything local or private is refused. */
export function publicUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /\s/.test(value) ||
    value.includes("\\")
  ) {
    throw new AppError(REFUSED);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(REFUSED);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new AppError(REFUSED);
  }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (!host) throw new AppError(REFUSED);
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(bare)) {
    if (!publicAddress(bare)) throw new AppError(REFUSED);
    return value;
  }
  const last = host.split(".").at(-1) ?? "";
  if (
    !host.includes(".") ||
    /^(?:[0-9]+|0x[0-9a-f]+)$/.test(last) ||
    /\.(?:localhost|local|internal)$/.test(host)
  ) {
    throw new AppError(REFUSED);
  }
  return value;
}
