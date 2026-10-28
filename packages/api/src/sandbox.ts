// create() and its sandbox (docs/api.md): a project run from the page that
// calls it, which is the project's apex: it frames the project's exec frame
// on the usercontent domain (exec/host.ts), keeps what is the apex's (the
// project's stores, its plugins' services: PGlite; Hex's cache), makes the
// preview's relays, gives Claude Code's files (claudeFrame.ts),
// and carries connections to the ports its caller serves. Processes are
// the exec frame's (its process API, which keeps a terminal's line
// discipline). The playground's IDE and other sites' pages run projects
// through it alike.
import type { ExecEvents, ExecStart, ProcessStart } from '@elixir-playground/runtime/exec/host';
import type { Stat as FileStat } from '@elixir-playground/runtime/host/files';
import { serveStore } from '@elixir-playground/runtime/overlay';
import { assertSite } from '@elixir-playground/runtime/packages/check';
import { Site, type Boot, type SiteManifest } from '@elixir-playground/runtime/packages/manifest';
import { listed } from '@elixir-playground/runtime/relay';
import { SIGNALS, type Signal } from '@elixir-playground/runtime/signals';
import { claudePort } from './claudeFrame';
import type { WorkspaceKind } from '@elixir-playground/runtime/kinds';
import { forgetRelays, previewRelay } from './previewOrigins';
import { runtimePath, setRuntimePath } from './runtimePath';
import { startExecFrame } from './execFrame';
import { isId, newId } from '@elixir-playground/runtime/lib/ids';
import { Rpc } from '@elixir-playground/runtime/lib/rpc';
import {
  execOrigin,
  loadSite,
  previewOrigin,
  useUsercontent,
} from '@elixir-playground/runtime/lib/site';
import { filesStore } from './stores';
import { apexServices } from './services';
import type {
  ApexInstance,
  ApexPlugin,
  CreateOptions,
  DirEntry,
  Events,
  Exit,
  PackageDescriptor,
  Plugin,
  RelayPolicy,
  RuntimeVersions,
  SpawnOptions,
  Stat,
  StreamFrame,
  TerminalOptions,
  Way,
  WriteOptions,
} from './types';

const encoder = new TextEncoder();
const bytesOf = (data: string | Uint8Array) =>
  typeof data === 'string' ? encoder.encode(data) : data;

// An error with POSIX's code.
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

// A caller's own name for a project as a project's key (ten letters and
// digits, its origins' name): the same name is the same key.
async function keyFor(name: string): Promise<string> {
  if (isId(name)) return name;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(`elixir-playground:${name}`)),
  );
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(digest.subarray(0, 10), (byte) => alphabet[byte % 36]).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const isDescriptor = (plugin: Plugin): plugin is PackageDescriptor =>
  !Array.isArray(plugin) && 'playground' in plugin && 'version' in plugin;
const isApex = (plugin: Plugin): plugin is ApexPlugin =>
  !Array.isArray(plugin) && typeof (plugin as ApexPlugin).apex === 'function';

// The plugins, presets flattened, in order; a name given twice is the
// first one's.
function flatten(plugins: readonly Plugin[]): {
  packages: PackageDescriptor[];
  apex: ApexPlugin[];
} {
  const packages = new Map<string, PackageDescriptor>();
  const apex = new Map<string, ApexPlugin>();
  const walk = (list: readonly Plugin[]) => {
    for (const plugin of list) {
      if (Array.isArray(plugin)) walk(plugin);
      else if (isDescriptor(plugin)) {
        if (!packages.has(plugin.name)) packages.set(plugin.name, plugin);
      } else if (isApex(plugin)) {
        if (!apex.has(plugin.name)) apex.set(plugin.name, plugin);
      } else throw failure('EINVAL', `not a package or a plugin: ${JSON.stringify(plugin)}`);
    }
  };
  walk(plugins);
  return { packages: [...packages.values()], apex: [...apex.values()] };
}

// The site manifest the runtime reads (docs/packages.md), made of the
// packages: each package's files at its `base`, below the usercontent
// domain's root.
/** @internal */
export function siteOf(packages: PackageDescriptor[], boot: Boot | null): SiteManifest {
  return {
    manifest: 2,
    packages: Object.fromEntries(packages.map(({ name, ...entry }) => [name, entry])),
    boot,
  };
}

// The IDE's options beyond the API's (project/lib/playground.ts): not a
// stable interface.
/** @internal */
export interface PlaygroundOptions {
  // A temporary IEx: an empty project whose first shell runs IEx.
  kind?: WorkspaceKind;
  // /shared's store (the user's, every project's), if the project has it.
  shared?: MessagePort | null;
  signal?: AbortSignal;
  // The exec frame's port, once it started, before the project's files do.
  connected?: (exec: Rpc) => void;
}

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
  private statuses = new Channel<string>();
  private exits = new Channel<Exit>();
  private ended: Exit | null = null;
  private resolve!: (exit: Exit) => void;

  /** @internal */
  constructor(
    readonly id: number,
    private exec: Rpc,
  ) {
    this.exited = new Promise((resolve) => (this.resolve = resolve));
  }

  // Its input: bytes for a pipe, keys for a terminal.
  write(data: string | Uint8Array): void {
    const bytes = bytesOf(data).slice();
    void this.exec.call('input', [this.id, bytes], [bytes.buffer]).catch(() => {});
  }
  // The end of its input (a terminal's Ctrl+D).
  end(): void {
    void this.exec.call('closeInput', [this.id]).catch(() => {});
  }
  // SIGINT is Ctrl+C (a node's break, a program's stop); another ends it.
  kill(signal: Signal = 'SIGTERM'): void {
    void this.exec.call('signal', [this.id, SIGNALS[signal]]).catch(() => {});
  }
  // A shell's foreground program ends at once; the shell stays.
  stopForeground(): void {
    void this.exec.call('stopForeground', [this.id]).catch(() => {});
  }
  // A terminal's new size.
  resize(cols: number, rows: number): void {
    void this.exec.call('resize', [this.id, cols, rows]).catch(() => {});
  }

  // Each returns a function that stops listening. Output that came
  // before a listener is given to the first. A terminal's is all stdout.
  onStdout(listener: (bytes: Uint8Array) => void): () => void {
    return this.stdout.listen(listener);
  }
  onStderr(listener: (bytes: Uint8Array) => void): () => void {
    return this.stderr.listen(listener);
  }
  // What it does while it starts (text), then 'running', or 'failed: …'.
  onStatus(listener: (text: string) => void): () => void {
    return this.statuses.listen(listener);
  }
  onExit(listener: (exit: Exit) => void): () => void {
    return this.exits.listen(listener);
  }

  // From the exec frame.
  /** @internal */
  output(fd: number, bytes: Uint8Array): void {
    (fd === 2 ? this.stderr : this.stdout).send(bytes);
  }
  /** @internal */
  status(text: string): void {
    this.statuses.send(text);
  }
  /** @internal */
  exit(exit: Exit): void {
    if (this.ended) return;
    this.ended = exit;
    this.resolve(exit);
    this.exits.send(exit);
  }
}

type Listener<K extends keyof Events> = (data: Events[K]) => void;

// The way to a host: the caller's policy, or its list of hosts.
function wayOf(relay: RelayPolicy | undefined): (host: unknown) => Way | Promise<Way> {
  if (typeof relay === 'function') return relay;
  const hosts = [...(relay ?? [])];
  return (host) => (typeof host === 'string' && listed(host, hosts) ? 'relay' : 'none');
}

export class Sandbox {
  readonly fs;
  // The ports the project's servers listen on, and the preview's.
  serving: Events['serving'] = { ports: [], port: null };
  private processes = new Map<number, Process>();
  private next = 1;
  private servers = new Map<number, (stream: Stream) => void>();
  private listeners = new Map<string, Set<(data: never) => void>>();
  private closed = false;
  // The exec frame's port: the playground's own calls go over it too
  // (project/lib/playground.ts). Not a stable interface.
  /** @internal */
  readonly exec: Rpc;

  /** @internal */
  constructor(
    exec: Rpc,
    private frame: HTMLIFrameElement,
    // The project's key: its exec and preview origins' name.
    readonly projectId: string,
    // The app's directory (the template's, or the archive's top one).
    public root: string,
    readonly runtime: RuntimeVersions | null,
    private env: Record<string, string>,
    // The plugins' parts of this sandbox, by plugin name.
    readonly instances: Map<string, ApexInstance>,
  ) {
    this.exec = exec;
    const call = <T>(method: string, ...args: unknown[]) => this.running().call<T>(method, args);
    this.fs = {
      read: async (path: string) => call<Uint8Array>('read', path),
      write: (path: string, data: string | Uint8Array, options: WriteOptions = {}) =>
        this.write(path, data, options),
      // null when nothing is there.
      stat: (path: string) => this.stat(path),
      list: (path: string) => this.list(path),
      // With its parents.
      mkdir: (path: string) => call<void>('mkdir', path),
      // A directory with what is in it.
      remove: async (path: string) => {
        if (!(await this.stat(path))) throw failure('ENOENT', `${path}: no such file`);
        await call<void>('remove', path);
      },
      rename: async (from: string, to: string) => {
        if (!(await this.stat(from))) throw failure('ENOENT', `${from}: no such file`);
        await call<void>('rename', from, to);
      },
      copy: (from: string, to: string) => this.copy(from, to),
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
              void this.stat(changed).then(
                (stat) => listener({ path: changed, type: stat ? 'changed' : 'deleted' }),
                () => {},
              );
        });
      },
    };
  }

  private running(): Rpc {
    if (this.closed) throw failure('ENOTCONN', 'the sandbox was shut down');
    return this.exec;
  }

  // Every listener of `event`.
  /** @internal */
  emit<K extends keyof Events>(event: K, data: Events[K]): void {
    for (const listener of this.listeners.get(event) ?? [])
      (listener as (data: Events[K]) => void)(data);
  }

  on<K extends keyof Events>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as (data: never) => void);
    return () => set.delete(listener as (data: never) => void);
  }

  // The files.
  private async write(path: string, data: Uint8Array | string, options: WriteOptions) {
    const exec = this.running();
    const bytes = bytesOf(data);
    const present = await exec.call<'file' | 'dir' | null>('stat', [path]);
    if (options.exclusive && present) throw failure('EEXIST', `${path}: exists already`);
    if (options.expectedSha256 !== undefined) {
      const now =
        present === 'file' ? await sha256(await exec.call<Uint8Array>('read', [path])) : '';
      if (now !== options.expectedSha256.toLowerCase())
        throw failure('ESTALE', `${path}: changed since it was read`);
    }
    if (present === 'dir') throw failure('EISDIR', `${path}: is a directory`);
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent) await exec.call('mkdir', [parent]);
    await exec.call('write', [path, bytes]);
  }

  private async stat(path: string): Promise<Stat | null> {
    try {
      const { type, size, mtime } = await this.running().call<FileStat>('lstat', [path]);
      return { type, size, mtime };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }

  private async list(path: string): Promise<DirEntry[]> {
    const names = await this.running().call<string[]>('readdir', [path]);
    const entries = await Promise.all(
      names.map(async (name) => {
        const stat = await this.stat(`${path.replace(/\/$/, '')}/${name}`);
        return stat ? { name, ...stat } : null;
      }),
    );
    return entries.filter((entry): entry is DirEntry => entry !== null);
  }

  private async copy(from: string, to: string): Promise<void> {
    const stat = await this.stat(from);
    if (!stat) throw failure('ENOENT', `${from}: no such file`);
    if (stat.type === 'file')
      return this.write(to, await this.running().call<Uint8Array>('read', [from]), {});
    await this.running().call('mkdir', [to]);
    for (const entry of await this.list(from))
      await this.copy(`${from}/${entry.name}`, `${to}/${entry.name}`);
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
    return this.process({ ...options, argv: command ?? null, tty: { cols, rows } });
  }

  private process({ cwd, env, ...start }: ProcessStart): Process {
    const id = this.next++;
    const process = new Process(id, this.exec);
    this.processes.set(id, process);
    const request: ProcessStart = {
      argv: null,
      line: null,
      tty: null,
      ...start,
      cwd: cwd ?? this.root,
      env: {
        // Claude Code for the Agent SDK (claude-agent-acp): the
        // playground's `claude` (docs/api.md).
        CLAUDE_CODE_EXECUTABLE: '/usr/bin/claude',
        ...this.env,
        ...env,
      },
    };
    const failed = (error: Error) => {
      process.output(2, encoder.encode(`${error.message}\n`));
      process.exit({ code: 127, signal: null });
      this.processes.delete(id);
    };
    // Now, before anything is written to it: the exec frame takes calls in
    // order.
    if (this.closed) failed(failure('ENOTCONN', 'the sandbox was shut down'));
    else this.exec.call('spawn', [id, request]).catch(failed);
    return process;
  }

  // A byte stream to a server the sandbox runs on `port` (its HTTP, raw).
  async connect(port: number): Promise<Stream> {
    const channel = new MessageChannel();
    const done = await this.running().call<boolean>(
      'connectServer',
      [port, channel.port2],
      [channel.port2],
    );
    if (!done) throw failure('ECONNREFUSED', `nothing serves on port ${port}`);
    return new Stream(channel.port1);
  }

  // The sandbox's connections to 127.0.0.1:`port`, answered here.
  async serve(port: number, onConnection: (stream: Stream) => void): Promise<() => Promise<void>> {
    this.servers.set(port, onConnection);
    await this.running().call('serveRemote', [[...this.servers.keys()]]);
    return async () => {
      this.servers.delete(port);
      await this.running().call('serveRemote', [[...this.servers.keys()]]);
    };
  }

  // Port `port`'s relay frame, ready (made once): the preview's requests
  // go through it to the project.
  relay(port: number): Promise<void> {
    const exec = this.running();
    return previewRelay(this.projectId, port, (requests) =>
      exec.call('relay', [requests], [requests]).catch(() => requests.close()),
    );
  }

  // Where to frame port `port`'s page at `path` (https://v-ID-PORT.…/path),
  // once its relay is ready.
  async previewUrl(port: number, path = '/'): Promise<string> {
    await this.relay(port);
    const origin = previewOrigin(this.projectId, port);
    if (!origin) throw new Error('no usercontent domain');
    return new URL(path, origin).href;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.exec.call('shutdown').catch(() => {});
    this.exec.close();
    this.frame.remove();
    forgetRelays();
    for (const process of this.processes.values()) process.exit({ code: null, signal: 'SIGKILL' });
    this.processes.clear();
    await Promise.all([...this.instances.values()].map((each) => each.close?.()));
  }

  // What the exec frame tells, and asks.
  /** @internal */
  listen(handlers: Record<string, (...args: never[]) => unknown>): void {
    const exec = this.exec;
    const on = <K extends keyof ExecEvents>(event: K, listener: (data: ExecEvents[K]) => void) =>
      exec.on<ExecEvents[K]>(event, (data) => {
        if (!this.closed) listener(data);
      });
    on('serving', ({ ports, port }) => {
      for (const each of ports) void this.relay(each).catch(() => {});
      this.serving = { ports, port };
      this.emit('serving', { ports, port });
    });
    on('changed', (paths) => this.emit('changed', paths));
    on('warning', (message) => this.emit('warning', message));
    on('processOutput', ({ id, fd, bytes }) => this.processes.get(id)?.output(fd, bytes));
    on('processStatus', ({ id, text }) => this.processes.get(id)?.status(text));
    on('processExit', ({ id, code, signal }) => {
      this.processes.get(id)?.exit({ code, signal });
      this.processes.delete(id);
    });
    exec.handle(handlers);
  }

  // A connection the sandbox made to a port the caller serves.
  /** @internal */
  served(port: number, stream: MessagePort): void {
    const serve = this.servers.get(port);
    if (serve) serve(new Stream(stream));
    else stream.close();
  }
}

// A project, run from this page.
export function create(options: CreateOptions): Promise<Sandbox> {
  return createSandbox(options);
}

// create() with the IDE's options too (PlaygroundOptions).
/** @internal */
export async function createSandbox(options: CreateOptions & PlaygroundOptions): Promise<Sandbox> {
  const { project: source, signal } = options;
  const progress = (phase: string, text: string) => options.onProgress?.({ phase, text });
  if (!crossOriginIsolated)
    throw new Error(
      'this page is not cross-origin isolated: serve it with Cross-Origin-Opener-Policy: ' +
        'same-origin and Cross-Origin-Embedder-Policy: require-corp',
    );
  if (source.persist && !source.id)
    throw failure('EINVAL', 'a kept project needs an id (project: { id, persist: true })');
  if (options.usercontent) useUsercontent(options.usercontent);
  else await loadSite();
  if (options.runtime) setRuntimePath(options.runtime);

  // The packages, the template among them, as the runtime reads them;
  // checked here first, so that a set that does not fit fails before any
  // frame starts (ERUNTIME).
  const { packages, apex } = flatten(options.plugins);
  const template = 'template' in source && source.template !== 'empty' ? source.template : null;
  if (template && !template.playground.template)
    throw failure('EINVAL', `${template.name} is not a template`);
  if (template && !packages.some(({ name }) => name === template.name)) packages.push(template);
  const manifest = siteOf(packages, options.boot ?? null);
  assertSite(manifest);
  const site = new Site({ url: location.href, manifest });
  const runtime = site.versions();
  if (!site.beam()) throw failure('ERUNTIME', 'no OTP package among the plugins');
  if (!site.elixir()) throw failure('ERUNTIME', 'no Elixir package among the plugins');
  if (!site.shell()) throw failure('ERUNTIME', 'no shell package among the plugins');

  // An archive's app over an empty project: its URL as this page resolves
  // it (the exec frame fetches it: CORS).
  const archive = 'archive' in source ? new URL(source.archive, location.href).href : null;
  const kind: WorkspaceKind =
    options.kind ?? (template?.playground.template?.kind === 'phoenix' ? 'phoenix' : 'empty');
  const key = source.id ? await keyFor(source.id) : newId();
  const persist = source.persist === true;
  const origin = execOrigin(key);
  if (!origin) throw new Error('no usercontent domain: create({ usercontent })');

  const startup = new AbortController();
  const abort = () => startup.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let exec: Rpc | null = null;
  let element: HTMLIFrameElement | null = null;
  const instances = new Map<string, ApexInstance>();
  try {
    progress('frame', 'Starting the project’s frame…');
    exec = await startExecFrame(
      origin,
      startup.signal,
      options.container ?? document.body,
      (frame) => {
        element = frame;
      },
    );
    options.connected?.(exec);
    for (const plugin of apex)
      instances.set(plugin.name, await plugin.apex({ projectId: key, persist }));
    startup.signal.throwIfAborted();
    const services = apexServices(
      [...instances.values()].map((instance) => instance.services ?? {}),
    );
    const handlers = Object.assign({}, ...[...instances.values()].map((each) => each.handlers));
    const sandbox = new Sandbox(
      exec,
      element!,
      key,
      template?.playground.fs?.root ?? '/work',
      runtime,
      { ...options.env },
      instances,
    );
    const way = wayOf(options.relay);
    // The claude package, whose frame makes Claude Code's files.
    const claude = packages.find(({ playground }) => playground.claudeCode);
    sandbox.listen({
      connect: (service: string, node: number, id: number, port: MessagePort) => {
        const served = service.match(/^port:(\d+)$/);
        if (served) return sandbox.served(Number(served[1]), port);
        services.connect(service, node, id, port);
      },
      // No tailnet without a plugin for it: other hosts are unreachable,
      // HTTPS by fetch().
      tailnetDial: (_host: unknown, _port: unknown, _proto: unknown, conn: unknown) => {
        if (conn instanceof MessagePort) conn.close();
        return false;
      },
      tailnetResolve: () => Promise.reject(new Error('no tailnet')),
      ...handlers,
      relayWay: (host: unknown) => way(host),
      claudePort: () =>
        claude
          ? claudePort(claude.base)
          : Promise.reject(new Error('no claude package among the plugins (docs/api.md)')),
    });
    let store: MessagePort | null = null;
    if (persist) {
      const channel = new MessageChannel();
      serveStore(channel.port1, filesStore(key));
      store = channel.port2;
    }
    const shared = options.shared ?? null;
    progress('files', 'Starting the files…');
    const started = await exec.call<{ archived: string[] }>(
      'start',
      [
        {
          kind,
          key,
          // The preview's framer: this page. The app's frame-ancestors
          // take it, its first frame tells it where it is (bridge.ts).
          ide: location.origin,
          build: runtimePath(),
          // Its bases below the exec frame's own origin.
          site: { url: `${origin}/`, manifest },
          store,
          shared,
          archive,
        } satisfies ExecStart,
      ],
      [store, shared].filter((port): port is MessagePort => port !== null),
    );
    startup.signal.throwIfAborted();
    if (archive) {
      if (!started.archived.length) throw new Error(`${archive}: no directory in it`);
      sandbox.root = started.archived[0];
    }
    progress('ready', 'Ready');
    return sandbox;
  } catch (error) {
    await exec?.call('shutdown').catch(() => {});
    exec?.close();
    (element as HTMLIFrameElement | null)?.remove();
    forgetRelays();
    await Promise.all([...instances.values()].map((each) => each.close?.()));
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
