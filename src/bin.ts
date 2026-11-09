#!/usr/bin/env node
/** The installed `bott` command: settings from the environment and ./.env, Ctrl+C to stop. */

import { existsSync } from "node:fs";
import { main } from "./cli.ts";

// Values already in the environment win over the file.
if (existsSync(".env")) process.loadEnvFile(".env");

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => stop.abort());
}

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  out: (line) => console.log(line),
  signal: stop.signal,
  stdin: async () => {
    const parts: Buffer[] = [];
    for await (const part of process.stdin) parts.push(part as Buffer);
    return Buffer.concat(parts).toString("utf8");
  },
});
