/** A request the server refuses, with the status and the message the person sees. */
export class HttpError extends Error {
  override name = "HttpError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A JSON reply that browsers and proxies must not keep. */
export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
