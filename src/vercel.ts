/**
 * The hosted function. It builds the server from the deployment's environment on the first
 * request and keeps it for the requests that follow on the same instance. Scheduled work is not
 * done here: `bott runner` owns it in a process of its own.
 */

import { readConfig } from "./config.ts";
import { type Server, startServer } from "./startup.ts";

let started: Promise<Server> | undefined;

function server(): Promise<Server> {
  if (!started) {
    started = startServer(readConfig(process.env));
    // A failed start is tried again on the next request, after the settings are fixed.
    started.catch(() => {
      started = undefined;
    });
  }
  return started;
}

/** Answers one request; a server that cannot start says so without details. */
export async function handle(request: Request): Promise<Response> {
  let ready: Server;
  try {
    ready = await server();
  } catch (error) {
    // Setting errors name the variable, never its value, so the log can carry them.
    console.error(`The server could not start: ${(error as Error).message}`);
    return Response.json({ error: "This server is not set up correctly" }, { status: 500 });
  }
  return ready.handler(request);
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
