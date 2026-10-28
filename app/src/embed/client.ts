// embed.js: run-elixir.dev's client for a page of another site that runs
// a project in it (docs/embed.md). It frames embed.html (from where this
// script came) and talks to it over a port, nothing else: none of
// run-elixir.dev's code runs in the embedder's origin.
//
//   import { create } from 'https://run-elixir.dev/embed.js';
//   const sandbox = await create({
//     requires: { otp: '^29.1', elixir: '~1.20.4' },
//     project: { template: 'phoenix' },
//   });
//
// Served at a stable URL, small, with nothing but rpc.ts in it.
import { Rpc } from '@/shared/lib/rpc';
import {
  API_VERSION,
  CONNECT,
  LOADED,
  type CreateOptions,
  type Created,
  type DirEntry,
  type Events,
  type Exit,
  type Hello,
  type ProcessRequest,
  type SpawnOptions,
  type Stat,
  type StreamFrame,
  type TerminalOptions,
  type WriteOptions,
} from './protocol';
import { SIGNALS, type Signal } from '@/runtime/signals';

export { API_VERSION };
export type {
  CreateOptions,
  Created,
  DirEntry,
  Exit,
  Hello,
  Signal,
  SpawnOptions,
  Stat,
  TerminalOptions,
  WriteOptions,
};

const encoder = new TextEncoder();
const bytesOf = (data: string | Uint8Array) =>
  typeof data === 'string' ? encoder.encode(data) : data;

// What came before anyone listened, given to the first listener: one
// kind of event of a stream or a process.
class Channel<T> {
  private listeners: ((value: T) => void)[] = [];
  private early: T[] = [];

  listen(listener: (value: T) => void): () => void {
    this.listeners.push(listener);
    for (const value of this.early.splice(0)) listener(value);
    return () => {
      this.listeners = this.listeners.filter((each) => each !== listener);
    };
  }

  send(value: T): void {
    if (!this.listeners.length) this.early.push(value);
    for (const listener of this.listeners) listener(value);
  }
}

// A byte stream to or from the sandbox (connect, serve).
export class Stream {
  private data = new Channel<Uint8Array>();
  private ended = new Channel<void>();
  private closing = new Channel<void>();
  private closed = false;

  constructor(readonly port: MessagePort) {
    port.onmessage = ({ data }: MessageEvent<StreamFrame>) => {
      if ('data' in data) this.data.send(data.data);
      else if ('end' in data) this.ended.send();
      else this.gone();
    };
  }

  // Each returns a function that stops listening.
  onData(listener: (bytes: Uint8Array) => void): () => void {
    return this.data.listen(listener);
  }
  // The other side is done writing (half-close).
  onEnd(listener: () => void): () => void {
    return this.ended.listen(listener);
  }
  onClose(listener: () => void): () => void {
    return this.closing.listen(listener);
  }

  write(data: string | Uint8Array): void {
    if (this.closed) return;
    const copy = bytesOf(data).slice();
    this.port.postMessage({ data: copy } satisfies StreamFrame, [copy.buffer]);
  }

  // Our side is done writing (half-close).
  end(): void {
    if (!this.closed) this.port.postMessage({ end: true } satisfies StreamFrame);
  }

  close(): void {
    if (this.closed) return;
    this.port.postMessage({ close: true } satisfies StreamFrame);
    this.gone();
  }

  private gone(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.close();
    this.closing.send();
  }
}

// A process running in the sandbox.
export class Process {
  // How it ended: its exit code, or the signal that ended it.
  readonly exited: Promise<Exit>;
  private stdout = new Channel<Uint8Array>();
  private stderr = new Channel<Uint8Array>();
  private exits = new Channel<Exit>();
  private ended: Exit | null = null;
  private resolve!: (exit: Exit) => void;

  constructor(
    readonly id: number,
    private rpc: Rpc,
  ) {
    this.exited = new Promise((resolve) => (this.resolve = resolve));
  }

  // Its input: bytes for a pipe, keys for a terminal.
  write(data: string | Uint8Array): void {
    const bytes = bytesOf(data).slice();
    void this.rpc.call('input', [this.id, bytes], [bytes.buffer]);
  }
  // The end of its input (a terminal's Ctrl+D).
  end(): void {
    void this.rpc.call('closeInput', [this.id]);
  }
  // SIGINT is Ctrl+C (a node's break, a program's stop); another ends it.
  kill(signal: Signal = 'SIGTERM'): void {
    void this.rpc.call('signal', [this.id, SIGNALS[signal]]);
  }
  // A terminal's new size.
  resize(cols: number, rows: number): void {
    void this.rpc.call('resize', [this.id, cols, rows]);
  }

  // Each returns a function that stops listening. Output that came
  // before a listener is given to the first. A terminal's is all stdout.
  onStdout(listener: (bytes: Uint8Array) => void): () => void {
    return this.stdout.listen(listener);
  }
  onStderr(listener: (bytes: Uint8Array) => void): () => void {
    return this.stderr.listen(listener);
  }
  onExit(listener: (exit: Exit) => void): () => void {
    return this.exits.listen(listener);
  }

  // From the sandbox.
  output(fd: number, bytes: Uint8Array): void {
    (fd === 2 ? this.stderr : this.stdout).send(bytes);
  }
  exit(exit: Exit): void {
    if (this.ended) return;
    this.ended = exit;
    this.resolve(exit);
    this.exits.send(exit);
  }
}

type Listener<K extends keyof Events> = (data: Events[K]) => void;

export class Sandbox {
  private processes = new Map<number, Process>();
  private next = 1;
  private servers = new Map<number, (stream: Stream) => void>();
  private listeners = new Map<string, Set<(data: never) => void>>();
  readonly fs;

  constructor(
    private rpc: Rpc,
    private frame: HTMLIFrameElement,
    readonly hello: Hello,
    readonly created: Created,
  ) {
    rpc.on<Events['output']>('output', ({ id, fd, bytes }) =>
      this.processes.get(id)?.output(fd, bytes),
    );
    rpc.on<Events['exit']>('exit', ({ id, code, signal }) => {
      this.processes.get(id)?.exit({ code, signal });
      this.processes.delete(id);
    });
    rpc.on<Events['connection']>('connection', ({ port, stream }) => {
      const serve = this.servers.get(port);
      if (serve) serve(new Stream(stream));
      else stream.close();
    });
    for (const event of ['progress', 'serving', 'changed', 'warning'] as const)
      rpc.on(event, (data) => {
        for (const listener of this.listeners.get(event) ?? [])
          (listener as (data: unknown) => void)(data);
      });
    const call = <T>(method: string, ...args: unknown[]) => rpc.call<T>(method, args);
    this.fs = {
      read: (path: string) => call<Uint8Array>('read', path),
      write: (path: string, data: string | Uint8Array, options: WriteOptions = {}) =>
        call<void>('write', path, data, options),
      // null when nothing is there.
      stat: (path: string) => call<Stat | null>('stat', path),
      list: (path: string) => call<DirEntry[]>('list', path),
      mkdir: (path: string) => call<void>('mkdir', path),
      remove: (path: string) => call<void>('remove', path),
      rename: (from: string, to: string) => call<void>('rename', from, to),
      copy: (from: string, to: string) => call<void>('copy', from, to),
      // What changed at or below `path`: each path, and whether it is
      // there now ('changed', created or written) or not ('deleted').
      watch: (
        path: string,
        listener: (change: { path: string; type: 'changed' | 'deleted' }) => void,
      ) => {
        const prefix = path.replace(/\/$/, '');
        return this.on('changed', (paths) => {
          for (const changed of paths)
            if (changed === prefix || changed.startsWith(`${prefix}/`))
              void call<Stat | null>('stat', changed).then(
                (stat) => listener({ path: changed, type: stat ? 'changed' : 'deleted' }),
                () => {},
              );
        });
      },
    };
  }

  get projectId(): string {
    return this.created.projectId;
  }
  get root(): string {
    return this.created.root;
  }

  on<K extends keyof Events>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as (data: never) => void);
    return () => set.delete(listener as (data: never) => void);
  }

  // A program and its arguments, on pipes (its stderr apart).
  spawn(argv: string[], options: SpawnOptions = {}): Process {
    return this.process({ ...options, argv });
  }

  // A shell line (sh -c LINE: brush, as the IDE's terminals run it).
  sh(line: string, options: SpawnOptions = {}): Process {
    return this.process({ ...options, line });
  }

  // A terminal: an interactive shell, or `command` on it.
  terminal({ cols, rows, command, ...options }: TerminalOptions): Process {
    return this.process({ ...options, argv: command, tty: { cols, rows } });
  }

  private process(request: ProcessRequest): Process {
    const id = this.next++;
    const process = new Process(id, this.rpc);
    this.processes.set(id, process);
    this.rpc.call('spawn', [id, request]).catch((error: Error) => {
      process.output(2, encoder.encode(`${error.message}\n`));
      process.exit({ code: 127, signal: null });
      this.processes.delete(id);
    });
    return process;
  }

  // A byte stream to a server the sandbox runs on `port` (its HTTP, raw).
  async connect(port: number): Promise<Stream> {
    const channel = new MessageChannel();
    await this.rpc.call('connect', [port, channel.port2], [channel.port2]);
    return new Stream(channel.port1);
  }

  // The sandbox's connections to 127.0.0.1:`port`, answered here.
  async serve(port: number, onConnection: (stream: Stream) => void): Promise<() => Promise<void>> {
    this.servers.set(port, onConnection);
    await this.rpc.call('serve', [[...this.servers.keys()]]);
    return async () => {
      this.servers.delete(port);
      await this.rpc.call('serve', [[...this.servers.keys()]]);
    };
  }

  // Where to frame port `port`'s page at `path` (https://v-ID-PORT.…/path),
  // once it can be.
  previewUrl(port: number, path = '/'): Promise<string> {
    return this.rpc.call<string>('previewUrl', [port, path]);
  }

  async shutdown(): Promise<void> {
    await this.rpc.call('shutdown').catch(() => {});
    this.rpc.close();
    this.frame.remove();
  }
}

export interface Options extends CreateOptions {
  // Where the (one-pixel, unseen) frame goes: document.body by default.
  container?: HTMLElement;
  // Where embed.html is: the site this script came from by default.
  origin?: string;
  onProgress?: (event: Events['progress']) => void;
}

// embed.html in a frame of `container`, its port once it loaded.
function embedFrame(origin: string, container: HTMLElement): Promise<[HTMLIFrameElement, Rpc]> {
  return new Promise((resolve, reject) => {
    const element = document.createElement('iframe');
    element.src = `${origin}/embed.html`;
    // On the screen but unseen: WebKit slows a hidden frame's workers.
    Object.assign(element.style, {
      position: 'fixed',
      right: '0',
      bottom: '0',
      width: '1px',
      height: '1px',
      border: '0',
      opacity: '0',
      pointerEvents: 'none',
    });
    element.setAttribute('aria-hidden', 'true');
    element.tabIndex = -1;
    // SharedArrayBuffers and threads, here and in its frames (Chromium).
    element.allow = 'cross-origin-isolated';
    const timer = setTimeout(() => {
      removeEventListener('message', loaded);
      element.remove();
      reject(new Error(`${origin}/embed.html did not load (is this origin allowed to embed it?)`));
    }, 30000);
    const loaded = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== element.contentWindow) return;
      if (event.data?.kind !== LOADED) return;
      removeEventListener('message', loaded);
      clearTimeout(timer);
      const channel = new MessageChannel();
      element.contentWindow!.postMessage({ kind: CONNECT, apiVersion: API_VERSION }, origin, [
        channel.port2,
      ]);
      resolve([element, new Rpc(channel.port1)]);
    };
    addEventListener('message', loaded);
    container.append(element);
  });
}

// A project running in run-elixir.dev, in a frame of this page.
export async function create(options: Options): Promise<Sandbox> {
  if (!crossOriginIsolated)
    throw new Error(
      'this page is not cross-origin isolated: serve it with Cross-Origin-Opener-Policy: ' +
        'same-origin and Cross-Origin-Embedder-Policy: require-corp',
    );
  const origin = options.origin ?? new URL(import.meta.url).origin;
  const [element, rpc] = await embedFrame(origin, options.container ?? document.body);
  try {
    const hello = await rpc.call<Hello>('hello');
    if (options.onProgress) rpc.on<Events['progress']>('progress', options.onProgress);
    const { requires, project, env, relay } = options;
    const created = await rpc.call<Created>('create', [{ requires, project, env, relay }]);
    return new Sandbox(rpc, element, hello, created);
  } catch (error) {
    rpc.close();
    element.remove();
    throw error;
  }
}

export const RunElixir = { create, API_VERSION };
export default RunElixir;
