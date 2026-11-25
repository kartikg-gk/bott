import { describe, expect, it } from "vitest";
import { BrowserSession, browserUrl } from "../../src/browser/page.ts";
import { BrowserRegistry } from "../../src/browser/registry.ts";
import { BotBrowser, browserTools, describe as describePage } from "../../src/browser/tools.ts";
import { fakeCdp, scriptArg } from "../support/fakeCdp.ts";

const KEY = { accountId: "a".repeat(32), token: "tok-123" };
const owner = { account: "acct", bot: "bot-1", run: "run-1" };
const text = (out: { content: { type: string; text?: string }[] }) =>
  out.content.map((c) => c.text ?? "").join("");

function setup(key: typeof KEY | null = KEY) {
  const fake = fakeCdp();
  const registry = new BrowserRegistry({ open: fake.open, settleMs: 20, commandMs: 200 });
  const browser = new BotBrowser(registry, "acct", async () => key);
  const call = (name: string, input: unknown, run = "run-1", bot = "bot-1") =>
    browser.call(bot, run, { id: "c", name, input });
  return { fake, registry, browser, call };
}

describe("browser addresses", () => {
  it("asks for kitesurf or a kept-alive chromium on the account", () => {
    expect(browserUrl(KEY, "kitesurf")).toBe(
      `wss://api.cloudflare.com/client/v4/accounts/${KEY.accountId}/browser-run/devtools/browser?browser=kitesurf`,
    );
    expect(browserUrl(KEY, "chromium")).toMatch(/\/devtools\/browser\?keep_alive=600000$/);
  });
});

describe("browser session", () => {
  it("attaches to a page and sends the token", async () => {
    const fake = fakeCdp();
    const session = await BrowserSession.start(KEY, "kitesurf", { open: fake.open, settleMs: 20 });
    const b = fake.browsers[0];
    expect(b?.headers.Authorization).toBe("Bearer tok-123");
    expect(b?.sent.map((s) => s.method)).toEqual([
      "Target.getTargets",
      "Target.createTarget",
      "Target.attachToTarget",
      "Page.enable",
      "Runtime.enable",
    ]);
    await session.navigate("https://example.com/");
    expect(b?.sent.at(-1)).toMatchObject({ method: "Page.navigate", sessionId: "S1" });
    await session.close();
    expect(b?.closed).toBe(true);
  });

  it("closes the connection when it cannot attach", async () => {
    const fake = fakeCdp();
    fake.state.failing.add("Target.attachToTarget");
    await expect(BrowserSession.start(KEY, "kitesurf", { open: fake.open })).rejects.toThrow();
    expect(fake.browsers[0]?.closed).toBe(true);
  });

  it("gives up on a command that never answers", async () => {
    const fake = fakeCdp();
    const session = await BrowserSession.start(KEY, "kitesurf", {
      open: fake.open,
      settleMs: 10,
      commandMs: 30,
    });
    fake.state.silent.add("Page.captureScreenshot");
    await expect(session.screenshot()).rejects.toThrow(/too long/);
  });
});

describe("browser tools", () => {
  it("lists reads only when writes are left out", () => {
    expect(browserTools(false).map((t) => t.name)).toEqual(["browser_open", "browser_snapshot"]);
    const all = browserTools();
    expect(all.filter((t) => !t.readOnly).map((t) => t.name)).toEqual([
      "browser_click",
      "browser_type",
    ]);
    for (const t of all.filter((t) => !t.readOnly)) expect(t.description).toMatch(/secret/);
  });

  it("opens a page on kitesurf and describes it", async () => {
    const { fake, call } = setup();
    const out = await call("browser_open", { url: "example.com" });
    expect(out.isError).toBeFalsy();
    expect(text(out)).toContain("Engine: kitesurf");
    expect(text(out)).toContain("Address: https://example.com/");
    expect(text(out)).toContain('[1] button "Go"');
    expect(fake.browsers[0]?.url).toContain("browser=kitesurf");
  });

  it("refuses addresses that are not web pages", async () => {
    const { fake, call } = setup();
    const out = await call("browser_open", { url: "file:///etc/passwd" });
    expect(out.isError).toBe(true);
    expect(fake.browsers).toHaveLength(0);
  });

  it("says when no key is saved", async () => {
    const { call, browser } = setup(null);
    expect(await browser.available()).toBe(false);
    expect((await call("browser_open", { url: "https://x.test" })).isError).toBe(true);
  });

  it("asks for an open page before reading or acting", async () => {
    const { call } = setup();
    const out = await call("browser_snapshot", {});
    expect(out.isError).toBe(true);
    expect(text(out)).toMatch(/browser_open/);
  });

  it("reuses one browser per run and starts a fresh one on another engine", async () => {
    const { fake, call, registry } = setup();
    await call("browser_open", { url: "https://a.test" });
    await call("browser_open", { url: "https://b.test" });
    expect(fake.browsers).toHaveLength(1);
    await call("browser_open", { url: "https://b.test", engine: "chromium" });
    expect(fake.browsers).toHaveLength(2);
    expect(fake.browsers[0]?.closed).toBe(true);
    expect(fake.browsers[1]?.url).toContain("keep_alive=");
    // Leaving the engine out keeps the one in use.
    await call("browser_open", { url: "https://c.test" });
    expect(fake.browsers).toHaveLength(2);
    // Another run, or another bot, gets its own browser.
    await call("browser_open", { url: "https://a.test" }, "run-2");
    await call("browser_open", { url: "https://a.test" }, "run-1", "bot-2");
    expect(fake.browsers).toHaveLength(4);
    expect(registry.size).toBe(3);
  });

  it("clicks and types on numbered controls", async () => {
    const { fake, call } = setup();
    await call("browser_open", { url: "https://a.test" });
    const b = fake.browsers[0];
    expect((await call("browser_click", { control: 1 })).isError).toBeFalsy();
    const clicked = b?.sent.filter((s) => s.method === "Runtime.evaluate").at(-2);
    expect(clicked && scriptArg(clicked)).toMatchObject({ n: 1 });

    const typed = await call("browser_type", { control: 2, text: "cats", enter: true });
    expect(typed.isError).toBeFalsy();
    const evals = b?.sent.filter((s) => s.method === "Runtime.evaluate") ?? [];
    const filled = evals.find((s) => scriptArg(s).text === "cats");
    expect(filled && scriptArg(filled)).toMatchObject({ n: 2, replace: true });
    const keys = b?.sent.filter((s) => s.method === "Input.dispatchKeyEvent") ?? [];
    expect(keys.map((k) => k.params.type)).toEqual(["keyDown", "keyUp"]);

    await call("browser_type", { control: 2, text: "more", replace: false });
    const appended = b?.sent.filter((s) => s.method === "Runtime.evaluate").at(-2);
    expect(appended && scriptArg(appended)).toMatchObject({ replace: false });
  });

  it("sends the form another way when key input is refused", async () => {
    const { fake, call } = setup();
    await call("browser_open", { url: "https://a.test" });
    fake.state.failing.add("Input.dispatchKeyEvent");
    expect(
      (await call("browser_type", { control: 1, text: "x", enter: true })).isError,
    ).toBeFalsy();
    const evals = fake.browsers[0]?.sent.filter((s) => s.method === "Runtime.evaluate") ?? [];
    expect(
      evals.some((s) => String(s.params.expression).startsWith("(function submitFocused")),
    ).toBe(true);
  });

  it("tells the bot when a control is gone or has no such option", async () => {
    const { fake, call } = setup();
    await call("browser_open", { url: "https://a.test" });
    fake.state.act = "gone";
    expect(text(await call("browser_click", { control: 9 }))).toMatch(/new snapshot/);
    fake.state.act = "no option";
    expect(text(await call("browser_type", { control: 3, text: "Mars" }))).toMatch(/no option/);
    fake.state.act = "secret";
    expect(text(await call("browser_type", { control: 4, text: "hunter2" }))).toMatch(/live view/);
  });

  it("reports a page that would not load", async () => {
    const { fake, call } = setup();
    fake.state.navigateError = "net::ERR_NAME_NOT_RESOLVED";
    const out = await call("browser_open", { url: "https://nowhere.test" });
    expect(out.isError).toBe(true);
    expect(text(out)).toContain("ERR_NAME_NOT_RESOLVED");
  });

  it("rejects bad arguments and stopped runs", async () => {
    const { call, browser } = setup();
    expect((await call("browser_click", { control: 0 })).isError).toBe(true);
    const stopped = new AbortController();
    stopped.abort();
    const out = await browser.call(
      "bot-1",
      "run-1",
      { id: "c", name: "browser_snapshot", input: {} },
      stopped.signal,
    );
    expect(out.isError).toBe(true);
  });

  it("closes a run's browsers when the run ends", async () => {
    const { fake, call, browser, registry } = setup();
    await call("browser_open", { url: "https://a.test" });
    await call("browser_open", { url: "https://a.test" }, "run-2");
    await browser.end("run-1");
    expect(fake.browsers[0]?.closed).toBe(true);
    expect(fake.browsers[1]?.closed).toBe(false);
    expect(fake.browsers[0]?.sent.some((s) => s.method === "Browser.close")).toBe(true);
    expect(await registry.forRun("acct", "run-1")).toBeNull();
    expect(await registry.forRun("acct", "run-2")).not.toBeNull();
    await registry.closeAll();
    expect(fake.browsers[1]?.closed).toBe(true);
  });

  it("keeps runs of other accounts apart", async () => {
    const fake = fakeCdp();
    const registry = new BrowserRegistry({ open: fake.open, settleMs: 20 });
    await registry.use(owner, KEY);
    await registry.endRun("someone-else", "run-1");
    expect(await registry.forRun("acct", "run-1")).not.toBeNull();
    expect(await registry.forRun("someone-else", "run-1")).toBeNull();
  });

  it("sends page scripts that stand alone", async () => {
    const { fake, call } = setup();
    await call("browser_open", { url: "https://a.test" });
    await call("browser_click", { control: 1 });
    await call("browser_type", { control: 1, text: "x" });
    const evals = fake.browsers[0]?.sent.filter((s) => s.method === "Runtime.evaluate") ?? [];
    expect(evals.length).toBeGreaterThan(2);
    // Each parses on its own, with nothing it would need from this server's modules.
    for (const s of evals) expect(() => new Function(String(s.params.expression))).not.toThrow();
  });

  it("writes a page out with its cut-short notes", () => {
    const out = describePage({
      title: "",
      url: "https://a.test/",
      text: "",
      textCut: true,
      controls: [{ n: 1, kind: "link", label: "Home", detail: "https://a.test/" }],
      controlsCut: true,
    });
    expect(out).toContain("Title: (none)");
    expect(out).toContain("[text cut short]");
    expect(out).toContain('[1] link "Home" (https://a.test/)');
    expect(out).toContain("[more controls not listed]");
  });
});
