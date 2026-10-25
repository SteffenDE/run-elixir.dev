// embed.html's core: what a project's page does on the apex
// (project/lib/playground.ts), without the IDE, for another site that
// frames it (docs/embed.md). It answers only the origins the site names
// (site.ts embedders, which Caddy's frame-ancestors names too), over the
// port its parent gave (protocol.ts). It frames the project's exec frame
// (exec/host.ts), keeps what is the apex's (the project's stores, PGlite,
// Hex's cache), makes the preview's relays, gives Claude Code's files
// (programs/claude/frame.ts), keeps each terminal's line discipline, and
// carries connections to the ports its embedder answers.
import type { ExecEvents, ExecStart, SpawnStart } from '@/exec/host';
import type { Stat as FileStat } from '@/runtime/host/files';
import { serveStore } from '@/runtime/overlay';
import { REPORT, lineDiscipline } from '@/runtime/terminal';
import { claudePort } from '@/project/lib/programs/claude/frame';
import { PHOENIX_APP, type WorkspaceKind } from '@/project/lib/kinds';
import { forgetRelays, previewRelay } from '@/project/lib/previewOrigins';
import { apexServices, type ApexServices } from '@/project/lib/services';
import { BUILD, RUNTIME } from '@/shared/lib/build';
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
  type RuntimeVersions,
  type SpawnOptions,
  type Stat,
  type WriteOptions,
} from './protocol';

const encoder = new TextEncoder();

// An error with POSIX's code, as the client throws it.
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

// The runtime's OTP and Elixir (runtime/build.py's runtime.json).
let versions: Promise<RuntimeVersions | null> | null = null;
const runtimeVersions = () =>
  (versions ??= fetch(new URL('runtime.json', new URL(RUNTIME, location.href)))
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null));

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

const quote = (word: string) =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

// A terminal's output as a tty's ONLCR has it: a newline is CR LF (the
// nodes write bare newlines; the IDE's xterm converts them itself).
function onlcr(): (bytes: Uint8Array) => Uint8Array {
  let carriage = false;
  return (bytes) => {
    let extra = 0;
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i] === 10 && !(i ? bytes[i - 1] === 13 : carriage)) extra++;
    if (!extra) {
      if (bytes.length) carriage = bytes[bytes.length - 1] === 13;
      return bytes;
    }
    const out = new Uint8Array(bytes.length + extra);
    let at = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 10 && !(i ? bytes[i - 1] === 13 : carriage)) out[at++] = 13;
      out[at++] = bytes[i];
    }
    carriage = bytes[bytes.length - 1] === 13;
    return out;
  };
}

// A spawned command, as embed.html keeps it: a terminal's line
// discipline and output conversion (with a tty), and how its keys decode.
interface Spawned {
  tty: boolean;
  keys?: (data: string) => void;
  raw?: (on: boolean, signals: boolean) => void;
  output?: (bytes: Uint8Array) => Uint8Array;
  decoder: TextDecoder;
}

// One project per embed.html: its client's calls.
class Sandbox {
  exec: Rpc | null = null;
  frame: HTMLIFrameElement | null = null;
  services: ApexServices | null = null;
  key = '';
  root = '/work';
  env: Record<string, string> = {};
  // The embedder let the project use the site's relay (CreateOptions).
  relayAllowed = false;
  spawned = new Map<number, Spawned>();
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
    if (!runtime) throw new Error('this site names no runtime versions (runtime.json)');
    return { apiVersion: API_VERSION, apiVersions: [API_VERSION], runtime };
  }

  async create(options: CreateOptions): Promise<Created> {
    if (this.exec || this.startup) throw new Error('a project runs here already');
    const runtime = await runtimeVersions();
    const wanted = options.runtime;
    if (!runtime || runtime.otp !== wanted?.otp || runtime.elixir !== wanted?.elixir)
      throw failure(
        'ERUNTIME',
        `run-elixir.dev runs OTP ${runtime?.otp ?? '?'} and Elixir ${runtime?.elixir ?? '?'}, ` +
          `not the OTP ${wanted?.otp} and Elixir ${wanted?.elixir} asked for`,
      );
    if (!crossOriginIsolated)
      throw new Error(
        'embed.html is not cross-origin isolated: the embedding page needs COOP same-origin and ' +
          'COEP require-corp, and its frame allow="cross-origin-isolated" (docs/embed.md)',
      );
    const source = options.project;
    // An archive's app over an empty project: its URL as the embedder's
    // page resolves it (the exec frame fetches it: CORS).
    const archive = 'archive' in source ? new URL(source.archive, this.embedder).href : null;
    const kind: WorkspaceKind =
      'template' in source && source.template === 'phoenix' ? 'phoenix' : 'empty';
    this.key = source.id ? await keyFor(source.id) : newId();
    this.root = kind === 'phoenix' ? PHOENIX_APP : '/work';
    this.env = { ...options.env };
    this.relayAllowed = options.relay === true;
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
      const persist = options.persist === true;
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
            runtime: RUNTIME,
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
    on('spawnOutput', ({ id, fd, bytes }) => {
      const spawned = this.spawned.get(id);
      const out = spawned?.output ? spawned.output(bytes) : bytes;
      // On a terminal both are the terminal (a shell draws its prompt on
      // stderr, as bash does).
      this.emit('output', { id, fd: spawned?.tty ? 1 : fd, bytes: out }, [out.buffer]);
    });
    on('spawnTerminal', ({ id, raw, signals }) => this.spawned.get(id)?.raw?.(raw, signals));
    on('spawnExit', ({ id, code }) => {
      this.spawned.delete(id);
      this.emit('exit', { id, code });
    });
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
      // The site's relay for its hosts, as the embedder's `relay` says.
      relayWay: () => (this.relayAllowed ? 'relay' : 'none'),
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

  // A command: a shell line or its words, as id `id` (the client's).
  async spawn(id: number, command: string | string[] | null, options: SpawnOptions = {}) {
    const exec = this.running();
    const tty = options.tty ?? null;
    const line = Array.isArray(command) ? command.map(quote).join(' ') : command;
    const spawned: Spawned = { tty: !!tty, decoder: new TextDecoder() };
    if (tty) {
      const input = (text: string) => void exec.call('spawnInput', [id, encoder.encode(text)]);
      const discipline = lineDiscipline(
        (text) => {
          const bytes = encoder.encode(text);
          this.emit('output', { id, fd: 1, bytes }, [bytes.buffer]);
        },
        { input, interrupt: () => void exec.call('spawnKill', [id, 2]) },
      );
      // A terminal's own reports (the cursor's position, which brush's
      // line editor asks for) go to the program as they are.
      spawned.keys = (data) => (REPORT.test(data) ? input(data) : discipline.keys(data));
      spawned.raw = (on, signals) => discipline.raw(on, signals);
      spawned.output = onlcr();
    }
    this.spawned.set(id, spawned);
    await exec.call('spawn', [
      id,
      {
        line,
        cwd: options.cwd ?? this.root,
        env: {
          // Claude Code for the Agent SDK (claude-agent-acp): the
          // playground's `claude` (docs/embed.md).
          CLAUDE_CODE_EXECUTABLE: '/usr/bin/claude',
          ...this.env,
          ...options.env,
        },
        tty,
      } satisfies SpawnStart,
    ]);
  }

  input(id: number, bytes: Uint8Array) {
    const spawned = this.spawned.get(id);
    if (!spawned) return;
    if (spawned.keys) spawned.keys(spawned.decoder.decode(bytes, { stream: true }));
    else void this.running().call('spawnInput', [id, bytes], [bytes.buffer]);
  }

  closeStdin = (id: number) => void this.exec?.call('spawnEnd', [id]);
  kill = (id: number, signal: number) => void this.exec?.call('spawnKill', [id, signal]);
  resize = (id: number, cols: number, rows: number) =>
    void this.exec?.call('spawnResize', [id, cols, rows]);

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

  // Where the embedder frames port `port`'s preview, once its relay is up.
  async previewOrigin(port: number): Promise<string> {
    await this.relay(port);
    return previewOrigin(this.key, port)!;
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
    this.spawned.clear();
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
      spawn: (id: number, command: string | string[] | null, options?: SpawnOptions) =>
        this.spawn(id, command, options),
      input: (id: number, bytes: Uint8Array) => this.input(id, bytes),
      closeStdin: (id: number) => this.closeStdin(id),
      kill: (id: number, signal: number) => this.kill(id, signal),
      resize: (id: number, cols: number, rows: number) => this.resize(id, cols, rows),
      connect: (port: number, stream: MessagePort) => this.connect(port, stream),
      serve: (ports: number[]) => this.serve(ports),
      previewOrigin: (port: number) => this.previewOrigin(port),
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
