import { z } from "zod";
import type { HostTool, HostToolCall } from "../agent/session.ts";
import { errorOutput, type ToolOutput } from "../agent/tools.ts";
import { CdpError, CdpGone } from "./cdp.ts";
import { type BrowserKey, ENGINES, PageRefused, type Snapshot } from "./page.ts";
import type { BrowserRegistry } from "./registry.ts";

const control = z.number().int().min(1).max(10_000);

const SCHEMAS = {
  browser_open: z
    .object({
      url: z.string().min(1).max(4096),
      engine: z.enum(ENGINES).optional(),
    })
    .strict(),
  browser_snapshot: z.object({}).strict(),
  browser_click: z.object({ control }).strict(),
  browser_type: z
    .object({
      control,
      text: z.string().max(10_000),
      replace: z.boolean().optional(),
      enter: z.boolean().optional(),
    })
    .strict(),
};

type Name = keyof typeof SCHEMAS;

export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(SCHEMAS));

const NO_SECRETS =
  " Never type a password, card number, one-time code or other secret: ask the person to " +
  "enter it themselves through the live view of this run.";

/** The browser tools; `writes` false leaves out the two that act on a page. */
export function browserTools(writes = true): HostTool[] {
  const reads: HostTool[] = [
    {
      name: "browser_open",
      description:
        "Load a web address in your own browser for this run, then describe what loaded. The " +
        "engine is kitesurf unless you choose chromium; pick chromium only when a page does " +
        "not work in kitesurf or the person wants to watch and take over. Changing engine " +
        "starts an empty browser, so sign-ins and open pages are lost.",
      input: SCHEMAS.browser_open,
      readOnly: true,
    },
    {
      name: "browser_snapshot",
      description:
        "Read the page your browser shows now: its title, address, text (cut short on long " +
        "pages) and a numbered list of links, buttons and fields. Numbers change with every " +
        "snapshot, so take a new one after the page changes.",
      input: SCHEMAS.browser_snapshot,
      readOnly: true,
    },
  ];
  if (!writes) return reads;
  return [
    ...reads,
    {
      name: "browser_click",
      description:
        "Click a numbered control from your latest snapshot, then describe the page after it." +
        NO_SECRETS,
      input: SCHEMAS.browser_click,
      readOnly: false,
    },
    {
      name: "browser_type",
      description:
        "Put text into a numbered field from your latest snapshot. By default it replaces what " +
        "the field held; set replace to false to add to the end. For a dropdown, give the " +
        "option's shown text or value. Set enter to true to press Enter afterwards, which " +
        "usually sends a form." +
        NO_SECRETS,
      input: SCHEMAS.browser_type,
      readOnly: false,
    },
  ];
}

/** What the bot reads about a page. */
export function describe(page: Snapshot): string {
  const lines = [`Title: ${page.title || "(none)"}`, `Address: ${page.url}`, "", "Text:"];
  lines.push(page.text || "(no text)");
  if (page.textCut) lines.push("[text cut short]");
  lines.push("", "Controls:");
  if (page.controls.length === 0) lines.push("(none)");
  for (const c of page.controls) {
    lines.push(`[${c.n}] ${c.kind} "${c.label}"${c.detail ? ` (${c.detail})` : ""}`);
  }
  if (page.controlsCut) lines.push("[more controls not listed]");
  return lines.join("\n");
}

export const LIVE_MODES = ["tab", "devtools", "full"] as const;
export type LiveMode = (typeof LIVE_MODES)[number];
/** How long a Live View link may wait before someone opens it. */
const LIVE_LINK_MS = 300_000;

export type LiveView =
  | { engine: "kitesurf"; image: { type: "image/jpeg"; data: string } }
  | { engine: "chromium"; mode: LiveMode; url: string; expiresInMs: number };

const say = (text: string): ToolOutput => ({ content: [{ type: "text", text }] });

/** Only web pages; a browser on Cloudflare cannot see this server's files anyway. */
function webAddress(raw: string): string | null {
  const text = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * One account's bots and their browsers. The tools are offered only while the account has a
 * Browser Run key saved; each run's browser lives in the shared registry.
 */
export class BotBrowser {
  constructor(
    private readonly registry: BrowserRegistry,
    readonly account: string,
    private readonly key: () => Promise<BrowserKey | null>,
  ) {}

  /** Whether the account has a key, so the tools can be offered. */
  async available(): Promise<boolean> {
    return (await this.key().catch(() => null)) !== null;
  }

  owns(name: string): boolean {
    return BROWSER_TOOL_NAMES.has(name);
  }

  /** Answers one browser tool for the bot in the run; failures come back as words for the bot. */
  async call(
    bot: string,
    run: string,
    call: HostToolCall,
    signal?: AbortSignal,
  ): Promise<ToolOutput> {
    if (!this.owns(call.name)) return errorOutput("Unknown tool");
    const name = call.name as Name;
    const parsed = SCHEMAS[name].safeParse(call.input);
    if (!parsed.success) return errorOutput(`Invalid arguments for ${name}.`);
    if (signal?.aborted) return errorOutput("The run was stopped.");
    const owner = { account: this.account, bot, run };
    try {
      if (name === "browser_open") {
        const args = parsed.data as z.infer<typeof SCHEMAS.browser_open>;
        const url = webAddress(args.url);
        if (!url) return errorOutput("Only http and https addresses can be opened.");
        const key = await this.key();
        if (!key) return errorOutput("No Browser Run key is saved for this account.");
        const session = await this.registry.use(owner, key, args.engine);
        await session.navigate(url);
        return say(`Engine: ${session.engine}\n${describe(await session.snapshot())}`);
      }
      const session = await this.registry.current(owner);
      if (!session) return errorOutput("No page is open yet; use browser_open first.");
      if (name === "browser_click") {
        const args = parsed.data as z.infer<typeof SCHEMAS.browser_click>;
        await session.click(args.control);
      } else if (name === "browser_type") {
        const args = parsed.data as z.infer<typeof SCHEMAS.browser_type>;
        await session.type(args.control, args.text, {
          replace: args.replace ?? true,
          enter: args.enter ?? false,
        });
      }
      return say(describe(await session.snapshot()));
    } catch (error) {
      if (error instanceof PageRefused) return errorOutput(error.message);
      if (error instanceof CdpGone) {
        return errorOutput(
          "The browser did not answer. An action may already have happened; take a snapshot " +
            "before trying again.",
        );
      }
      if (error instanceof CdpError) return errorOutput("The browser refused that command.");
      return errorOutput("The browser could not do that.");
    }
  }

  /**
   * What the person can see of the run's browser: a screenshot of a Kitesurf page, or a Live
   * View link for Chromium that lets them watch, take over or open DevTools. Null when the run
   * has no browser open in this process.
   */
  async view(run: string, mode: LiveMode = "tab"): Promise<LiveView | null> {
    const session = await this.registry.forRun(this.account, run);
    if (!session) return null;
    if (session.engine === "chromium") {
      return {
        engine: "chromium",
        mode,
        url: await session.liveView(mode, LIVE_LINK_MS),
        expiresInMs: LIVE_LINK_MS,
      };
    }
    return { engine: "kitesurf", image: { type: "image/jpeg", data: await session.screenshot() } };
  }

  /** Closes the run's browsers. */
  end(run: string): Promise<void> {
    return this.registry.endRun(this.account, run);
  }
}
