// Node's worker_threads: a Worker is a nested Web Worker running nodejs.js
// as a thread of the same process, with the process's files channel (one
// call at a time, by its lock) and its directory. What a thread writes is
// its parent's to write; messages go both ways as structured clones, so
// SharedArrayBuffers, WebAssembly memories and modules pass as they are
// (napi-rs's threads share a memory this way).
import { EventEmitter } from 'events';

// What a thread starts with, beside the process's own start fields.
export interface ThreadStart {
  threadId: number;
  file: string | null;
  code: string | null;
  workerData: unknown;
  argv: string[];
  env: Record<string, string>;
}

export interface ThreadHost {
  // nodejs.js's URL, for the nested worker.
  script: string;
  // The start fields every thread of the process shares (the channel).
  shared: Record<string, unknown>;
  cwd: () => string;
  env: Record<string, string>;
  write: (fd: number, bytes: Uint8Array) => void;
  hold: () => () => void;
  resolve: (file: string) => string;
  // This thread's own, when it is one.
  self: ThreadStart | null;
  post: (message: unknown, transfer?: Transferable[]) => void;
}

let nextThread = 1;

// Node's MessageChannel over the browser's: a port keeps the process
// alive while it is ref'd, or while something listens for its messages
// and it is not unref'd (emnapi holds Node's loop that way while a
// thread-safe function waits); on('message') hands listeners the value, as
// Node's ports do.
export function nodeMessageChannel(hold: () => () => void): typeof MessageChannel {
  const Native = globalThis.MessageChannel;
  const patch = (port: MessagePort) => {
    let release: (() => void) | null = null;
    let referenced = false;
    let unreferenced = false;
    let listeners = 0;
    let closed = false;
    const update = () => {
      const want = !closed && (referenced || (listeners > 0 && !unreferenced));
      if (want && !release) release = hold();
      else if (!want && release) {
        release();
        release = null;
      }
    };
    const wrapped = new Map<(...args: unknown[]) => void, (event: MessageEvent) => void>();
    const target = port as MessagePort & Record<string, unknown>;
    const on = (event: string, fn: (...args: unknown[]) => void) => {
      if (event === 'message') {
        const listener = (e: MessageEvent) => fn(e.data);
        wrapped.set(fn, listener);
        port.addEventListener('message', listener);
        port.start();
        listeners++;
        update();
      } else if (event === 'close') port.addEventListener('close' as never, fn as never);
      return port;
    };
    const off = (event: string, fn: (...args: unknown[]) => void) => {
      const listener = wrapped.get(fn);
      if (event === 'message' && listener) {
        port.removeEventListener('message', listener);
        wrapped.delete(fn);
        listeners--;
        update();
      }
      return port;
    };
    Object.assign(target, {
      on,
      addListener: on,
      once: (event: string, fn: (...args: unknown[]) => void) => {
        const once = (...args: unknown[]) => {
          off(event, once);
          fn(...args);
        };
        return on(event, once);
      },
      off,
      removeListener: off,
      removeAllListeners: () => {
        for (const fn of [...wrapped.keys()]) off('message', fn);
        return port;
      },
      ref: () => {
        referenced = true;
        unreferenced = false;
        update();
        return port;
      },
      unref: () => {
        referenced = false;
        unreferenced = true;
        update();
        return port;
      },
      hasRef: () => release !== null,
    });
    const close = port.close.bind(port);
    target.close = () => {
      closed = true;
      update();
      close();
    };
    // onmessage, assigned, listens as well.
    let handler: ((event: MessageEvent) => void) | null = null;
    Object.defineProperty(target, 'onmessage', {
      get: () => handler,
      set: (fn: ((event: MessageEvent) => void) | null) => {
        if (handler) port.removeEventListener('message', handler);
        if (handler && !fn) listeners--;
        if (fn && !handler) listeners++;
        handler = fn;
        if (fn) {
          port.addEventListener('message', fn);
          port.start();
        }
        update();
      },
    });
  };
  return class extends Native {
    constructor() {
      super();
      patch(this.port1);
      patch(this.port2);
    }
  };
}

export function createThreads(host: ThreadHost) {
  const parentPort = host.self ? createParentPort(host) : null;

  class Worker extends EventEmitter {
    threadId: number;
    resourceLimits = {};
    private thread: globalThis.Worker;
    private release: (() => void) | null;
    private exited = false;
    // Assigned by emnapi, which calls it from its own 'message' listener:
    // Node's Worker calls no onmessage itself, nor does this one.
    onmessage: ((event: { data: unknown }) => void) | null = null;

    constructor(
      filename: string | URL,
      options: {
        eval?: boolean;
        workerData?: unknown;
        env?: Record<string, string> | symbol;
        argv?: unknown[];
        transferList?: Transferable[];
      } = {},
    ) {
      super();
      this.threadId = nextThread++;
      const blob = new Blob([`import ${JSON.stringify(host.script)};`], {
        type: 'text/javascript',
      });
      this.thread = new globalThis.Worker(URL.createObjectURL(blob), { type: 'module' });
      this.release = host.hold();
      const name = String(filename);
      const file = options.eval
        ? null
        : host.resolve(
            name.startsWith('file://') ? decodeURIComponent(new URL(name).pathname) : name,
          );
      const start: ThreadStart = {
        threadId: this.threadId,
        file,
        code: options.eval ? name : null,
        workerData: options.workerData,
        argv: (options.argv ?? []).map(String),
        env: typeof options.env === 'object' ? options.env : host.env,
      };
      this.thread.onmessage = ({ data }) => this.receive(data);
      this.thread.onerror = (event) => {
        event.preventDefault();
        this.emit('error', new Error(event.message || 'the worker failed to start'));
        this.finish(1);
      };
      this.thread.postMessage(
        { kind: 'start', ...host.shared, cwd: host.cwd(), thread: start },
        options.transferList ?? [],
      );
      queueMicrotask(() => this.emit('online'));
    }

    private receive(data: { kind: string; [field: string]: unknown }) {
      if (data.kind === 'out') host.write(data.fd as number, data.bytes as Uint8Array);
      else if (data.kind === 'message') this.emit('message', data.data);
      else if (data.kind === 'error') this.emit('error', data.error);
      else if (data.kind === 'exit') this.finish(data.code as number);
    }

    private finish(code: number) {
      if (this.exited) return;
      this.exited = true;
      this.thread.terminate();
      this.release?.();
      this.release = null;
      this.emit('exit', code);
    }

    postMessage(value: unknown, transfer?: Transferable[] | { transfer?: Transferable[] }) {
      const list = Array.isArray(transfer) ? transfer : (transfer?.transfer ?? []);
      this.thread.postMessage({ kind: 'message', data: value }, list);
    }
    terminate(): Promise<number> {
      this.finish(1);
      return Promise.resolve(1);
    }
    ref() {
      if (!this.exited) this.release ??= host.hold();
      return this;
    }
    unref() {
      this.release?.();
      this.release = null;
      return this;
    }
    getHeapSnapshot(): never {
      throw new Error('worker.getHeapSnapshot is not available in the playground');
    }
    get stdout() {
      return null;
    }
    get stderr() {
      return null;
    }
  }

  return {
    isMainThread: !host.self,
    threadId: host.self?.threadId ?? 0,
    workerData: host.self?.workerData ?? null,
    parentPort,
    resourceLimits: {},
    SHARE_ENV: Symbol.for('nodejs.worker_threads.SHARE_ENV'),
    Worker,
    // The process's (index.ts sets it: Node's, nodeMessageChannel).
    get MessageChannel() {
      return globalThis.MessageChannel;
    },
    MessagePort,
    BroadcastChannel,
    markAsUntransferable() {},
    // Marks only: a structured clone here is the browser's.
    markAsUncloneable() {},
    isMarkedAsUntransferable: () => false,
    moveMessagePortToContext: (port: MessagePort) => port,
    receiveMessageOnPort: () => undefined,
    getEnvironmentData: () => undefined,
    setEnvironmentData() {},
    // What the parent sends, for the thread's entry (index.ts) to hand on.
    deliver(data: unknown) {
      (parentPort?.deliver as ((data: unknown) => void) | undefined)?.(data);
    },
  };
}

// A thread's port to its parent: its messages (kept until something
// listens, as Node's port starts then), and the thread kept alive while
// something listens for them, as Node keeps it.
function createParentPort(host: ThreadHost) {
  const port = new EventEmitter() as EventEmitter & Record<string, unknown>;
  let release: (() => void) | null = null;
  const queued: unknown[] = [];
  port.on('newListener', (event) => {
    if (event !== 'message') return;
    release ??= host.hold();
    queueMicrotask(() => {
      while (queued.length && port.listenerCount('message')) port.emit('message', queued.shift());
    });
  });
  port.on('removeListener', (event) => {
    if (event === 'message' && !port.listenerCount('message') && release) {
      release();
      release = null;
    }
  });
  Object.assign(port, {
    deliver(data: unknown) {
      if (port.listenerCount('message')) port.emit('message', data);
      else queued.push(data);
    },
    postMessage(value: unknown, transfer?: Transferable[] | { transfer?: Transferable[] }) {
      const list = Array.isArray(transfer) ? transfer : (transfer?.transfer ?? []);
      host.post({ kind: 'message', data: value }, list);
    },
    close() {
      release?.();
      release = null;
    },
    ref: () => port,
    unref() {
      release?.();
      release = null;
      return port;
    },
    start() {},
  });
  return port;
}
