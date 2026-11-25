import type { CdpSocket, SocketOpener } from "../../src/browser/cdp.ts";
import type { Snapshot } from "../../src/browser/page.ts";

export interface Sent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** One browser the fake service started. */
export interface FakeBrowser {
  url: string;
  headers: Record<string, string>;
  sent: Sent[];
  closed: boolean;
}

/**
 * Stands in for Browser Run: each connection is a browser with one page. Page scripts are not
 * run; the fake answers them by which page function the expression calls.
 */
export function fakeCdp(opts: { refuse?: (url: string) => boolean } = {}) {
  const browsers: FakeBrowser[] = [];
  const state = {
    page: {
      title: "Example",
      url: "about:blank",
      text: "Hello there",
      textCut: false,
      controls: [{ n: 1, kind: "button", label: "Go" }],
      controlsCut: false,
    } as Snapshot,
    /** What the page functions answer: "ok", "gone", "no option" and so on. */
    act: "ok",
    /** Methods that answer with a protocol error. */
    failing: new Set<string>(),
    /** Methods that never answer. */
    silent: new Set<string>(),
    navigateError: "",
  };

  const open: SocketOpener = async (url, headers) => {
    if (opts.refuse?.(url)) throw new Error("refused");
    const browser: FakeBrowser = { url, headers, sent: [], closed: false };
    browsers.push(browser);
    const texts: ((text: string) => void)[] = [];
    const closes: (() => void)[] = [];
    const emit = (message: object) => {
      queueMicrotask(() => {
        for (const t of texts) t(JSON.stringify(message));
      });
    };
    const socket: CdpSocket = {
      send(text) {
        if (browser.closed) throw new Error("closed");
        const m = JSON.parse(text) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
          sessionId?: string;
        };
        browser.sent.push({
          method: m.method,
          params: m.params,
          ...(m.sessionId ? { sessionId: m.sessionId } : {}),
        });
        if (state.silent.has(m.method)) return;
        if (state.failing.has(m.method)) {
          emit({ id: m.id, error: { code: -32000, message: "not here" } });
          return;
        }
        let result: Record<string, unknown> = {};
        switch (m.method) {
          case "Target.getTargets":
            result = { targetInfos: [] };
            break;
          case "Target.createTarget":
            result = { targetId: "T1" };
            break;
          case "Target.attachToTarget":
            result = { sessionId: "S1" };
            break;
          case "Page.navigate":
            state.page = { ...state.page, url: String(m.params.url) };
            result = state.navigateError ? { errorText: state.navigateError } : { frameId: "F" };
            if (!state.navigateError)
              emit({ method: "Page.loadEventFired", params: {}, sessionId: "S1" });
            break;
          case "Runtime.evaluate": {
            const expression = String(m.params.expression);
            const value = /^\(function gather/.test(expression) ? state.page : state.act;
            result = { result: { type: "object", value } };
            break;
          }
          case "Page.captureScreenshot":
            result = { data: "SU1BR0U=" };
            break;
          case "Cloudflare.getLiveView":
            result = { devtoolsFrontendUrl: `https://live.example/view?mode=${m.params.mode}` };
            break;
        }
        emit({ id: m.id, result });
      },
      close() {
        if (browser.closed) return;
        browser.closed = true;
        for (const c of closes) c();
      },
      onText: (l) => texts.push(l),
      onClose: (l) => closes.push(l),
    };
    return socket;
  };

  return { open, browsers, state };
}

/** The expression's argument, for a page function call. */
export function scriptArg(sent: Sent): Record<string, unknown> {
  const expression = String(sent.params.expression);
  const start = expression.lastIndexOf(")(");
  return JSON.parse(expression.slice(start + 2, -1)) as Record<string, unknown>;
}
