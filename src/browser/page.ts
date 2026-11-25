import { CdpClient, CdpError, type SocketOpener } from "./cdp.ts";

/**
 * Which browser Cloudflare Browser Run starts. Kitesurf is light and starts fast; Chromium is a
 * full browser kept alive between commands, for sites Kitesurf cannot handle and for when the
 * person wants to take over through Live View or DevTools.
 */
export type Engine = "kitesurf" | "chromium";
export const ENGINES: readonly Engine[] = ["kitesurf", "chromium"];

/** An account's Browser Run key: the Cloudflare account it bills and an API token. */
export interface BrowserKey {
  accountId: string;
  token: string;
}

export const API_BASE = "https://api.cloudflare.com/client/v4";
/** How long Chromium stays up with no command, in milliseconds; Cloudflare allows up to 20 minutes. */
export const CHROMIUM_KEEP_ALIVE_MS = 600_000;

/** Where a new browser of `engine` is acquired. */
export function browserUrl(key: BrowserKey, engine: Engine): string {
  const base = `${API_BASE.replace(/^https:/, "wss:")}/accounts/${encodeURIComponent(key.accountId)}/browser-run/devtools/browser`;
  return engine === "kitesurf"
    ? `${base}?browser=kitesurf`
    : `${base}?keep_alive=${CHROMIUM_KEEP_ALIVE_MS}`;
}

/** Most characters of page text a snapshot holds. */
export const TEXT_LIMIT = 8000;
/** Most numbered controls a snapshot lists. */
export const CONTROL_LIMIT = 150;
const LABEL_LIMIT = 80;
/** The attribute the snapshot leaves on each numbered control, so later calls can find it. */
const MARK = "data-bott-n";

export interface Control {
  n: number;
  /** The element's role in plain words: link, button, text box, select and so on. */
  kind: string;
  label: string;
  /** A link's target, or a select's current choice and options. */
  detail?: string;
}

export interface Snapshot {
  title: string;
  url: string;
  text: string;
  /** True when the page held more text than `text` shows. */
  textCut: boolean;
  controls: Control[];
  /** True when there were more controls than are listed. */
  controlsCut: boolean;
}

/**
 * Runs in the page. Numbers the controls a person could use, newest numbers replacing old ones,
 * and gathers the visible text. A password field's value is never read.
 */
function gather(opts: { mark: string; text: number; controls: number; label: number }) {
  const clip = (s: string, n: number) => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
  };
  // The text a person sees, line breaks and all; textContent would add hidden text.
  // biome-ignore lint/performance/useDomNodeTextContent: rendered text is what is wanted here
  const shown = (node: HTMLElement) => node.innerText || node.textContent || "";
  for (const old of Array.from(document.querySelectorAll(`[${opts.mark}]`))) {
    old.removeAttribute(opts.mark);
  }
  const query =
    "a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox]," +
    "[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[contenteditable=true]";
  const found = Array.from(document.querySelectorAll(query)) as HTMLElement[];
  const usable = found.filter((el) => {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    const rects = typeof el.getClientRects === "function" ? el.getClientRects() : null;
    // A page without layout reports no boxes at all; only skip when others have boxes.
    return rects === null || rects.length > 0 || document.body.getClientRects().length === 0;
  });
  const controls: { n: number; kind: string; label: string; detail?: string }[] = [];
  for (const el of usable.slice(0, opts.controls)) {
    const n = controls.length + 1;
    el.setAttribute(opts.mark, String(n));
    const tag = el.tagName.toLowerCase();
    let kind = el.getAttribute("role") ?? tag;
    let detail: string | undefined;
    if (tag === "a") {
      kind = "link";
      detail = clip((el as HTMLAnchorElement).href, 120);
    } else if (el instanceof HTMLInputElement) {
      kind = el.type === "password" ? "password box" : `${el.type} box`;
      if (el.type === "checkbox" || el.type === "radio")
        detail = el.checked ? "checked" : "unchecked";
      else if (el.type !== "password" && el.value) detail = `holds "${clip(el.value, 40)}"`;
    } else if (el instanceof HTMLSelectElement) {
      kind = "select";
      const options = Array.from(el.options).map((o) => clip(o.text, 30));
      detail = `chosen "${clip(el.selectedOptions[0]?.text ?? "", 30)}"; options: ${options.slice(0, 15).join(" | ")}`;
    } else if (tag === "textarea") {
      kind = "text area";
    } else if (el.isContentEditable) {
      kind = "editable text";
    }
    const named =
      el.getAttribute("aria-label") ||
      (el instanceof HTMLInputElement && ["submit", "button"].includes(el.type) ? el.value : "") ||
      shown(el) ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.getAttribute("name") ||
      el.getAttribute("alt") ||
      "";
    const control: { n: number; kind: string; label: string; detail?: string } = {
      n,
      kind,
      label: clip(named, opts.label),
    };
    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
      if (el.disabled) detail = detail ? `${detail}; disabled` : "disabled";
    }
    if (detail) control.detail = detail;
    controls.push(control);
  }
  const body = document.body ? shown(document.body) : "";
  const text = body
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    title: document.title,
    url: location.href,
    text: text.slice(0, opts.text),
    textCut: text.length > opts.text,
    controls,
    controlsCut: usable.length > opts.controls,
  };
}

/** Runs in the page. Clicks the numbered control, or says it is gone. */
function press(opts: { mark: string; n: number }) {
  const el = document.querySelector(`[${opts.mark}="${opts.n}"]`) as HTMLElement | null;
  if (!el) return "gone";
  el.scrollIntoView?.({ block: "center" });
  el.focus?.();
  el.click();
  return "ok";
}

/**
 * Runs in the page. Puts text into the numbered control: a select picks the option whose value
 * or shown text matches, a box gets the text in place of what it held or after it.
 */
function fill(opts: { mark: string; n: number; text: string; replace: boolean }) {
  const el = document.querySelector(`[${opts.mark}="${opts.n}"]`) as HTMLElement | null;
  if (!el) return "gone";
  el.scrollIntoView?.({ block: "center" });
  el.focus?.();
  const fire = (name: string) => el.dispatchEvent(new Event(name, { bubbles: true }));
  if (el instanceof HTMLSelectElement) {
    const wanted = opts.text.trim().toLowerCase();
    const option = Array.from(el.options).find(
      (o) => o.value.toLowerCase() === wanted || o.text.trim().toLowerCase() === wanted,
    );
    if (!option) return "no option";
    el.value = option.value;
    fire("input");
    fire("change");
    return "ok";
  }
  if (el instanceof HTMLInputElement && el.type === "password") return "secret";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const next = opts.replace ? opts.text : el.value + opts.text;
    // Frameworks watch the prototype's setter, so set the value through it.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, next);
    else el.value = next;
    fire("input");
    fire("change");
    return "ok";
  }
  if (el.isContentEditable) {
    el.textContent = opts.replace ? opts.text : (el.textContent ?? "") + opts.text;
    fire("input");
    return "ok";
  }
  return "not typable";
}

/** Runs in the page. Submits the form around the focused element, when there is one. */
function submitFocused() {
  const el = document.activeElement as HTMLInputElement | null;
  const form = el?.form;
  if (!form) return "no form";
  if (typeof form.requestSubmit === "function") form.requestSubmit();
  else form.submit();
  return "ok";
}

/** The expression that calls `fn` in the page with `arg`. */
function call(fn: (arg: never) => unknown, arg: unknown): string {
  return `(${fn.toString()})(${JSON.stringify(arg)})`;
}

/** A page the bot asked for something the page cannot give. */
export class PageRefused extends Error {}

export interface BrowserSessionOptions {
  open: SocketOpener;
  /** How long to wait for a page to finish loading after a change, in milliseconds. */
  settleMs?: number;
  /** How long one protocol command may take, in milliseconds. */
  commandMs?: number;
}

/** One remote browser with one page the bot works in. */
export class BrowserSession {
  private constructor(
    readonly engine: Engine,
    private readonly cdp: CdpClient,
    private readonly page: string,
    private readonly settleMs: number,
  ) {}

  /** Acquires a browser of `engine` and attaches to a page in it. */
  static async start(
    key: BrowserKey,
    engine: Engine,
    opts: BrowserSessionOptions,
  ): Promise<BrowserSession> {
    const cdp = await CdpClient.connect(
      opts.open,
      browserUrl(key, engine),
      { Authorization: `Bearer ${key.token}` },
      opts.commandMs,
    );
    try {
      const listed = await cdp.send("Target.getTargets");
      const infos = (listed.targetInfos ?? []) as { targetId: string; type: string }[];
      let target = infos.find((t) => t.type === "page")?.targetId;
      if (!target) {
        const made = await cdp.send("Target.createTarget", { url: "about:blank" });
        target = made.targetId as string;
      }
      const attached = await cdp.send("Target.attachToTarget", { targetId: target, flatten: true });
      const page = attached.sessionId as string;
      await cdp.send("Page.enable", {}, page);
      await cdp.send("Runtime.enable", {}, page);
      return new BrowserSession(engine, cdp, page, opts.settleMs ?? 5000);
    } catch (error) {
      cdp.close();
      throw error;
    }
  }

  get closed(): boolean {
    return this.cdp.closed;
  }

  /** Goes to `url` and waits for it to load, or for the wait to run out. */
  async navigate(url: string): Promise<void> {
    const loaded = this.cdp.waitFor("Page.loadEventFired", this.page, this.settleMs);
    const result = await this.cdp.send("Page.navigate", { url }, this.page);
    if (typeof result.errorText === "string" && result.errorText) {
      throw new PageRefused(`The page could not be opened: ${result.errorText}`);
    }
    await loaded;
  }

  async snapshot(): Promise<Snapshot> {
    return (await this.evaluate(
      call(gather, { mark: MARK, text: TEXT_LIMIT, controls: CONTROL_LIMIT, label: LABEL_LIMIT }),
    )) as Snapshot;
  }

  /** Clicks control `n` from the latest snapshot. */
  async click(n: number): Promise<void> {
    const loaded = this.cdp.waitFor("Page.loadEventFired", this.page, this.settleMs);
    const said = await this.evaluate(call(press, { mark: MARK, n }));
    if (said === "gone") throw new PageRefused(gone(n));
    await Promise.race([loaded, pause(Math.min(this.settleMs, 1000))]);
  }

  /** Types into control `n`, then presses Enter when asked. */
  async type(n: number, text: string, opts: { replace: boolean; enter: boolean }): Promise<void> {
    const said = await this.evaluate(call(fill, { mark: MARK, n, text, replace: opts.replace }));
    if (said === "gone") throw new PageRefused(gone(n));
    if (said === "no option") throw new PageRefused(`Control ${n} has no option "${text}".`);
    if (said === "secret") {
      throw new PageRefused(
        `Control ${n} is a password box. Ask the person to type it themselves in the live view.`,
      );
    }
    if (said === "not typable") throw new PageRefused(`Control ${n} does not take text.`);
    if (!opts.enter) return;
    const loaded = this.cdp.waitFor("Page.loadEventFired", this.page, this.settleMs);
    try {
      for (const type of ["keyDown", "keyUp"]) {
        await this.cdp.send(
          "Input.dispatchKeyEvent",
          {
            type,
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            ...(type === "keyDown" ? { text: "\r" } : {}),
          },
          this.page,
        );
      }
    } catch (error) {
      // A browser without key input still gets the form sent.
      if (!(error instanceof CdpError)) throw error;
      await this.evaluate(call(submitFocused, null));
    }
    await Promise.race([loaded, pause(Math.min(this.settleMs, 1000))]);
  }

  /** A JPEG of what the page shows now, base64 encoded. */
  async screenshot(): Promise<string> {
    const shot = await this.cdp.send(
      "Page.captureScreenshot",
      { format: "jpeg", quality: 70 },
      this.page,
    );
    return shot.data as string;
  }

  /** A Live View link to this page; Cloudflare offers it for Chromium browsers. */
  async liveView(mode: "tab" | "devtools" | "full", expiresInMs: number): Promise<string> {
    const made = await this.cdp.send("Cloudflare.getLiveView", { mode, expiresInMs }, this.page);
    if (typeof made.devtoolsFrontendUrl !== "string") {
      throw new PageRefused("Cloudflare gave no Live View link");
    }
    return made.devtoolsFrontendUrl;
  }

  /** Ends the browser so it stops counting against the account. */
  async close(): Promise<void> {
    if (this.cdp.closed) return;
    await this.cdp.send("Browser.close").catch(() => {});
    this.cdp.close();
  }

  private async evaluate(expression: string): Promise<unknown> {
    const result = await this.cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.page,
    );
    const thrown = result.exceptionDetails as { text?: string } | undefined;
    if (thrown) throw new PageRefused("The page threw an error while being read");
    return (result.result as { value?: unknown } | undefined)?.value;
  }
}

const gone = (n: number) =>
  `Control ${n} is no longer on the page. Take a new snapshot and use its numbers.`;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
