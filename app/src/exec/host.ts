// The worker that runs a project, in its exec frame on the usercontent
// domain (frames/exec.ts, docs/frames.md): the shared files, a node per
// shell and per command the nodes run, the page programs (Tailwind, with
// the project's plugins; esbuild; git), epmd, HTTPS by fetch, and the
// bridge to the app for the preview. The IDE's page on the apex drives it
// over a port (rpc.ts): calls in, events out. What the apex keeps for the
// project (its files' changes, its Postgres, Hex's cache) the apex
// answers: the files keep their changes through a port to its store, and
// the nodes' connections to Postgres and Hex go there (portConnection.ts).
//
// A worker, not the frame's page: a hidden frame of another site has its
// page's timers slowed to a second (WebKit, Firefox), a worker's not.
import { Bridge } from '@/runtime/bridge';
import { serveRelayRequests } from '@/runtime/relayRequests';
import { EPMD_PORT, EpmdRegistry, serveEpmd } from '@/runtime/epmd';
import { Files, type SearchQuery } from '@/runtime/host/files';
import { Git, type GitOptions } from '@/runtime/host/git';
import { ENV } from '@/runtime/setup';
import {
  CHUNK,
  FRAME,
  Node,
  type Connection,
  type Datagram,
  type Https,
  type Link,
  type NifBuild,
  type Served,
} from '@/runtime/host/node';
import { httpsByFetch, type Tunnel } from '@/runtime/https';
import { relay, relayed } from '@/runtime/relay';
import { dnsTcp, dnsUdp } from '@/runtime/dns';
import { carry } from '@/runtime/portConnection';
import { tailnet } from '@/tailscale/tailnet';
import { esbuild } from '@/project/lib/programs/esbuild';
import { inotifywait } from '@/project/lib/programs/inotifywait';
import { tailwind } from '@/project/lib/programs/tailwind';
import { filesChanged } from '@/project/lib/programs/watch';
import {
  nodeProgram,
  type Deliver,
  type Listener,
  type Ports,
} from '@/project/lib/programs/nodejs';
import type { KeptRecord } from '@/runtime/overlay';
import { claudeProgram } from '@/project/lib/programs/claude/claude';
import { npmProgram, npxProgram, type Program } from '@/project/lib/programs/npm';
import {
  commandProgram,
  rebar3Program,
  shProgram,
  type StartNode,
} from '@/project/lib/programs/node';
import { HEX_PORT, hexEnv } from '@/project/lib/hex';
import { setup as setupOf, type Setup, type WorkspaceKind } from '@/project/lib/kinds';
import { Rpc, transfer } from '@/shared/lib/rpc';
import { fileBytes, fileEntry, type Shared } from '@/shared/lib/share';
import { loadSite, previewOrigin, previewOrigins } from '@/shared/lib/site';

// What the IDE starts the project with.
export interface ExecStart {
  kind: WorkspaceKind;
  // The preview's key (a project's id, a temporary IEx's own): its
  // origins (site.ts previewOrigins).
  key: string;
  // The IDE's origin, which the preview's pages answer.
  ide: string;
  // The site's build and runtime paths (shared/lib/build.ts), on this
  // frame's origin as on the apex's (the same site's files).
  build: string;
  runtime: string;
  // Where the files keep their changes: a port to the apex's store, or
  // none (a temporary IEx keeps nothing).
  store: MessagePort | null;
  // /shared's store (the user's, every project's), if the project has it.
  shared?: MessagePort | null;
  // An app to start with, as a gzipped tar's URL (an embedder's:
  // docs/embed.md): its directories below /work, as a template's, over
  // the Phoenix server's boot image (OTP's and Elixir's files it reads).
  archive?: string | null;
}

// A shell's start (openShell).
export interface ShellStart {
  initial: string[];
  // The user's environment and the project's (settings.ts), under the
  // playground's own.
  env?: Record<string, string>;
}

// A command embed.html spawns for its embedder (docs/embed.md): `sh -c
// LINE` in a node of its own, or (line null) an interactive shell; with
// `tty`, its input and output are a terminal of that size (embed.html
// keeps its line discipline, as the IDE keeps a shell's), else pipes,
// its stderr apart from its stdout.
export interface SpawnStart {
  line: string | null;
  cwd: string;
  env: Record<string, string>;
  tty: { cols: number; rows: number } | null;
}

// What the host tells the IDE (events): see the handlers below.
export type ExecEvents = {
  output: { id: number; bytes: Uint8Array };
  status: { id: number; text: string };
  terminal: { id: number; raw: boolean; signals: boolean };
  // scripts: the ports Node.js processes serve on (programs/nodejs.ts).
  serving: {
    ports: number[];
    port: number | null;
    byShell: Record<number, number[]>;
    scripts: number[];
  };
  changed: string[];
  // What the files kept in /shared: the other projects open apply it.
  kept: KeptRecord[];
  warning: string;
  nif: NifBuild;
  // Something a node could not reach without Tailscale (the setup hint).
  blocked: string;
  // A spawned command's output (fd 1 or 2), exit, and terminal mode.
  spawnOutput: { id: number; fd: number; bytes: Uint8Array };
  spawnExit: { id: number; code: number };
  spawnTerminal: { id: number; raw: boolean; signals: boolean };
};

const PREVIEW_PORT = 4000;
const TAIL = 4096;
// The project's nodes' cookie (worker/index.ts gives it to a node whose
// command line names none).
const COOKIE = Array.from(crypto.getRandomValues(new Uint8Array(15)), (byte) =>
  String.fromCharCode(65 + (byte % 26)),
).join('');

// The IDE's port, which the frame's page hands over first.
let rpc: Rpc = null!;
let files: Files | null = null;
// The IDE's git (its changes view), once it first asks.
let git: Git | null = null;
let setup: Setup = setupOf('empty');
let start: ExecStart | null = null;
let bridge: Bridge | null = null;
let chosenPort: number | null = null;
let serveNames = serveEpmd(new EpmdRegistry());
// Shells by id, and every node (shells and the commands they run).
const shells = new Map<number, Node>();
// The commands embed.html spawned, by id, and how each ends.
const spawns = new Map<number, { node: Node; tty: boolean; end(code: number): void }>();
// The ports the apex answers for the project beyond its services (an
// embedder's serve(): docs/embed.md), carried there as Postgres is.
const remote = new Set<number>();
const nodes = new Set<Node>();
const commands = new Map<Node, string>();
const tails = new Map<Node, string>();
const ended: { command: string; code: number; output: string }[] = [];
const encoder = new TextEncoder();

function running(): Files {
  if (!files) throw new Error('the playground is not running');
  return files;
}

// A node's stand-in for the apex's services, which tell nodes apart.
const nodeIds = new WeakMap<object, number>();
let nextNodeId = 1;
const nodeId = (node: object) => {
  let id = nodeIds.get(node);
  if (id === undefined) nodeIds.set(node, (id = nextNodeId++));
  return id;
};

// A service the apex answers (Postgres, Hex's cache): the connection (a
// node's, or a Node.js process's) carried there.
function apex(service: string) {
  return (connection: Served) => {
    const channel = new MessageChannel();
    carry(connection, channel.port1);
    void rpc
      .call(
        'connect',
        [service, nodeId(connection.node), connection.id, channel.port2],
        [channel.port2],
      )
      .catch(() => connection.close());
  };
}

// The ports Node.js processes listen on (programs/nodejs.ts): what
// listens, and whether a server named the port (not 0, a free one).
const scripts = new Map<number, { listener: Listener; serving: boolean }>();
let ephemeralPort = 49152 + Math.floor(Math.random() * 16384);
const scriptPorts: Ports = {
  listen(port, listener) {
    const taken = (p: number) => scripts.has(p) || [...nodes].some((node) => node.listening.has(p));
    const serving = port !== 0;
    if (!serving)
      do {
        port = ephemeralPort;
        ephemeralPort = ephemeralPort >= 65535 ? 49152 : ephemeralPort + 1;
      } while (taken(port));
    else if (taken(port)) return null;
    scripts.set(port, { listener, serving });
    updatePeers();
    updateListening();
    return port;
  },
  unlisten(port, listener) {
    if (scripts.get(port)?.listener !== listener) return;
    scripts.delete(port);
    updatePeers();
    updateListening();
  },
  // A process's connection: to the services, as a node's goes, or to what
  // listens on the port; with a host, HTTPS by the gateway.
  route(port, host) {
    if (host !== undefined) return (connection) => httpsGateway(connection, { host, port });
    if (remote.has(port)) return apex(`port:${port}`);
    const service = services()[port];
    if (service) return service;
    const target =
      scripts.get(port)?.listener ?? [...nodes].find((node) => node.listening.has(port));
    return target ? (connection) => join(connection, target.connect(port)) : null;
  },
  // A process's connection to another host's address: through the
  // tailnet, as a node's goes (tailnet.ts outbound); else unreachable, and
  // the setup hint.
  async dial(connection, address, port) {
    const ways = tailnetWays();
    let closed = false;
    connection.onclose = () => (closed = true);
    const opened = await ways.tunnel(address, port).catch((error: Error & { code?: string }) => {
      throw Object.assign(error, { code: (error.code ?? 'ehostunreach').toUpperCase() });
    });
    if (!opened) {
      ways.blocked(address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`);
      throw Object.assign(new Error('network is unreachable'), { code: 'ENETUNREACH' });
    }
    if (closed) {
      opened.close();
      return undefined;
    }
    connection.ondata = (bytes) => opened.write(bytes);
    connection.onend = () => opened.end();
    connection.onclose = () => opened.close();
    opened.ondata = (bytes) => connection.write(bytes);
    // Ended with an error (a reset, the tunnel broken): the process sees
    // ECONNRESET, not the other end's FIN.
    opened.onend = (error) => {
      if (!error) return connection.end();
      connection.reset();
      opened.close();
    };
    return opened.local;
  },
  // A process's DNS message, answered as a node's (runtime/dns.ts).
  resolve: (query) => tailnetWays().resolve(query),
  // A process's UDP ports: datagrams to the machine's own address go to a
  // process's port, a node's, or the node's DNS on 53, from 127.0.0.1;
  // to another host, through the tailnet (one route per process, whose
  // answers come back to the port they were sent from).
  udp() {
    const mine = new Set<number>();
    const route = tailnetWays().udp();
    const unbind = (port: number) => {
      if (!mine.delete(port)) return;
      scriptUdp.delete(port);
      route.unbound?.(port);
    };
    return {
      bind(port, deliver) {
        const taken = (p: number) =>
          p === 53 || scriptUdp.has(p) || [...nodes].some((node) => node.udpPorts.has(p));
        if (port === 0)
          do {
            port = ephemeralPort;
            ephemeralPort = ephemeralPort >= 65535 ? 49152 : ephemeralPort + 1;
          } while (taken(port));
        else if (taken(port)) return null;
        mine.add(port);
        scriptUdp.set(port, deliver);
        return port;
      },
      unbind,
      send(datagram) {
        const { from, address, port, bytes } = datagram;
        if (!mine.has(from)) return;
        const reply: Deliver = (source, sourcePort, answer) =>
          scriptUdp.get(from)?.(source, sourcePort, answer);
        if (!loopback(address)) return route.send(datagram, reply);
        const process = scriptUdp.get(port);
        if (port === 53) dnsUdp(tailnetWays().resolve)(datagram, reply);
        else if (process) process('127.0.0.1', from, bytes);
        else
          [...nodes]
            .find((node) => node.udpPorts.has(port))
            ?.datagram(port, '127.0.0.1', from, bytes);
      },
      close() {
        for (const port of [...mine]) unbind(port);
      },
    };
  },
};

// The UDP ports Node.js processes have bound: where their datagrams go.
const scriptUdp = new Map<number, Deliver>();

const loopback = (address: string) =>
  /^127\./.test(address) || address === '::1' || address === 'localhost';

// Other hosts, names and HTTPS: through the user's tailnet, as the IDE's
// page lets them (docs/tailscale.md); else unreachable, no such name,
// fetch().
let ways: ReturnType<typeof tailnet> | null = null;
const tailnetWays = () => (ways ??= tailnet(rpc));

// HTTPS to a host, for the nodes and the Node.js processes, by the
// gateway (https.ts): through the tailnet where it takes it, else the
// site's relay for the hosts it carries (relay.ts), with their own TLS
// over its TCP (a process's: tls.ts); else fetch().
let gateway: Https | null = null;
let relayTunnel: ReturnType<typeof relay> | null = null;
const tunnel = (host: string, port: number): Promise<Tunnel | null> => {
  const tailnetTunnel = tailnetWays().tunnel(host, port);
  if (!relayed(host, port)) return tailnetTunnel;
  return tailnetTunnel.then((opened) => opened ?? (relayTunnel ??= relay())(host, port));
};
const httpsGateway: Https = (connection, target) =>
  (gateway ??= httpsByFetch({ tunnel, onblocked: tailnetWays().blocked }))(connection, target);

// What answers on the project's ports for every node and process, made
// once (each keeps what a connection needs with the connection).
let answering: Record<number, (connection: Served) => void> | null = null;
const services = () =>
  (answering ??= {
    5432: apex('postgres'),
    [HEX_PORT]: apex('hex'),
    [EPMD_PORT]: serveNames,
    // The node's DNS (127.0.0.53, setup.ts), over TCP and UDP.
    53: dnsTcp(tailnetWays().resolve),
  });

function updatePeers(): void {
  for (const node of nodes)
    node.peers([
      ...[...nodes].filter((other) => other !== node).flatMap((other) => [...other.listening]),
      ...scripts.keys(),
      ...remote,
    ]);
}

// A datagram a node sent to a UDP port of its own address's that a
// Node.js process or another node of the project has: there, from
// 127.0.0.1 as between processes on one machine.
function routeUdpPeer({ from, port, bytes }: Datagram, sender: Node): boolean {
  const process = scriptUdp.get(port);
  if (process) {
    process('127.0.0.1', from, bytes);
    return true;
  }
  const target = [...nodes].find((node) => node !== sender && node.udpPorts.has(port));
  target?.datagram(port, '127.0.0.1', from, bytes);
  return !!target;
}

// A connection a node opened to another node's port, or a Node.js
// process's: joined to one opened there.
function routePeer(connection: Connection, port: number): boolean {
  if (remote.has(port)) {
    apex(`port:${port}`)(connection);
    return true;
  }
  const target =
    [...nodes].find((node) => node !== connection.node && node.listening.has(port)) ??
    scripts.get(port)?.listener;
  if (!target) return false;
  join(connection, target.connect(port));
  return true;
}

// Two connections' ends, each writing what the other hears.
function join(connection: Link, other: Link): void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    connection.close();
    other.close();
  };
  connection.ondata = (bytes) => other.write(bytes);
  other.ondata = (bytes) => connection.write(bytes);
  connection.onend = () => other.end();
  other.onend = () => connection.end();
  connection.onclose = close;
  other.onclose = close;
}

// The page programs, for those that run others (npm: node, sh).
const pagePrograms = (): Record<string, Program> =>
  nodeServices().programs as Record<string, Program>;

function nodeServices() {
  const net = tailnetWays();
  return {
    peer: routePeer,
    udpPeer: routeUdpPeer,
    serve: services(),
    udpServe: { 53: dnsUdp(net.resolve) },
    outbound: net.outbound,
    udp: net.udp(),
    onnif: (build: NifBuild) => rpc.emit('nif', build),
    https: httpsGateway,
    programs: {
      tailwind,
      esbuild,
      inotifywait,
      node: nodeProgram(start!.build, () => files, scriptPorts, start!.runtime, pagePrograms),
      npm: npmProgram(pagePrograms),
      npx: npxProgram(pagePrograms),
      // Its files from the claude frame, through the IDE's page.
      claude: claudeProgram(pagePrograms, () => rpc.call<MessagePort>('claudePort')),
      sh: shProgram(startNode),
      // Claude Code's shell: bash -c -l LINE, as sh's.
      bash: shProgram(startNode),
      rebar3: rebar3Program(startNode),
      ...Object.fromEntries(
        ['mix', 'elixir', 'iex', 'erl', 'escript'].map((name) => [
          name,
          commandProgram(startNode, name),
        ]),
      ),
    },
  };
}

// A node for one command a node ran (sh, rebar3), in its own worker.
const startNode: StartNode = (command, { cwd, env, tty }, output, exit, terminal) => {
  if (!files || !start) {
    exit(1);
    return { stop() {} };
  }
  const node = new Node({
    base: start.build,
    runtime: start.runtime,
    files,
    ...nodeServices(),
    onoutput(bytes, fd) {
      tails.set(node, ((tails.get(node) ?? '') + new TextDecoder().decode(bytes)).slice(-TAIL));
      output(bytes, fd);
    },
    onexit(code) {
      ended.push({ command: commands.get(node) ?? '', code, output: tails.get(node) ?? '' });
      if (ended.length > 10) ended.shift();
      nodes.delete(node);
      commands.delete(node);
      tails.delete(node);
      updatePeers();
      exit(code);
    },
    onstatus(text) {
      if (!text.startsWith('failed')) return;
      output(encoder.encode(`${command[0]}: ${text}\n`), 2);
      exit(1);
    },
    onlistening: updatePeers,
    onterminal: (raw, signals) => terminal?.(raw, signals),
  });
  nodes.add(node);
  commands.set(node, command.join(' '));
  updatePeers();
  node.start({
    command,
    cwd,
    env: { ...env, PWD: cwd },
    boots: setup.boots,
    tty: [tty?.stdin ?? false, tty?.stdout ?? false],
  });
  return node;
};

// Which node answers a port: the one listening on it.
function nodeOn(port: number): Node | null {
  for (const node of shells.values()) if (node.listening.has(port)) return node;
  for (const { node } of spawns.values()) if (node.listening.has(port)) return node;
  return shells.values().next().value ?? null;
}

// What answers a port: a Node.js process listening there, or a node.
function listenerOn(port: number): Listener {
  return scripts.get(port)?.listener ?? nodeOn(port)!;
}

// The ports servers listen on, in the order they started.
let served: number[] = [];

// The ports the shells' nodes and the Node.js processes serve on, and the
// one the preview shows: Phoenix's, else the server that started last
// (Vite's, started after the backend it proxies to). Ephemeral listeners
// (Mix's compile lock) are no server.
function updateListening(): void {
  const ports = new Set<number>();
  const byShell: Record<number, number[]> = {};
  for (const [id, node] of shells) {
    byShell[id] = [...node.serving];
    for (const port of node.serving) ports.add(port);
  }
  for (const { node } of spawns.values()) for (const port of node.serving) ports.add(port);
  const fromScripts = [...scripts].filter(([, { serving }]) => serving).map(([port]) => port);
  for (const port of fromScripts) ports.add(port);
  served = served.filter((port) => ports.has(port));
  for (const port of ports) if (!served.includes(port)) served.push(port);
  const sorted = [...ports].sort((a, b) => a - b);
  const port = !ports.size
    ? null
    : (chosenPort ?? (ports.has(PREVIEW_PORT) ? PREVIEW_PORT : served.at(-1)!));
  if (bridge && port !== null) bridge.port = port;
  rpc.emit('serving', { ports: sorted, port, byShell, scripts: fromScripts });
}

// Where the preview shows a port, for the app (PLAYGROUND_PREVIEW_ORIGIN),
// and Livebook's iframe endpoint.
function previewEnv(): Record<string, string> {
  const origins = start && previewOrigins(start.key);
  return origins && start
    ? {
        PLAYGROUND_PREVIEW_ORIGIN: origins,
        LIVEBOOK_IFRAME_URL: `${previewOrigin(start.key, 8081)}/iframe/v6.html`,
      }
    : {};
}

// What this project changed over its template, to share (the IDE adds its
// name and template).
async function changes(hidden: string[]): Promise<Omit<Shared, 'name' | 'template'>> {
  const work = '/work';
  const [{ changed, removed }, site] = await Promise.all([
    running().changes(hidden),
    fetch(new URL('fs/version', new URL(start!.runtime, location.href))).then((response) =>
      response.text(),
    ),
  ]);
  const relative = (path: string) => path.slice(work.length + 1);
  const written = changed.filter(({ path }) => !path.includes('/priv/static/assets/'));
  return {
    v: 1,
    kind: start!.kind === 'phoenix' ? 'phoenix' : 'empty',
    site: site.trim(),
    files: Object.fromEntries(written.map(({ path, data }) => [relative(path), fileEntry(data)])),
    removed: removed.map(relative),
  };
}

// A change, then everything changed so far kept (files.js's flush).
async function kept(change: Promise<void>): Promise<void> {
  await change;
  await files?.flush();
}

const handlers = {
  // The files, from the site and the apex's store.
  async start(options: ExecStart) {
    start = {
      ...options,
      build: new URL(options.build, location.origin).href,
      runtime: new URL(options.runtime, location.origin).href,
    };
    setup = setupOf(options.kind);
    if (options.archive) setup = { ...setup, boots: setupOf('phoenix').boots };
    await loadSite();
    files = new Files({
      base: start.build,
      runtime: start.runtime,
      boots: setup.boots,
      template: setup.template,
      archive: options.archive ?? null,
      storePort: options.store,
      sharedPort: options.shared ?? null,
      onkept: (records) =>
        rpc.emit(
          'kept',
          records,
          records.flatMap((record) => (record.kind === 'file' ? [record.data.buffer] : [])),
        ),
      onchange: (paths: string[]) => {
        filesChanged(paths);
        rpc.emit('changed', paths);
      },
      onwarning: (message: string) => rpc.emit('warning', message),
    });
    await files.ready;
    bridge = new Bridge(
      { connect: (port: number) => listenerOn(port).connect(port) },
      PREVIEW_PORT,
      previewOrigins(options.key),
      options.ide,
    );
    chosenPort = null;
    served = [];
    bridge.onport = (port) => {
      chosenPort = port;
      updateListening();
    };
    // Where the project's app is: the archive's (its first directory).
    return { archived: files.archived.map((name) => `/work/${name}`) };
  },

  // A shared project's changes, over this project's template.
  async applyShared(shared: Shared) {
    const target = running();
    for (const path of shared.removed) await target.remove(`/work/${path}`).catch(() => {});
    for (const [path, entry] of Object.entries(shared.files)) {
      const file = `/work/${path}`;
      await target.mkdir(file.slice(0, file.lastIndexOf('/')));
      await target.write(file, fileBytes(entry));
    }
    await target.flush();
  },

  // The shared files, for the IDE (the tree, the editor, search, tests).
  list: (path: string, skip: string[]) => running().list(path, skip),
  stat: (path: string) => (files ? files.stat(path) : null),
  // POSIX's shapes (embed.html's fs), with their error codes.
  lstat: (path: string) => running().lstat(path),
  readdir: (path: string) => running().readdir(path),
  // git for the IDE itself (runtime/git.ts), not a node's: its output whole.
  async git(args: string[], options: GitOptions = {}) {
    if (!files || !start) throw new Error('no project');
    git ??= new Git({ base: start.build, runtime: start.runtime, files });
    const result = await git.run(args, options);
    return transfer(result, [result.stdout.buffer, result.stderr.buffer]);
  },
  async read(path: string) {
    const bytes = await running().read(path);
    return transfer(bytes, [bytes.buffer]);
  },
  // What the IDE changes (a save, the tree's operations) is kept before it
  // hears back: its page may go at once (a reload), and the frame with it.
  write: (path: string, data: string | Uint8Array) => kept(running().write(path, data)),
  // What another project kept in /shared.
  applyKept: (records: KeptRecord[]) => running().apply(records),
  // /shared hidden while a live session's guest may type.
  hideShared: (hide: boolean) => running().hideShared(hide),
  mkdir: (path: string) => kept(running().mkdir(path)),
  remove: (path: string) => kept(running().remove(path)),
  rename: (from: string, to: string) => kept(running().rename(from, to)),
  search: (path: string, query: SearchQuery, skip: string[]) => running().search(path, query, skip),
  flush: () => files?.flush(),
  changes,
  // A save: the watchers hear of it (the IDE writes, then says so).
  saved: (path: string) => filesChanged([path]),

  // A shell (terminal tab `id`): its node, which runs the shell.
  openShell(id: number, { initial, env = {} }: ShellStart) {
    if (!files || !start) throw new Error('the playground is not running');
    const node = new Node({
      base: start.build,
      runtime: start.runtime,
      files,
      ...nodeServices(),
      onoutput: (bytes) => rpc.emit('output', { id, bytes }),
      onstatus: (text) => rpc.emit('status', { id, text }),
      onlistening() {
        updateListening();
        updatePeers();
      },
      onterminal: (raw, signals) => rpc.emit('terminal', { id, raw, signals }),
    });
    shells.set(id, node);
    nodes.add(node);
    updatePeers();
    node.start({
      shell: true,
      initial,
      cwd: '/work',
      boots: setup.boots,
      env: { ...env, ...ENV, ...hexEnv, PLAYGROUND_COOKIE: COOKIE, ...previewEnv() },
    });
  },
  input: (id: number, text: string) => shells.get(id)?.input(text),
  interrupt: (id: number) => shells.get(id)?.interrupt(),
  terminate: (id: number) => shells.get(id)?.terminate(),
  resize: (id: number, columns: number, rows: number) => shells.get(id)?.resize(columns, rows),
  closeShell(id: number) {
    const node = shells.get(id);
    node?.stop();
    if (node) nodes.delete(node);
    shells.delete(id);
    updatePeers();
    updateListening();
  },

  // A command for embed.html's embedder (SpawnStart), as id `id`.
  spawn(id: number, { line, cwd, env, tty }: SpawnStart) {
    if (!files || !start) throw new Error('the playground is not running');
    let over = false;
    const end = (code: number) => {
      if (over) return;
      over = true;
      node.stop();
      nodes.delete(node);
      spawns.delete(id);
      updatePeers();
      updateListening();
      rpc.emit('spawnExit', { id, code });
    };
    const node = new Node({
      base: start.build,
      runtime: start.runtime,
      files,
      ...nodeServices(),
      onoutput: (bytes, fd) => rpc.emit('spawnOutput', { id, fd, bytes }, [bytes.buffer]),
      onstatus(text) {
        if (!text.startsWith('failed')) return;
        rpc.emit('spawnOutput', { id, fd: 2, bytes: encoder.encode(`${text}\n`) });
        end(1);
      },
      onexit: end,
      onlistening() {
        updateListening();
        updatePeers();
      },
      onterminal: (raw, signals) => rpc.emit('spawnTerminal', { id, raw, signals }),
    });
    spawns.set(id, { node, tty: !!tty, end });
    nodes.add(node);
    updatePeers();
    if (tty) node.resize(tty.cols, tty.rows);
    node.start({
      ...(line === null ? { shell: true } : { command: ['sh', '-c', line] }),
      cwd,
      boots: setup.boots,
      env: { ...hexEnv, PLAYGROUND_COOKIE: COOKIE, ...previewEnv(), ...env, PWD: cwd },
      tty: [!!tty, !!tty],
    });
  },
  // Its input: a terminal's keys (as embed.html's line discipline passes
  // them), or a pipe's bytes; and their end.
  spawnInput(id: number, bytes: Uint8Array) {
    const spawned = spawns.get(id);
    if (!spawned) return;
    for (let at = 0; at < bytes.length; at += CHUNK)
      spawned.node.frame(FRAME.INPUT, spawned.tty ? 0 : 1, bytes.subarray(at, at + CHUNK));
  },
  spawnEnd(id: number) {
    const spawned = spawns.get(id);
    if (spawned?.tty) spawned.node.frame(FRAME.INPUT, 0, Uint8Array.of(4));
    else spawned?.node.frame(FRAME.INPUT, 2);
  },
  spawnResize: (id: number, cols: number, rows: number) => spawns.get(id)?.node.resize(cols, rows),
  // A signal: SIGINT is Ctrl+C's (a node's break, a program's stop);
  // another stops it at once, its status 128 + the signal's.
  spawnKill(id: number, signal: number) {
    const spawned = spawns.get(id);
    if (signal === 2) spawned?.node.interrupt();
    else spawned?.end(128 + signal);
  },
  // The ports the apex answers (embed.html's embedder's serve()).
  serveRemote(ports: number[]) {
    remote.clear();
    for (const port of ports) remote.add(port);
    updatePeers();
  },

  // A connection to a server a node or a Node.js process runs on `port` (a
  // live session's guest's preview), carried on the port the IDE gave.
  connectServer(port: number, through: MessagePort) {
    const script = scripts.get(port);
    if (script?.serving) {
      carry(script.listener.connect(port), through);
      return true;
    }
    for (const node of [...shells.values(), ...[...spawns.values()].map((each) => each.node)])
      if (node.serving.has(port)) {
        carry(node.connect(port), through);
        return true;
      }
    through.close();
    return false;
  },

  // A relay of the preview's (previewOrigins.ts), and which port it shows.
  relay: (port: MessagePort) => serveRelayRequests(port, () => bridge),
  previewShows(port: number) {
    chosenPort = port;
    updateListening();
  },

  // The bridge's cookie jar (preview.spec), and what is under way.
  cookieHeader: (jar?: string) => bridge?.cookieHeader(jar) ?? null,
  remember(cookie: string) {
    const sets: string[] = [];
    bridge?.remember(cookie, sets);
    return sets;
  },
  debug: () => ({
    bridge: bridge?.debug(),
    nodes: Object.fromEntries([...shells].map(([id, node]) => [id, node.debug()])),
    commands: [...commands].map(([node, command]) => ({
      command,
      output: tails.get(node) ?? '',
      ...node.debug(),
    })),
    ended,
  }),

  // Keep what changed and stop every node: the project runs elsewhere now.
  async shutdown() {
    await files?.flush().catch(() => {});
    for (const node of nodes) node.stop();
    nodes.clear();
    spawns.clear();
    remote.clear();
    scripts.clear();
    scriptUdp.clear();
    shells.clear();
    git?.stop();
    git = null;
    files?.worker.terminate();
    files = null;
    serveNames = serveEpmd(new EpmdRegistry());
  },
};

self.onmessage = ({ data, ports }: MessageEvent) => {
  if (data?.kind !== 'playground-exec' || rpc || !ports[0]) return;
  rpc = new Rpc(ports[0]).handle(handlers);
};
