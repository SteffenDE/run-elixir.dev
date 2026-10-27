// embed.html's core: what a project's page does on the apex
// (project/lib/playground.ts), without the IDE, for another site that
// frames it (docs/embed.md). It answers only the origins the site names
// (site.ts embedders, which Caddy's frame-ancestors names too), over the
// port its parent gave (protocol.ts). It frames the project's exec frame
// (exec/host.ts), keeps what is the apex's (the project's stores, PGlite,
// Hex's cache), makes the preview's relays, gives Claude Code's files
// (programs/claude/frame.ts), and carries connections to the ports its
// embedder answers. Processes are the exec frame's (its process API,
// which keeps a terminal's line discipline): their calls go there as they
// are.
import type { ExecEvents, ExecStart, ProcessStart } from '@/exec/host';
import type { Stat as FileStat } from '@/runtime/host/files';
import { serveStore } from '@/runtime/overlay';
import { fits } from '@/runtime/packages/check';
import { listed } from '@/runtime/relay';
import { claudePort } from '@/project/lib/programs/claude/frame';
import { PHOENIX_APP, type WorkspaceKind } from '@/project/lib/kinds';
import { forgetRelays, previewRelay } from '@/project/lib/previewOrigins';
import { apexServices, type ApexServices } from '@/project/lib/services';
import { BUILD, SITE, siteManifest } from '@/shared/lib/build';
import { Site } from '@/runtime/packages/manifest';
import { startExecFrame } from '@/shared/lib/execFrame';
import { isId, newId } from '@/shared/lib/ids';
import { Rpc } from '@/shared/lib/rpc';
import { embedders, execOrigin, previewOrigin } from '@/shared/lib/site';
import { filesStore } from '@/shared/lib/storage';
import {
  API_VERSION,
  CONNECT,
  LOADED,
  type CreateOptions,
  type Created,
  type DirEntry,
  type Events,
  type Hello,
  type ProcessRequest,
  type RuntimeVersions,
  type Stat,
  type WriteOptions,
} from './protocol';

const encoder = new TextEncoder();

// An error with POSIX's code, as the client throws it.
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

// The runtime's OTP and Elixir: its OTP and Elixir packages' (site.json).
const runtimeVersions = (): Promise<RuntimeVersions | null> =>
  siteManifest()
    .then((ref) => new Site(ref).versions())
    .catch(() => null);

// An embedder's own name for a project as a project's key (ten letters
// and digits, its origins' name): the same name is the same key.
async function keyFor(name: string): Promise<string> {
  if (isId(name)) return name;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(`run-elixir-embed:${name}`)),
  );
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(digest.subarray(0, 10), (byte) => alphabet[byte % 36]).join('');
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// One project per embed.html: its client's calls.
class Sandbox {
  exec: Rpc | null = null;
  frame: HTMLIFrameElement | null = null;
  services: ApexServices | null = null;
  key = '';
  root = '/work';
  env: Record<string, string> = {};
  // The hosts the embedder lets the project reach through the site's relay
  // (CreateOptions).
  relayHosts: string[] = [];
  served = new Set<number>();
  startup: AbortController | null = null;

  // client: its port; embedder: its origin, which frames the preview.
  constructor(
    private client: Rpc,
    private embedder: string,
  ) {}

  emit<K extends keyof Events>(event: K, data: Events[K], transfer: Transferable[] = []): void {
    this.client.emit(event, data, transfer);
  }

  running(): Rpc {
    if (!this.exec) throw failure('ENOTCONN', 'no project runs: create() first');
    return this.exec;
  }

  async hello(): Promise<Hello> {
    const runtime = await runtimeVersions();
    if (!runtime) throw new Error('this site names no OTP and Elixir packages (site.json)');
    return { apiVersion: API_VERSION, apiVersions: [API_VERSION], runtime };
  }

  async create(options: CreateOptions): Promise<Created> {
    if (this.exec || this.startup) throw new Error('a project runs here already');
    const runtime = await runtimeVersions();
    if (!runtime) throw failure('ERUNTIME', 'this site names no OTP and Elixir packages');
    const { otp = '*', elixir = '*' } = options.requires ?? {};
    if (!fits(runtime.otp, otp) || !fits(runtime.elixir, elixir))
      throw failure(
        'ERUNTIME',
        `run-elixir.dev runs OTP ${runtime.otp} and Elixir ${runtime.elixir}, ` +
          `not OTP ${otp} and Elixir ${elixir} as asked for`,
      );
    const source = options.project;
    if (source.persist && !source.id)
      throw failure('EINVAL', 'a kept project needs an id (project: { id, persist: true })');
    if (!crossOriginIsolated)
      throw new Error(
        'embed.html is not cross-origin isolated: the embedding page needs COOP same-origin and ' +
          'COEP require-corp, and its frame allow="cross-origin-isolated" (docs/embed.md)',
      );
    // An archive's app over an empty project: its URL as the embedder's
    // page resolves it (the exec frame fetches it: CORS).
    const archive = 'archive' in source ? new URL(source.archive, this.embedder).href : null;
    const kind: WorkspaceKind =
      'template' in source && source.template === 'phoenix' ? 'phoenix' : 'empty';
    this.key = source.id ? await keyFor(source.id) : newId();
    this.root = kind === 'phoenix' ? PHOENIX_APP : '/work';
    this.env = { ...options.env };
    this.relayHosts = [...(options.relay ?? [])];
    const origin = execOrigin(this.key);
    if (!origin) throw new Error("this site names no usercontent domain (playground.json's)");
    this.startup = new AbortController();
    const { signal } = this.startup;
    try {
      this.emit('progress', { phase: 'frame', text: 'Starting the project’s frame…' });
      const exec = await startExecFrame(origin, signal, document.body, (element) => {
        this.frame = element;
      });
      this.exec = exec;
      const persist = source.persist === true;
      this.services = apexServices(persist ? this.key : null, {});
      this.listen(exec);
      let store: MessagePort | null = null;
      if (persist) {
        const channel = new MessageChannel();
        serveStore(channel.port1, filesStore(this.key));
        store = channel.port2;
      }
      this.emit('progress', { phase: 'files', text: 'Starting the files…' });
      const started = await exec.call<{ archived: string[] }>(
        'start',
        [
          {
            kind,
            key: this.key,
            // The preview's framer, as the IDE is the playground's: the
            // app's frame-ancestors take it, its first frame tells it
            // where it is (bridge.ts).
            ide: this.embedder,
            build: BUILD,
            site: SITE,
            store,
            shared: null,
            archive,
          } satisfies ExecStart,
        ],
        store ? [store] : [],
      );
      signal.throwIfAborted();
      if (archive) {
        if (!started.archived.length) throw new Error(`${archive}: no directory in it`);
        this.root = started.archived[0];
      }
      this.emit('progress', { phase: 'ready', text: 'Ready' });
      return { projectId: this.key, runtime: runtime!, root: this.root };
    } catch (error) {
      await this.shutdown();
      throw error;
    } finally {
      this.startup = null;
    }
  }

  // What the exec frame tells, and asks.
  listen(exec: Rpc): void {
    const on = <K extends keyof ExecEvents>(event: K, listener: (data: ExecEvents[K]) => void) =>
      exec.on<ExecEvents[K]>(event, (data) => {
        if (this.exec === exec) listener(data);
      });
    on('serving', ({ ports, port }) => {
      for (const each of ports) void this.relay(each).catch(() => {});
      this.emit('serving', { ports, port });
    });
    on('changed', (paths) => this.emit('changed', paths));
    on('warning', (message) => this.emit('warning', message));
    on('processOutput', ({ id, fd, bytes }) =>
      this.emit('output', { id, fd, bytes }, [bytes.buffer]),
    );
    on('processExit', ({ id, code, signal }) => this.emit('exit', { id, code, signal }));
    exec.handle({
      connect: (service: string, node: number, id: number, port: MessagePort) => {
        const embedder = service.match(/^port:(\d+)$/);
        if (!embedder) return this.services?.connect(service, node, id, port);
        if (!this.served.has(Number(embedder[1]))) return port.close();
        this.emit('connection', { port: Number(embedder[1]), stream: port }, [port]);
      },
      // No tailnet here: other hosts are unreachable, HTTPS by fetch().
      tailnetDial: () => false,
      tailnetResolve: () => Promise.reject(new Error('no tailnet')),
      // The site's relay for the hosts the embedder's `relay` names.
      relayWay: (host: unknown) =>
        typeof host === 'string' && listed(host, this.relayHosts) ? 'relay' : 'none',
      claudePort,
    });
  }

  relay(port: number): Promise<void> {
    const exec = this.running();
    return previewRelay(this.key, port, (requests) =>
      exec.call('relay', [requests], [requests]).catch(() => requests.close()),
    );
  }

  // The files.
  read = (path: string) => this.running().call<Uint8Array>('read', [path]);

  async write(path: string, data: Uint8Array | string, options: WriteOptions = {}) {
    const exec = this.running();
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    const present = await exec.call<'file' | 'dir' | null>('stat', [path]);
    if (options.exclusive && present) throw failure('EEXIST', `${path}: exists already`);
    if (options.expectedSha256 !== undefined) {
      const now = present === 'file' ? await sha256(await this.read(path)) : '';
      if (now !== options.expectedSha256.toLowerCase())
        throw failure('ESTALE', `${path}: changed since it was read`);
    }
    if (present === 'dir') throw failure('EISDIR', `${path}: is a directory`);
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent) await exec.call('mkdir', [parent]);
    await exec.call('write', [path, bytes]);
  }

  async stat(path: string): Promise<Stat | null> {
    try {
      const { type, size, mtime } = await this.running().call<FileStat>('lstat', [path]);
      return { type, size, mtime };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(path: string): Promise<DirEntry[]> {
    const names = await this.running().call<string[]>('readdir', [path]);
    const entries = await Promise.all(
      names.map(async (name) => {
        const stat = await this.stat(`${path.replace(/\/$/, '')}/${name}`);
        return stat ? { name, ...stat } : null;
      }),
    );
    return entries.filter((entry): entry is DirEntry => entry !== null);
  }

  mkdir = (path: string) => this.running().call<void>('mkdir', [path]);

  async remove(path: string) {
    if (!(await this.stat(path))) throw failure('ENOENT', `${path}: no such file`);
    await this.running().call<void>('remove', [path]);
  }

  async rename(from: string, to: string) {
    if (!(await this.stat(from))) throw failure('ENOENT', `${from}: no such file`);
    await this.running().call<void>('rename', [from, to]);
  }

  async copy(from: string, to: string): Promise<void> {
    const stat = await this.stat(from);
    if (!stat) throw failure('ENOENT', `${from}: no such file`);
    if (stat.type === 'file') return this.write(to, await this.read(from));
    await this.mkdir(to);
    for (const entry of await this.list(from))
      await this.copy(`${from}/${entry.name}`, `${to}/${entry.name}`);
  }

  // A process, as id `id` (the client's): the exec frame's, with the
  // embedder's environment.
  async spawn(id: number, { argv, line, cwd, env, tty }: ProcessRequest) {
    await this.running().call('spawn', [
      id,
      {
        argv: argv ?? null,
        line: line ?? null,
        cwd: cwd ?? this.root,
        env: {
          // Claude Code for the Agent SDK (claude-agent-acp): the
          // playground's `claude` (docs/embed.md).
          CLAUDE_CODE_EXECUTABLE: '/usr/bin/claude',
          ...this.env,
          ...env,
        },
        tty: tty ?? null,
      } satisfies ProcessStart,
    ]);
  }

  input = (id: number, bytes: Uint8Array) =>
    void this.exec?.call('input', [id, bytes], [bytes.buffer]);
  closeInput = (id: number) => void this.exec?.call('closeInput', [id]);
  signal = (id: number, signal: number) => void this.exec?.call('signal', [id, signal]);
  resize = (id: number, cols: number, rows: number) =>
    void this.exec?.call('resize', [id, cols, rows]);

  // A connection to a server the sandbox runs on `port`, over `stream`.
  async connect(port: number, stream: MessagePort) {
    const done = await this.running().call<boolean>('connectServer', [port, stream], [stream]);
    if (!done) throw failure('ECONNREFUSED', `nothing serves on port ${port}`);
  }

  // The ports the embedder answers for the sandbox.
  async serve(ports: number[]) {
    this.served = new Set(ports);
    await this.running().call('serveRemote', [ports]);
  }

  // Where the embedder frames port `port`'s page at `path`, once its relay
  // is up.
  async previewUrl(port: number, path = '/'): Promise<string> {
    await this.relay(port);
    return new URL(path, previewOrigin(this.key, port)!).href;
  }

  async shutdown() {
    this.startup?.abort();
    const exec = this.exec;
    this.exec = null;
    await exec?.call('shutdown').catch(() => {});
    exec?.close();
    this.frame?.remove();
    this.frame = null;
    forgetRelays();
    await this.services?.close();
    this.services = null;
  }

  handlers(): Record<string, (...args: never[]) => unknown> {
    return {
      hello: () => this.hello(),
      create: (options: CreateOptions) => this.create(options),
      read: (path: string) => this.read(path),
      write: (path: string, data: Uint8Array | string, options?: WriteOptions) =>
        this.write(path, data, options),
      stat: (path: string) => this.stat(path),
      list: (path: string) => this.list(path),
      mkdir: (path: string) => this.mkdir(path),
      remove: (path: string) => this.remove(path),
      rename: (from: string, to: string) => this.rename(from, to),
      copy: (from: string, to: string) => this.copy(from, to),
      spawn: (id: number, request: ProcessRequest) => this.spawn(id, request),
      input: (id: number, bytes: Uint8Array) => this.input(id, bytes),
      closeInput: (id: number) => this.closeInput(id),
      signal: (id: number, signal: number) => this.signal(id, signal),
      resize: (id: number, cols: number, rows: number) => this.resize(id, cols, rows),
      connect: (port: number, stream: MessagePort) => this.connect(port, stream),
      serve: (ports: number[]) => this.serve(ports),
      previewUrl: (port: number, path?: string) => this.previewUrl(port, path),
      shutdown: () => this.shutdown(),
    };
  }
}

// The connection a client makes: from the parent, an allowed origin, once.
export function serveEmbedder(): void {
  const allowed = new Set(embedders());
  let taken = false;
  addEventListener('message', (event) => {
    const port = event.ports[0];
    if (event.source !== window.parent || event.data?.kind !== CONNECT || !port) return;
    if (!allowed.has(event.origin) || taken) {
      // Every call answered with why not.
      const why = taken
        ? 'embed.html serves one client'
        : `${event.origin} may not embed this site`;
      new Rpc(port).handle({
        hello: () => Promise.reject(failure('EACCES', why)),
      });
      return;
    }
    taken = true;
    const client = new Rpc(port);
    const sandbox = new Sandbox(client, event.origin);
    client.handle(sandbox.handlers());
    // For tests and the curious.
    Object.assign(window, { sandbox });
  });
  // Nothing in it but that the page can be driven: any parent may hear it.
  window.parent.postMessage({ kind: LOADED, apiVersions: [API_VERSION] }, '*');
}
