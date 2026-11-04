import { bridgeKey } from '../lib/apexLink';

// What the runtime's workers (worker/index.ts, files.ts, git.ts) post first,
// once their script and its imports have loaded: loaded().
export const LOADED = 'playground-worker-loaded';

export function loaded(): void {
  postMessage(LOADED);
}

// How often a worker that did not load starts again, and how long it waits
// before each try: about 0.1, 0.2, 0.4 and 0.8 s, scattered, so that
// workers that failed together do not load together again.
const RETRIES = 4;
const wait = (retry: number) => 100 * 2 ** retry * (0.5 + Math.random());

// The longest a gated worker's load holds back the next one.
const GATE_MS = 2000;

// The gated workers load one at a time: each waits for the one before it
// to load, fail or end (or for GATE_MS).
let gate: Promise<void> = Promise.resolve();

// Whether this context's requests no longer reach the service worker
// (exec/host.ts sets it in bridge mode).
let detached: (() => Promise<boolean>) | null = null;

export function checkDetached(check: (() => Promise<boolean>) | null): void {
  detached = check;
}

// A worker that starts again when its script or one of its imports does
// not load. In bridge mode (docs/frames.md) the service worker answers
// every file below /_bridge/KEY/, and the shared domain's server answers
// 404. WebKit sends some of the loads of one URL that several dedicated
// workers make at once to the network instead of the service worker: when
// several nodes start together, most of their workers fail to load
// (Playwright's WebKit 27.2, 2026-11-02: 6 or 7 of 8; desktop Safari also
// fails worker.js itself). A load of the same URL on its own goes to the
// service worker. So in bridge mode the runtime's own workers load one at
// a time (`gated`): with that, 16 nodes started at once in WebKit needed
// no retry in 12 runs, and started sooner than with retries alone.
//
// A failed load is an error event without a message before the worker's
// first message. Until then, what is posted to it waits (`hold`: the
// runtime's own workers, which post LOADED first, and may be sent ports
// that cannot be sent twice), or is posted and kept, to post again to the
// next worker (a package's worker program, which posts nothing until it
// runs, so it cannot be gated; it is sent no ports). The last failure goes
// to onerror. Each retry logs a warning, and giving up an error (`name`:
// the script's), so that the console says why a node did not start.
// Before a retry, it asks `checkDetached`'s check, when one is set: if the
// requests no longer reach a service worker (docs/frames.md, "When a frame
// loses its service worker"), no retry can load, so it fails at once.
export class RetryingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  // null while it waits for the gate.
  private thread: Worker | null = null;
  private started = false;
  private ended = false;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // Lets the next gated worker load.
  private release: () => void = () => {};
  // What was posted before its first message: held, or kept to post again.
  private early: [unknown, Transferable[]][] = [];

  constructor(
    private name: string,
    private create: () => Worker,
    private hold: boolean,
    private gated = false,
  ) {
    this.begin();
  }

  private begin(): void {
    if (!this.gated) return void (this.thread = this.start());
    const before = gate;
    const mine = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    // The next one waits for this one's turn too, if this one ends early.
    gate = before.then(() => mine);
    void before.then(() => {
      if (this.ended) return this.release();
      setTimeout(this.release, GATE_MS);
      this.thread = this.start();
    });
  }

  private start(): Worker {
    const thread = this.create();
    thread.onmessage = (event) => {
      if (!this.started) {
        this.started = true;
        this.release();
        const early = this.early;
        this.early = [];
        if (this.hold)
          for (const [message, transfer] of early) thread.postMessage(message, transfer);
        if (event.data === LOADED) return;
      }
      this.onmessage?.(event);
    };
    thread.onerror = (event) => {
      this.release();
      if (this.started || event.message) return this.onerror?.(event);
      if (this.retries >= RETRIES) {
        console.error(`${this.name}: the worker did not load after ${RETRIES + 1} tries`);
        return this.onerror?.(event);
      }
      event.preventDefault();
      thread.terminate();
      this.thread = null;
      if (!detached) return this.retry();
      void detached().then((lost) => {
        if (this.ended) return;
        if (!lost) return this.retry();
        console.error(
          `${this.name}: the worker did not load: its requests skip the service worker`,
        );
        this.onerror?.(event);
      });
    };
    return thread;
  }

  private retry(): void {
    console.warn(`${this.name}: the worker did not load; starting it again`);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (this.ended) return;
        if (this.gated) return this.begin();
        const next = (this.thread = this.start());
        if (!this.hold)
          for (const [message, transfer] of this.early) next.postMessage(message, transfer);
      },
      wait(this.retries++),
    );
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.started) return this.thread!.postMessage(message, transfer);
    this.early.push([message, transfer]);
    if (!this.hold) this.thread?.postMessage(message, transfer);
  }

  terminate(): void {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.early = [];
    this.release();
    this.thread?.terminate();
  }
}

// A module worker from a blob that imports the runtime's script: Firefox
// does not start a worker from a page its service worker controls; a blob
// worker takes the page's cross-origin isolation in both. In bridge mode
// (docs/frames.md) the script is the service worker's to answer, and
// Firefox does not let a blob worker that a worker starts be controlled
// by it: the worker starts from its script's URL instead, gated. The
// script posts LOADED first (loaded()); the worker starts again if it does
// not load.
export function worker(name: string, base: string): RetryingWorker {
  const script = new URL(name, new URL(base, location.href)).href;
  const bridged = Boolean(bridgeKey());
  return new RetryingWorker(
    name,
    () => {
      if (bridged) return new Worker(script, { type: 'module' });
      const blob = new Blob([`import ${JSON.stringify(script)};`], { type: 'text/javascript' });
      return new Worker(URL.createObjectURL(blob), { type: 'module' });
    },
    true,
    bridged,
  );
}
