// embed.js: run-elixir.dev's client for a page of another site that runs
// a project in it (docs/embed.md). It frames embed.html (from where this
// script came) and talks to it over a port, nothing else: none of
// run-elixir.dev's code runs in the embedder's origin.
//
//   import { create } from 'https://run-elixir.dev/embed.js';
//   const sandbox = await create({
//     runtime: { otp: '29.1.2', elixir: '1.20.4' },
//     project: { template: 'phoenix' },
//   });
//
// Served at a stable URL, small, with nothing but rpc.ts in it.
import { Rpc } from '@/shared/lib/rpc';
import {
  API_VERSION,
  CONNECT,
  LOADED,
  SIGNALS,
  type CreateOptions,
  type Created,
  type DirEntry,
  type Events,
  type Hello,
  type SpawnOptions,
  type Stat,
  type StreamFrame,
  type WriteOptions,
} from './protocol';

export { API_VERSION };
export type { CreateOptions, Created, DirEntry, Hello, SpawnOptions, Stat, WriteOptions };

const encoder = new TextEncoder();
const bytesOf = (data: string | Uint8Array) =>
  typeof data === 'string' ? encoder.encode(data) : data;

// A byte stream to or from the sandbox (connect, serve).
export class Stream {
  ondata: (bytes: Uint8Array) => void = () => {};
  onend: () => void = () => {};
  onclose: () => void = () => {};
  private closed = false;

  constructor(readonly port: MessagePort) {
    port.onmessage = ({ data }: MessageEvent<StreamFrame>) => {
      if ('data' in data) this.ondata(data.data);
      else if ('end' in data) this.onend();
      else this.gone();
    };
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
    this.onclose();
  }
}

type Chunk = (bytes: Uint8Array) => void;

// A command running in the sandbox.
export class Process {
  // Its exit status (128 + a signal's number when one stopped it).
  readonly exited: Promise<number>;
  private listeners: Record<1 | 2, Chunk[]> = { 1: [], 2: [] };
  private early: Record<1 | 2, Uint8Array[]> = { 1: [], 2: [] };
  private exitListeners: ((code: number) => void)[] = [];
  private code: number | null = null;
  private resolve!: (code: number) => void;

  constructor(
    readonly id: number,
    private rpc: Rpc,
  ) {
    this.exited = new Promise((resolve) => (this.resolve = resolve));
  }

  write(data: string | Uint8Array): void {
    const bytes = bytesOf(data).slice();
    void this.rpc.call('input', [this.id, bytes], [bytes.buffer]);
  }
  closeStdin(): void {
    void this.rpc.call('closeStdin', [this.id]);
  }
  kill(signal: keyof typeof SIGNALS | number = 'SIGTERM'): void {
    const number = typeof signal === 'number' ? signal : SIGNALS[signal];
    void this.rpc.call('kill', [this.id, number ?? 15]);
  }
  resize(cols: number, rows: number): void {
    void this.rpc.call('resize', [this.id, cols, rows]);
  }

  // Output that came before a listener is given to the first.
  onStdout(listener: Chunk): () => void {
    return this.listen(1, listener);
  }
  onStderr(listener: Chunk): () => void {
    return this.listen(2, listener);
  }
  onExit(listener: (code: number) => void): void {
    if (this.code !== null) listener(this.code);
    else this.exitListeners.push(listener);
  }

  private listen(fd: 1 | 2, listener: Chunk): () => void {
    this.listeners[fd].push(listener);
    for (const bytes of this.early[fd].splice(0)) listener(bytes);
    return () => {
      this.listeners[fd] = this.listeners[fd].filter((each) => each !== listener);
    };
  }

  // From the sandbox.
  output(fd: number, bytes: Uint8Array): void {
    const stream = fd === 2 ? 2 : 1;
    if (!this.listeners[stream].length) this.early[stream].push(bytes);
    for (const listener of this.listeners[stream]) listener(bytes);
  }
  exit(code: number): void {
    if (this.code !== null) return;
    this.code = code;
    this.resolve(code);
    for (const listener of this.exitListeners.splice(0)) listener(code);
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
    rpc.on<Events['exit']>('exit', ({ id, code }) => {
      this.processes.get(id)?.exit(code);
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

  // A command: a shell line (sh -c), its words, or null for an
  // interactive shell (with a tty).
  spawn(command: string | string[] | null, options: SpawnOptions = {}): Process {
    const id = this.next++;
    const process = new Process(id, this.rpc);
    this.processes.set(id, process);
    this.rpc.call('spawn', [id, command, options]).catch((error: Error) => {
      process.output(2, encoder.encode(`${error.message}\n`));
      process.exit(127);
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

  // Where to frame port `port`'s preview (https://v-ID-PORT.…), ready.
  previewOrigin(port: number): Promise<string> {
    return this.rpc.call<string>('previewOrigin', [port]);
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
    const { runtime, project, persist, env, relay } = options;
    const created = await rpc.call<Created>('create', [{ runtime, project, persist, env, relay }]);
    return new Sandbox(rpc, element, hello, created);
  } catch (error) {
    rpc.close();
    element.remove();
    throw error;
  }
}

export const RunElixir = { create, API_VERSION };
export default RunElixir;
