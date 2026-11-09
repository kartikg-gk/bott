import { AppError, bearer, type Fetch, type Params, type RequestOptions, request } from "./http.ts";

/** One path segment of a Google resource ID, escaped so it cannot climb out of its path. */
export function segment(value: unknown): string {
  if (typeof value !== "string" || !value || value === "." || value === "..") {
    throw new AppError("That Google resource ID is not valid");
  }
  return encodeURIComponent(value);
}

export type GoogleApi = ReturnType<typeof googleApi>;

/** A Google API caller with the account's bearer token. */
export function googleApi(fetcher: Fetch, token: string) {
  const headers = bearer(token);
  return {
    fetch: fetcher,
    headers,
    // biome-ignore lint/suspicious/noExplicitAny: Google replies are loose JSON
    call<T = any>(method: string, url: string, opts: RequestOptions = {}): Promise<T> {
      return request<T>(fetcher, method, url, {
        ...opts,
        headers: { ...headers, ...opts.headers },
      });
    },
    // biome-ignore lint/suspicious/noExplicitAny: Google replies are loose JSON
    get<T = any>(url: string, params?: Params): Promise<T> {
      return request<T>(fetcher, "GET", url, { headers, params });
    },
  };
}
