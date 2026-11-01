import { describe, expect, it } from "vitest";
import { gmail, mailMessage, rawMessage } from "../../src/apps/gmail.ts";
import { UNTRUSTED } from "../../src/apps/http.ts";
import { APPS, AppRunner } from "../../src/apps/registry.ts";
import { fakeFetch, json, status } from "../support/fakeFetch.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN = "https://oauth2.googleapis.com/token";
const parse = (out: string) => JSON.parse(out.slice(UNTRUSTED.length));
const b64 = (text: string) => Buffer.from(text).toString("base64url");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
const ENV = {
  BOTT_GMAIL_CLIENT_ID: "id",
  BOTT_GMAIL_CLIENT_SECRET: "secret",
  BOTT_GMAIL_REFRESH_TOKEN: "refresh",
};

const message = {
  id: "m1",
  threadId: "t1",
  snippet: "snip",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "ana@example.com" },
      { name: "Subject", value: "Plans" },
      { name: "X-Other", value: "dropped" },
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64("Hello there") } },
      {
        mimeType: "text/csv",
        filename: "a.csv",
        body: { attachmentId: "att1", size: 11 },
      },
      { mimeType: "image/png", filename: "p.png", body: { data: png.toString("base64url") } },
    ],
  },
};

function server(extra: Parameters<typeof fakeFetch>[0] = {}) {
  return fakeFetch({
    [`POST ${TOKEN}`]: () => json({ access_token: "access-1", expires_in: 3600 }),
    [`GET ${API}/messages/m1`]: () => json(message),
    ...extra,
  });
}

describe("gmail", () => {
  it("needs the client and refresh token on the server", async () => {
    expect(APPS.gmail).toBe(gmail);
    expect(await new AppRunner({ env: {} }).configured("gmail")).toBe(false);
    expect(await new AppRunner({ env: ENV }).configured("gmail")).toBe(true);
    const flags = Object.fromEntries(gmail.tools.map((t) => [t.name, [t.readOnly, t.review]]));
    expect(flags.gmail_send).toEqual([false, true]);
    expect(flags.gmail_modify_labels).toEqual([false, true]);
    expect(flags.gmail_create_draft).toEqual([false, false]);
    expect(flags.gmail_read).toEqual([true, false]);
  });

  it("renews access with the refresh token and searches", async () => {
    const fetcher = server({
      [`GET ${API}/messages`]: () => json({ messages: [{ id: "a" }, { id: "b" }] }),
    });
    const apps = new AppRunner({ fetch: fetcher, env: ENV });
    expect(await apps.run("gmail_search", { query: "from:ana" })).toBe("a\nb");
    expect(fetcher.seen[0]?.form.get("grant_type")).toBe("refresh_token");
    expect(fetcher.seen[0]?.form.get("refresh_token")).toBe("refresh");
    expect(fetcher.seen[1]?.headers.get("authorization")).toBe("Bearer access-1");
    expect(fetcher.seen[1]?.url.searchParams.get("q")).toBe("from:ana");
    expect(fetcher.seen[1]?.url.searchParams.get("maxResults")).toBe("20");
  });

  it("reads a message's text, wanted headers and attachment parts", async () => {
    const apps = new AppRunner({ fetch: server(), env: ENV });
    expect(parse(await apps.run("gmail_read", { id: "m1" }))).toEqual({
      id: "m1",
      threadId: "t1",
      headers: { From: "ana@example.com", Subject: "Plans" },
      text: "Hello there",
      attachments: [
        { part: "0.1", filename: "a.csv", mimeType: "text/csv", size: 11 },
        { part: "0.2", filename: "p.png", mimeType: "image/png", size: null },
      ],
    });
    expect(mailMessage({ id: "x", payload: {}, snippet: "only" }).text).toBe("only");
    await expect(apps.run("gmail_read", { id: "../x" })).rejects.toThrow("Invalid Gmail ID");
  });

  it("pages threads five messages at a time", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...message, id: `m${i}` }));
    const apps = new AppRunner({
      fetch: server({ [`GET ${API}/threads/t1`]: () => json({ id: "t1", messages: many }) }),
      env: ENV,
    });
    const first = parse(await apps.run("gmail_read_thread", { id: "t1" }));
    expect(first.messages.map((m: { id: string }) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(first.nextOffset).toBe(5);
    const second = parse(await apps.run("gmail_read_thread", { id: "t1", offset: 5 }));
    expect(second.messages).toHaveLength(2);
    expect(second.nextOffset).toBeNull();
  });

  it("reads attachments as text or base64 a page at a time", async () => {
    const apps = new AppRunner({
      fetch: server({
        [`GET ${API}/messages/m1/attachments/att1`]: () => json({ data: b64("a,b\n1,2\n3,4") }),
      }),
      env: ENV,
    });
    expect(
      parse(await apps.run("gmail_read_attachment", { message_id: "m1", part: "0.1" })),
    ).toEqual({
      filename: "a.csv",
      mimeType: "text/csv",
      size: 11,
      format: "text",
      content: "a,b\n1,2\n3,4",
      nextOffset: null,
    });
    await expect(
      apps.run("gmail_read_attachment", { message_id: "m1", part: "0.2" }),
    ).rejects.toThrow("This attachment holds binary data; read it with format base64.");
    const binary = parse(
      await apps.run("gmail_read_attachment", { message_id: "m1", part: "0.2", format: "base64" }),
    );
    expect(Buffer.from(binary.content, "base64")).toEqual(png);
    await expect(
      apps.run("gmail_read_attachment", { message_id: "m1", part: "0.0" }),
    ).rejects.toThrow("That attachment is not part of the message");
  });

  it("changes labels only with a real change", async () => {
    const fetcher = server({
      [`POST ${API}/threads/t1/modify`]: () => json({}),
      [`POST ${API}/messages/m2/modify`]: () => status(403),
      [`GET ${API}/labels`]: () => json({ labels: [{ id: "L1", name: "Work" }] }),
    });
    const apps = new AppRunner({ fetch: fetcher, env: ENV });
    expect(parse(await apps.run("gmail_list_labels", {}))).toEqual([{ id: "L1", name: "Work" }]);
    expect(await apps.run("gmail_modify_labels", { id: "t1", target: "thread", add: ["L1"] })).toBe(
      "Gmail labels updated.",
    );
    expect(fetcher.seen.at(-1)?.json).toEqual({ addLabelIds: ["L1"], removeLabelIds: [] });
    await expect(
      apps.run("gmail_modify_labels", { id: "t1", add: ["L1"], remove: ["L1"] }),
    ).rejects.toThrow("Give at least one label to change");
    await expect(apps.run("gmail_modify_labels", { id: "m2", add: ["L1"] })).rejects.toThrow(
      "Gmail refused the label change; check permissions or connect Gmail again in Apps.",
    );
  });

  it("drafts without sending and sends only through the send tool", async () => {
    const fetcher = server({
      [`POST ${API}/drafts`]: () => json({ id: "d1" }),
      [`POST ${API}/messages/send`]: () => json({ id: "s1" }),
    });
    const apps = new AppRunner({ fetch: fetcher, env: ENV });
    const mail = { to: "bo@example.com", subject: "Hi", body: "Line one" };
    expect(await apps.run("gmail_create_draft", mail)).toBe("The draft is saved and has not been sent.");
    const draft = fetcher.seen.at(-1)?.json;
    const raw = Buffer.from(draft.message.raw, "base64url").toString();
    expect(raw).toContain("To: bo@example.com\r\n");
    expect(raw).toContain("Subject: Hi\r\n");
    expect(parse(await apps.run("gmail_send", mail))).toEqual({ sent: true, id: "s1" });
    expect(fetcher.seen.at(-1)?.json.raw).toBeTypeOf("string");
  });

  it("builds plain text mail that headers cannot be injected into", () => {
    const raw = Buffer.from(
      rawMessage({ to: "a@example.com", subject: "Grüße", body: "Hallo Welt ✓" }),
      "base64url",
    ).toString();
    const [head, body] = raw.split("\r\n\r\n");
    expect(head).toContain("Subject: =?utf-8?B?");
    expect(head).toContain('Content-Type: text/plain; charset="utf-8"');
    expect(Buffer.from(body?.replaceAll("\r\n", "") ?? "", "base64").toString()).toBe(
      "Hallo Welt ✓",
    );
    expect(() => rawMessage({ to: "a@example.com\r\nBcc: x@y.z", subject: "s", body: "" })).toThrow(
      "one line",
    );
  });

  it("uses the account's connection when signed in", async () => {
    const fetcher = server();
    const apps = new AppRunner({
      fetch: fetcher,
      env: {},
      accessToken: async () => "account-token",
      available: async () => true,
    });
    await apps.run("gmail_read", { id: "m1" });
    expect(fetcher.seen).toHaveLength(1);
    expect(fetcher.seen[0]?.headers.get("authorization")).toBe("Bearer account-token");
  });
});
