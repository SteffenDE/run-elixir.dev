// The page's side of a playground node (worker.js): start it, type into it,
// interrupt it, and connect to it or let it connect out.
//
// The page writes to the worker through frames in a SharedArrayBuffer ring
// (the worker sleeps on its write count, so a frame wakes it):
// [kind u8][id u32][length u32][payload]. The worker answers with
// messages.
import { Site, type SiteRef } from '../packages/manifest';
import type { Files, FilesChannel } from './files';
import { spawn, type PageProcess, type PageProgram } from './programs';
import { trace } from '../trace';
import { local } from '../wasi/net';
import { worker } from './worker';

export const FRAME = {
  INPUT: 0,
  OPEN: 1,
  DATA: 2,
  END: 3,
  CLOSE: 4,
  INTERRUPT: 5,
  OUTPUT: 7,
  EXIT: 8,
  RESIZE: 9,
  // The ports the project's other nodes listen on (u16s, big-endian).
  PEERS: 10,
  // Stop what runs now, at once (not Ctrl+C: a node's SIGINT).
  TERMINATE: 11,
  // How dialing a connection the node opened to another host went (an
  // int8: 1, or a negative errno), and once connected, its local end: the
  // family (4 or 6), address (4 or 16 bytes) and port (u16, big-endian).
  CONNECTED: 12,
  // A datagram for the node's UDP port (the id): the source's port (u16,
  // big-endian), family (4 or 6) and address (4 or 16 bytes), the bytes.
  DATAGRAM: 13,
  // A page program set the terminal's input mode: raw (u8), signals (u8:
  // whether Ctrl+C still interrupts).
  MODE: 14,
  // A page program took this many bytes (u32) of what the worker sent it
  // (`stdin`): the worker sends more as it takes them.
  TAKEN: 15,
  // A page program's standard error (OUTPUT is its standard output).
  OUTPUT_ERR: 16,
} as const;
export const RING = 1 << 20;
export const CHUNK = 1 << 16;

// Why a connection closed: the peer closed it, or (connecting) nothing
// listened.
export type CloseReason = 'close' | 'refused';

// A connection between the page and the node.
export class Connection {
  node: Node;
  id: number;
  ondata: (bytes: Uint8Array) => void;
  onend: () => void;
  onclose: (why?: CloseReason) => void;
  // For debug(): when it opened, bytes each way, and how it ended.
  opened = Date.now();
  port = 0;
  sent = 0;
  received = 0;
  ended: string | null = null;

  constructor(node: Node, id: number) {
    this.node = node;
    this.id = id;
    this.ondata = () => {};
    this.onend = () => {};
    this.onclose = () => {};
  }
  write(bytes: Uint8Array): void {
    this.sent += bytes.length;
    trace('net', `page → node ${this.id}: ${bytes.length} bytes`);
    for (let at = 0; at < bytes.length; at += CHUNK) {
      this.node.frame(FRAME.DATA, this.id, bytes.subarray(at, at + CHUNK));
    }
  }
  end(): void {
    trace('net', `page → node ${this.id}: end`);
    this.node.frame(FRAME.END, this.id);
  }
  close(): void {
    trace('net', `page → node ${this.id}: close`);
    this.ended ??= 'closed by the page';
    this.node.frame(FRAME.CLOSE, this.id);
    this.node.forget(this);
  }
  // A connection the node opened to another host (outbound): dialed (from
  // `local`, address:port, if it is known), or not (`errno`, negative, as
  // WASI numbers it: ECONNREFUSED -14, EHOSTUNREACH -23, ENETUNREACH -40,
  // ETIMEDOUT -73).
  dialed(from?: string): void {
    trace('net', `page → node ${this.id}: connected${from ? ` from ${from}` : ''}`);
    const at = from?.lastIndexOf(':') ?? -1;
    if (!from || at < 0) return this.node.frame(FRAME.CONNECTED, this.id, new Uint8Array([1]));
    const address = addressBytes(from.slice(0, at));
    const port = Number(from.slice(at + 1));
    this.node.frame(
      FRAME.CONNECTED,
      this.id,
      new Uint8Array([1, ...address, port >> 8, port & 255]),
    );
  }
  refuse(errno: number): void {
    trace('net', `page → node ${this.id}: not connected (${errno})`);
    this.ended ??= `not connected (${errno})`;
    this.node.frame(FRAME.CONNECTED, this.id, new Uint8Array([errno & 255]));
    this.node.forget(this);
  }
  describe() {
    return {
      id: this.id,
      port: this.port,
      age: `${((Date.now() - this.opened) / 1000).toFixed(1)} s`,
      sent: this.sent,
      received: this.received,
      ended: this.ended,
    };
  }
}

// A connection to what listens on a port: a node's (Connection), or a
// Node.js process's (programs/nodejs.ts).
export type Link = Pick<Connection, 'ondata' | 'onend' | 'onclose' | 'write' | 'end' | 'close'>;

// A connection a page service answers (postgres.ts, epmd.ts, fetcher.ts,
// https.ts): a node's, or a Node.js process's; `node` is whose.
export type Served = Link & { node: object; id: number };

// make waiting for the backend to build a package's NIF library (onnif).
export interface NifBuild {
  name: string;
  version: string;
  status:
    | 'queued'
    | 'running'
    | 'setting_up'
    | 'succeeded'
    | 'failed'
    | 'unsupported'
    | 'interrupted';
  error: string | null;
}

export type Https = (connection: Served, target: { host: string; port: number }) => void;
// A connection the node opens to another host: the page dials it, and
// says so (connection.dialed(), or refuse(errno)).
export type Outbound = (connection: Connection, target: { address: string; port: number }) => void;

// A datagram from the node's UDP port `from` to `address`:`port`;
// reply(address, port, bytes) sends one back to that port.
export interface Datagram {
  from: number;
  address: string;
  port: number;
  bytes: Uint8Array;
}
export type Reply = (address: string, port: number, bytes: Uint8Array) => void;
export type UdpService = (datagram: Datagram, reply: Reply) => void;
// Datagrams to other hosts; unbound(port): the node closed that port.
export interface UdpRoute {
  send: UdpService;
  unbound?(port: number): void;
}

// An address as socket.js writes it (a.b.c.d, or hex groups, '::' too)
// as bytes: [family, ...4 or 16 bytes].
export function addressBytes(address: string): Uint8Array {
  if (!address.includes(':')) return new Uint8Array([4, ...address.split('.').map(Number)]);
  const [head, tail = null] = address.replace(/^\[|\]$/g, '').split('::');
  const left = head ? head.split(':') : [];
  const right = tail === null ? [] : tail ? tail.split(':') : [];
  const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const out = new Uint8Array(17);
  out[0] = 6;
  words.forEach((word, i) => {
    const value = parseInt(word, 16) || 0;
    out[1 + 2 * i] = value >> 8;
    out[2 + 2 * i] = value & 255;
  });
  return out;
}

// What the node's worker tells the page (worker.js).
type NetMessage = {
  kind: 'net';
  op: 'open' | 'dial' | 'data' | 'end' | 'close' | 'refused';
  id: number;
  port?: number;
  host?: string;
  payload?: Uint8Array;
};
// A datagram from the node's port `from`, or that it bound or closed it.
type UdpMessage = {
  from: number;
  address?: string;
  port?: number;
  payload?: Uint8Array;
  bound?: boolean;
  closed?: boolean;
};
export type SpawnMessage = {
  kind: 'spawn';
  id: number;
  name: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  // Whether its stdin and stdout are the terminal.
  tty?: boolean[];
};
type NodeMessage =
  | { kind: 'out'; payload: Uint8Array }
  // Its standard error (fd 2), apart.
  | { kind: 'err'; payload: Uint8Array }
  | { kind: 'status'; payload: string }
  | { kind: 'exit'; payload: number }
  | { kind: 'tty'; raw: boolean; signals?: boolean }
  | { kind: 'stdin'; id: number; bytes?: Uint8Array; end?: boolean }
  | ({ kind: 'nif' } & NifBuild)
  | NetMessage
  | ({ kind: 'udp' } & UdpMessage)
  | { kind: 'listening'; port: number; on: boolean; ephemeral: boolean }
  | SpawnMessage
  | { kind: 'kill'; id: number };

// One of a site's WebAssembly modules (beam.wasm, brush.wasm, coreutils.wasm),
// compiled once on the page for every node's worker (a compiled module
// posts to a worker as it is); null when the site has none.
const modules = new Map<string, Promise<WebAssembly.Module | null>>();
function siteModule(location: URL | null): Promise<WebAssembly.Module | null> {
  if (!location) return Promise.resolve(null);
  const url = location.href;
  let module = modules.get(url);
  if (!module) {
    module = fetch(url)
      .then(async (response) => {
        const bytes = new Uint8Array(await response.arrayBuffer());
        return response.ok && bytes[0] === 0 && bytes[1] === 0x61
          ? WebAssembly.compile(bytes)
          : null;
      })
      .catch(() => null);
    modules.set(url, module);
  }
  return module;
}

export class Node {
  https: Https | null;
  outbound: Outbound | null;
  udpServe: Record<number, UdpService>;
  udp: UdpRoute | null;
  // The node's UDP ports, and a datagram it sent to one of its own
  // addresses' that neither it nor the page has: taken by another node
  // of the project (project/lib/playground.ts), or false.
  udpPorts = new Set<number>();
  udpPeer: (datagram: Datagram, node: Node) => boolean;
  files: Files | null;
  listening: Set<number>;
  serving: Set<number>;
  programs: Record<string, PageProgram>;
  running: Map<number, PageProcess>;
  // The terminal's size, as last resized.
  size: number[] = [80, 24];
  shared: SharedArrayBuffer;
  control: Int32Array;
  ring: Uint8Array;
  pending: Uint8Array[];
  connections: Map<number, Connection>;
  next: number;
  serve: Record<number, (connection: Served) => void>;
  // A connection the node opened to a port another node listens on: taken
  // there (project/lib/playground.ts), or false.
  peer: (connection: Connection, port: number) => boolean;
  worker: Worker;
  site: SiteRef;
  channel: FilesChannel | null = null;
  retry: ReturnType<typeof setTimeout> | null = null;
  // For debug(): connections that ended lately, and what the worker sent
  // (how many of each kind, and when last).
  recent: Connection[] = [];
  fromWorker: Record<string, { count: number; last: number }> = {};
  // The page programs it runs: their command lines, and since when.
  spawned = new Map<number, { command: string; started: number }>();

  // base: where the site's runtime scripts are; site: the site manifest,
  // which names its BEAM, files, programs and NIF libraries; onoutput(bytes,
  // fd): what it wrote to its output (1) or its standard error (2),
  // onstatus(text), onexit(code); serve: { port: (connection) => ... } for
  // ports the node may connect to on the page; https: (connection,
  // { host, port }) => ..., HTTPS the page carries for the node
  // (/.net/https, https.ts), or null; outbound: (connection, { address,
  // port }) => ..., the node's connections to other hosts (unreachable
  // without); udpServe: { port: (datagram, reply) => ... }, the page's UDP
  // ports (53: DNS); udp: { send(datagram, reply), unbound(port) },
  // datagrams to other hosts (dropped without); files: a Files the node
  // shares /work and /tmp with; onlistening(port, on): the node started or
  // stopped listening on a port. `listening` holds every port it listens
  // on; `serving` only those it named (a server's, not an ephemeral port
  // it asked for with 0, as Mix's lock does).
  // programs: { name: (process, { args, cwd, env, fs }) => ... }, programs
  // the node may spawn that run on the page (they may be async):
  // process.write(text | bytes), process.exit(code), process.onkill.
  // onterminal(raw, signals): the node set its terminal to raw input (keys
  // go to it as typed) or back to lines; signals: Ctrl+C still interrupts
  // (not after a page program's setRawMode). onnif({ name, version, status, error }):
  // make waits for the backend to build a package's NIF library (status
  // queued, running or setting_up), or stopped waiting (succeeded, failed,
  // unsupported, interrupted).
  constructor({
    base = './',
    site = null as unknown as SiteRef,
    onoutput = (_bytes: Uint8Array, _fd: number) => {},
    onstatus = (_text: string) => {},
    onexit = (_code: number) => {},
    serve = {} as Record<number, (connection: Served) => void>,
    https = null as Https | null,
    outbound = null as Outbound | null,
    udpServe = {} as Record<number, UdpService>,
    udp = null as UdpRoute | null,
    udpPeer = (_datagram: Datagram, _node: Node) => false,
    programs = {} as Record<string, PageProgram>,
    files = null as Files | null,
    onlistening = (_port: number, _on: boolean) => {},
    onterminal = (_raw: boolean, _signals: boolean) => {},
    onnif = (_build: NifBuild) => {},
    peer = (_connection: Connection, _port: number) => false,
  }) {
    this.peer = peer;
    this.https = https;
    this.outbound = outbound;
    this.udpServe = udpServe;
    this.udp = udp;
    this.udpPeer = udpPeer;
    this.files = files;
    this.listening = new Set();
    this.serving = new Set();
    this.programs = programs;
    this.running = new Map();
    this.shared = new SharedArrayBuffer(8 + RING);
    this.control = new Int32Array(this.shared, 0, 2);
    this.ring = new Uint8Array(this.shared, 8, RING);
    this.pending = [];
    this.connections = new Map();
    this.next = 1;
    this.serve = serve;
    this.site = site;
    this.worker = worker('worker.js', base);
    this.worker.onmessage = ({ data }: MessageEvent<NodeMessage>) => {
      const seen = (this.fromWorker[data.kind] ??= { count: 0, last: 0 });
      seen.count++;
      seen.last = Date.now();
      if (data.kind === 'out') onoutput(data.payload, 1);
      else if (data.kind === 'err') onoutput(data.payload, 2);
      else if (data.kind === 'status') onstatus(data.payload);
      else if (data.kind === 'exit') onexit(data.payload);
      else if (data.kind === 'tty') onterminal(data.raw, data.signals ?? true);
      else if (data.kind === 'stdin')
        this.running.get(data.id)?.oninput?.(data.end ? null : data.bytes!);
      else if (data.kind === 'nif') onnif(data);
      else if (data.kind === 'net') this.network(data);
      else if (data.kind === 'udp') this.datagramFrom(data);
      else if (data.kind === 'listening') {
        if (data.on) this.listening.add(data.port);
        else this.listening.delete(data.port);
        if (data.on && !data.ephemeral) this.serving.add(data.port);
        else this.serving.delete(data.port);
        onlistening(data.port, data.on);
      } else if (data.kind === 'spawn') spawn(this, data);
      else if (data.kind === 'kill') {
        this.running.get(data.id)?.onkill?.();
        this.running.delete(data.id);
        this.spawned.delete(data.id);
      }
    };
    // A worker that does not load (or throws outside its own handler).
    this.worker.onerror = (event) =>
      onstatus(`failed: ${event.message || 'the worker did not start'}`);
  }

  // shell: a shell (true), or one command: erl's { args, env }, or
  // { command, env }, a command by name as the shell runs it.
  // initial: command lines the shell runs first, as if typed.
  // cwd: where the shell starts.
  // boots: the boot images to unpack (worker.js).
  start({
    shell = false,
    args,
    command,
    env = {},
    initial = [],
    cwd,
    boots,
    tty,
  }: {
    shell?: boolean;
    args?: string[];
    command?: string[];
    env?: Record<string, string>;
    initial?: string[];
    cwd?: string;
    boots?: string[];
    // Whether its input and output are a terminal (default: both).
    tty?: boolean[];
  } = {}): void {
    this.channel = this.files?.connect() ?? null;
    // What the worker starts from, gunzipped and compiled once on the page
    // (files.js's boot images, the manifest, beam.wasm, brush.wasm and
    // coreutils.wasm):
    // posting copies the tars at memory speed, in place of each worker
    // fetching and gunzipping them. Without, the worker fetches them itself.
    const names = boots ?? ['boot'];
    const packages = new Site(this.site);
    const files = this.files;
    const brush =
      shell || command?.[0] === 'sh' || command?.[0] === 'bash'
        ? siteModule(packages.shell())
        : null;
    void Promise.all([
      files
        ? files.ready.then(
            () => files.boot,
            () => null,
          )
        : null,
      brush,
      siteModule(packages.tools()),
      siteModule(packages.beam()?.wasm ?? null),
    ]).then(([boot, module, coreutils, beam]) => {
      const images = boot && names.every((name) => boot.images[name]);
      this.worker.postMessage({
        shared: this.shared,
        site: this.site,
        files: this.channel,
        shell,
        args,
        command,
        env,
        initial,
        cwd,
        boots,
        images: images ? names.map((name) => boot.images[name]) : undefined,
        manifest: images ? boot.manifest : undefined,
        brush: module ?? undefined,
        coreutils: coreutils ?? undefined,
        beam: beam ?? undefined,
        ports: Object.keys(this.serve).map(Number),
        udpPorts: Object.keys(this.udpServe).map(Number),
        outbound: Boolean(this.outbound),
        https: Boolean(this.https),
        pagePrograms: Object.keys(this.programs),
        tty,
      });
    });
  }

  // The node's files: its Files.
  get fs(): Files | null {
    return this.files;
  }

  // Stop the node and its worker.
  stop(): void {
    this.worker.terminate();
    // What it started on the page goes with it.
    for (const process of this.running.values()) process.onowner?.();
    this.running.clear();
    // Its connections end with it, so their other ends hear so: a peer
    // node's, epmd's registration (epmd.ts), the database's session.
    for (const connection of [...this.connections.values()]) {
      this.forget(connection);
      connection.onclose('close');
    }
    if (this.channel) this.files!.disconnect(this.channel);
  }

  input(text: string): void {
    this.frame(FRAME.INPUT, 0, new TextEncoder().encode(text));
  }
  // Ctrl+C: the node's SIGINT (erts' break menu), a program's stop.
  interrupt(): void {
    this.frame(FRAME.INTERRUPT, 0);
  }
  // Stops what runs now at once, the shell staying.
  terminate(): void {
    this.frame(FRAME.TERMINATE, 0);
  }
  // The terminal's size, which the node reads from /.tty/size.
  resize(columns: number, rows: number): void {
    this.size = [columns, rows];
    for (const process of this.running.values()) process.onresize?.(columns, rows);
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, columns, true);
    view.setUint16(2, rows, true);
    this.frame(FRAME.RESIZE, 0, payload);
  }

  // A connection to the node's listener on `port`.
  // The ports the project's other nodes listen on, which the node may
  // connect to (peer).
  peers(ports: number[]): void {
    const payload = new Uint8Array(ports.length * 2);
    ports.forEach((port, i) => payload.set([port >> 8, port & 255], i * 2));
    this.frame(FRAME.PEERS, 0, payload);
  }

  connect(port: number): Connection {
    const id = (this.next += 2);
    const connection = new Connection(this, id);
    connection.port = port;
    trace('net', `page → node ${id}: open ${port}`);
    this.connections.set(id, connection);
    this.frame(FRAME.OPEN, id, new Uint8Array([port >> 8, port & 255]));
    return connection;
  }

  // A connection that ended, kept a while for debug().
  forget(connection: Connection): void {
    this.connections.delete(connection.id);
    this.recent.push(connection);
    if (this.recent.length > 30) this.recent.shift();
  }

  // What the page knows of its traffic with the node, for a bug hunt:
  // window.playground.debug().
  debug() {
    const unread = Atomics.load(this.control, 0) - Atomics.load(this.control, 1);
    const ago = (time: number) => `${((Date.now() - time) / 1000).toFixed(1)} s ago`;
    return {
      ringUnread: unread,
      pendingFrames: this.pending.length,
      pendingBytes: this.pending.reduce((sum, frame) => sum + frame.length, 0),
      retrying: this.retry !== null,
      listening: [...this.listening],
      serving: [...this.serving],
      open: [...this.connections.values()].map((c) => c.describe()),
      recent: this.recent.map((c) => c.describe()),
      programs: [...this.spawned.values()].map(
        ({ command, started }) => `${command} (${ago(started).replace(' ago', '')})`,
      ),
      fromWorker: Object.fromEntries(
        Object.entries(this.fromWorker).map(([kind, { count, last }]) => [
          kind,
          `${count}, last ${ago(last)}`,
        ]),
      ),
    };
  }

  network({ op, id, port, host, payload }: NetMessage): void {
    trace('net', `node → page ${id}: ${op}${payload ? ` ${payload.length} bytes` : ''}`);
    let connection = this.connections.get(id);
    if (op === 'dial') {
      connection = new Connection(this, id);
      connection.port = port ?? 0;
      this.connections.set(id, connection);
      if (this.outbound) this.outbound(connection, { address: host!, port: port! });
      else connection.refuse(-40);
      return;
    }
    if (op === 'open') {
      connection = new Connection(this, id);
      connection.port = port ?? 0;
      this.connections.set(id, connection);
      if (host !== undefined) {
        if (this.https) this.https(connection, { host, port: port! });
        else connection.close();
        return;
      }
      const handler = this.serve[port!];
      if (handler) handler(connection);
      else if (!this.peer(connection, port!)) connection.close();
    } else if (!connection) {
      return;
    } else if (op === 'data') {
      connection.received += payload!.length;
      connection.ondata(payload!);
    } else if (op === 'end') {
      connection.ended = 'ended by the node';
      connection.onend();
    } else if (op === 'close' || op === 'refused') {
      connection.ended = op === 'refused' ? 'refused by the node' : 'closed by the node';
      this.forget(connection);
      connection.onclose(op);
    }
  }

  // A datagram the node sent from one of its UDP ports: to the page's
  // (udpServe), another node's (udpPeer), or another host (udp); or the
  // node bound or closed that port.
  datagramFrom({ from, address, port, payload, bound, closed }: UdpMessage): void {
    if (bound) return void this.udpPorts.add(from);
    if (closed) {
      this.udpPorts.delete(from);
      return this.udp?.unbound?.(from);
    }
    trace('net', `node ${from} → ${address}:${port}: datagram, ${payload!.length} bytes`);
    const datagram = { from, address: address!, port: port!, bytes: payload! };
    const reply: Reply = (source, sourcePort, bytes) =>
      this.datagram(from, source, sourcePort, bytes);
    if (!local(address!)) return this.udp?.send(datagram, reply);
    const service = this.udpServe[port!];
    if (service) service(datagram, reply);
    else this.udpPeer(datagram, this);
  }

  // A datagram for the node's UDP port `to`, from `address`:`port`.
  datagram(to: number, address: string, port: number, bytes: Uint8Array): void {
    trace('net', `${address}:${port} → node ${to}: datagram, ${bytes.length} bytes`);
    const source = addressBytes(address);
    const payload = new Uint8Array(2 + source.length + bytes.length);
    payload.set([port >> 8, port & 255]);
    payload.set(source, 2);
    payload.set(bytes, 2 + source.length);
    this.frame(FRAME.DATAGRAM, to, payload);
  }

  frame(kind: number, id: number, payload: Uint8Array = new Uint8Array(0)): void {
    const frame = new Uint8Array(9 + payload.length);
    const view = new DataView(frame.buffer);
    view.setUint8(0, kind);
    view.setUint32(1, id, true);
    view.setUint32(5, payload.length, true);
    frame.set(payload, 9);
    this.pending.push(frame);
    this.flush();
  }

  // Frames go in whole, in order, as the ring has room.
  flush(): void {
    let written = Atomics.load(this.control, 0);
    while (this.pending.length) {
      const frame = this.pending[0];
      if (RING - (written - Atomics.load(this.control, 1)) < frame.length) {
        this.retry ??= setTimeout(() => {
          this.retry = null;
          this.flush();
        }, 2);
        break;
      }
      for (const byte of frame) this.ring[written++ % RING] = byte;
      this.pending.shift();
    }
    Atomics.store(this.control, 0, written);
    Atomics.notify(this.control, 0);
  }
}
