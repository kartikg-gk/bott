/**
 * A small Chrome DevTools Protocol client: numbered requests over one WebSocket, answers matched
 * by id, and events handed to listeners. Commands for a page carry the flat `sessionId` the
 * browser gave when we attached to it.
 */

/** The few things the client needs from a WebSocket. */
export interface CdpSocket {
  send(text: string): void;
  close(): void;
  /** Called with each text frame the browser sends. */
  onText(listener: (text: string) => void): void;
  /** Called once when the connection ends, whichever side ended it. */
  onClose(listener: () => void): void;
}

/** Opens a socket to `url` with the given request headers. */
export type SocketOpener = (url: string, headers: Record<string, string>) => Promise<CdpSocket>;

/** The browser answered a command with an error. */
export class CdpError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

/** The connection closed or a command took too long. */
export class CdpGone extends Error {}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string | undefined;
}

interface Waiting {
  method: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN_TIMEOUT_MS = 20_000;

/** The Node runtime's own WebSocket, which accepts request headers as its second argument. */
export const nodeSocket: SocketOpener = (url, headers) =>
  new Promise((resolve, reject) => {
    const Ctor = globalThis.WebSocket as unknown as new (
      url: string,
      init: { headers: Record<string, string> },
    ) => WebSocket;
    if (typeof Ctor !== "function") {
      reject(new CdpGone("This Node runtime has no WebSocket"));
      return;
    }
    const ws = new Ctor(url, { headers });
    const textListeners: ((text: string) => void)[] = [];
    const closeListeners: (() => void)[] = [];
    let opened = false;
    const timer = setTimeout(() => {
      ws.close();
      reject(new CdpGone("The browser service did not answer in time"));
    }, OPEN_TIMEOUT_MS);
    ws.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      resolve({
        send: (text) => ws.send(text),
        close: () => ws.close(),
        onText: (listener) => textListeners.push(listener),
        onClose: (listener) => closeListeners.push(listener),
      });
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string")
        for (const listener of textListeners) listener(event.data);
    });
    ws.addEventListener("error", () => {
      if (!opened) {
        clearTimeout(timer);
        reject(new CdpGone("The browser service refused the connection"));
      }
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      if (!opened) reject(new CdpGone("The browser service closed the connection"));
      for (const listener of closeListeners) listener();
    });
  });

/** One open protocol connection to a browser. */
export class CdpClient {
  private next = 1;
  private readonly waiting = new Map<number, Waiting>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private ended = false;

  private constructor(
    private readonly socket: CdpSocket,
    private readonly timeoutMs: number,
  ) {
    socket.onText((text) => this.receive(text));
    socket.onClose(() => this.end());
  }

  static async connect(
    open: SocketOpener,
    url: string,
    headers: Record<string, string>,
    timeoutMs = 30_000,
  ): Promise<CdpClient> {
    return new CdpClient(await open(url, headers), timeoutMs);
  }

  get closed(): boolean {
    return this.ended;
  }

  /** Sends one command and waits for its answer. */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.ended) return Promise.reject(new CdpGone("The browser connection is closed"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new CdpGone(`${method} took too long`));
      }, this.timeoutMs);
      this.waiting.set(id, { method, resolve, reject, timer });
      const message: Record<string, unknown> = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      try {
        this.socket.send(JSON.stringify(message));
      } catch {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(new CdpGone("The browser connection is closed"));
      }
    });
  }

  /** Listens to every event; the returned function stops listening. */
  listen(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Resolves when an event named `method` arrives for `sessionId`, or with false after `ms`.
   * Start waiting before the command that causes the event, so it is not missed.
   */
  waitFor(method: string, sessionId: string | undefined, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let stop = () => {};
      const timer = setTimeout(() => {
        stop();
        resolve(false);
      }, ms);
      stop = this.listen((event) => {
        if (event.method !== method || event.sessionId !== sessionId) return;
        clearTimeout(timer);
        stop();
        resolve(true);
      });
    });
  }

  close(): void {
    if (this.ended) return;
    try {
      this.socket.close();
    } finally {
      this.end();
    }
  }

  private receive(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const found = this.waiting.get(message.id);
      if (!found) return;
      this.waiting.delete(message.id);
      clearTimeout(found.timer);
      const error = message.error as { message?: unknown } | undefined;
      if (error) {
        const why = typeof error.message === "string" ? error.message : "failed";
        found.reject(new CdpError(found.method, why));
      } else {
        found.resolve((message.result ?? {}) as Record<string, unknown>);
      }
      return;
    }
    if (typeof message.method === "string") {
      const event: CdpEvent = {
        method: message.method,
        params: (message.params ?? {}) as Record<string, unknown>,
        sessionId: typeof message.sessionId === "string" ? message.sessionId : undefined,
      };
      for (const listener of [...this.listeners]) listener(event);
    }
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const [id, found] of this.waiting) {
      clearTimeout(found.timer);
      found.reject(new CdpGone("The browser connection closed"));
      this.waiting.delete(id);
    }
    this.listeners.clear();
  }
}
