// TCP and UDP for the node (/.net): its listeners, connections and
// datagram ports.

// One end of a connection, as the node sees it: what the peer sent
// (inbox), whether the peer has ended, and how to reach the peer.
interface Peer {
  send(bytes: Uint8Array): void;
  end(): void;
  close(): void;
}

export class Endpoint {
  declare inbox: Uint8Array[];
  declare eof: boolean;
  declare peer: Peer;
  // Told when data or the end comes (the Emscripten BEAM's sockets:
  // beam/socket/socket.js).
  declare notify?: (() => void) | null;
  // A connection to another host (Network.dial): 0 while the page dials
  // it, 1 once it is open, else a negative errno (why it did not); and its
  // local end there, when the page says.
  declare status: number;
  declare local?: { address: string; port: number };

  constructor(peer: Peer) {
    this.inbox = [];
    this.eof = false;
    this.peer = peer; // { send(bytes), end(), close() }
    this.status = 1;
  }
  connected(status: number): void {
    if (this.status !== 0) return;
    this.status = status;
    this.notify?.();
  }
  receive(bytes: Uint8Array): void {
    this.inbox.push(bytes);
    this.notify?.();
  }
  finish(): void {
    this.eof = true;
    this.notify?.();
  }
  take(max: number): Uint8Array {
    const out = new Uint8Array(
      Math.min(
        max,
        this.inbox.reduce((n, c) => n + c.length, 0),
      ),
    );
    let at = 0;
    while (at < out.length) {
      const chunk = this.inbox[0];
      const part = chunk.subarray(0, out.length - at);
      out.set(part, at);
      at += part.length;
      if (part.length === chunk.length) this.inbox.shift();
      else this.inbox[0] = chunk.subarray(part.length);
    }
    return out;
  }
}

// Ephemeral ports (49152-65535), as an OS hands them out: one sequence for
// every node this worker runs, from a random start, so that a node does
// not get the port an earlier one had (Mix's lock files name the port of
// their holder, and a node that finds its own port there waits on itself).
let ephemeralPort = 49152 + Math.floor(Math.random() * 16384);
function nextEphemeral(): number {
  const port = ephemeralPort;
  ephemeralPort = ephemeralPort >= 65535 ? 49152 : ephemeralPort + 1;
  return port;
}

// TCP for the node (crates/rotp/src/host/wasm_net.rs): listeners and
// connections inside it, and connections to and from the page (`remote`:
// remote.open(id, port) for a connection the node makes to a port in
// remote.ports; send/end/close by id; listening(port, bool) as the node
// starts and stops listening). Ids the node makes are even; the
// page's are odd. remote.dial(id, address, port): a connection to another
// host, which the page dials and answers with connected(id, status);
// without it, no host but the node's own is reached.
//
// UDP: the node's ports (udpBind, told by remote.bound), datagrams
// between them, and to the page (remote.datagram): its UDP ports
// (remote.udpPorts, as 53 for DNS), the project's other nodes' ports, and
// other hosts; the page's come in by datagram().
export interface Remote {
  ports: number[];
  udpPorts?: number[];
  https?: boolean;
  open(id: number, port: number, host?: string): void;
  dial?(id: number, address: string, port: number): void;
  send(id: number, bytes: Uint8Array): void;
  end(id: number): void;
  close(id: number): void;
  listening?(port: number, on: boolean, ephemeral?: boolean): void;
  datagram?(from: number, address: string, port: number, bytes: Uint8Array): void;
  bound?(port: number): void;
  unbound?(port: number): void;
}

// A datagram for one of the node's UDP ports, and where it came from.
export interface Datagram {
  address: string;
  port: number;
  bytes: Uint8Array;
}

// A UDP port of the node's: what came, and whom to tell (socket.js).
export interface UdpPort {
  port: number;
  queue: Datagram[];
  notify?: (() => void) | null;
}

// The node's own addresses (127.0.0.0/8, ::1, the unspecified one), as
// socket.js writes them.
export function local(address: string): boolean {
  if (!address.includes(':')) return address.startsWith('127.') || address === '0.0.0.0';
  const words = address.split(':').map((word) => parseInt(word, 16) || 0);
  if (words.length === 8 && words.slice(0, 7).every((word) => word === 0)) return words[7] <= 1;
  return (
    words.length === 8 &&
    words.slice(0, 5).every((w) => w === 0) &&
    words[5] === 0xffff &&
    words[6] >> 8 === 127
  );
}

// ENETUNREACH: no way to another host.
const UNREACHABLE = -40;

// A connection waiting on a listener: its id and the peer's address.
export interface Waiting {
  id: number;
  ip: string;
  port: number;
}

export class Network {
  declare remote: Remote;
  declare listeners: Map<number, Waiting[]>;
  declare waiting: Map<number, Endpoint>;
  declare endpoints: Map<number, Endpoint>;
  declare next: number;
  // Told when a connection waits on the listener on a port (as notify).
  declare onqueue?: Map<number, () => void>;
  // Ports the project's other nodes listen on: a connection there goes
  // to the page, which takes it to that node.
  declare peers: Set<number>;
  declare udp: Map<number, UdpPort>;

  constructor(remote: Remote = { ports: [], open() {}, send() {}, end() {}, close() {} }) {
    this.remote = remote;
    this.listeners = new Map(); // port -> [{ id, ip, port }]
    this.waiting = new Map(); // id -> Endpoint, until accepted
    this.endpoints = new Map(); // id -> Endpoint, for the page's
    this.next = 2;
    this.peers = new Set();
    this.udp = new Map();
  }
  // A listener's queue, on `port` or (0) a free one: { queue, port }.
  // listening(port, true, ephemeral): ephemeral when the port was given,
  // not asked for (Mix's lock listens so; a web server names its port).
  listen(port: number): { queue: Waiting[]; port: number } | null {
    const ephemeral = port === 0;
    // A port another node of the project holds is taken, as a machine's
    // ports are (Mix's pub/sub takes a listen there for its subscriber
    // being gone).
    const taken = (p: number) => this.listeners.has(p) || this.peers.has(p);
    if (ephemeral)
      do port = nextEphemeral();
      while (taken(port));
    if (taken(port)) return null;
    const queue: Waiting[] = [];
    this.listeners.set(port, queue);
    this.remote.listening?.(port, true, ephemeral);
    return { queue, port };
  }
  // A connection to the node's listener on `port` from the page.
  accepted(id: number, port: number): boolean {
    const queue = this.listeners.get(port);
    if (!queue) return false;
    const r = this.remote;
    const endpoint = new Endpoint({
      send: (bytes) => r.send(id, bytes),
      end: () => r.end(id),
      close: () => {
        this.endpoints.delete(id);
        r.close(id);
      },
    });
    this.endpoints.set(id, endpoint);
    this.waiting.set(id, endpoint);
    queue.push({ id, ip: '127.0.0.1', port: nextEphemeral() });
    this.onqueue?.get(port)?.();
    return true;
  }
  // The node connects: to itself, or to the page.
  connect(port: number): Endpoint | null {
    const queue = this.listeners.get(port);
    if (queue) {
      const id = (this.next += 2);
      let mine: Endpoint;
      const theirs = new Endpoint({
        send: (bytes) => mine.receive(bytes),
        end: () => mine.finish(),
        close: () => mine.finish(),
      });
      mine = new Endpoint({
        send: (bytes) => theirs.receive(bytes),
        end: () => theirs.finish(),
        close: () => theirs.finish(),
      });
      this.waiting.set(id, theirs);
      queue.push({ id, ip: '127.0.0.1', port: nextEphemeral() });
      this.onqueue?.get(port)?.();
      return mine;
    }
    if (!this.remote.ports.includes(port) && !this.peers.has(port)) return null;
    const id = (this.next += 2);
    const r = this.remote;
    const endpoint = new Endpoint({
      send: (bytes) => r.send(id, bytes),
      end: () => r.end(id),
      close: () => {
        this.endpoints.delete(id);
        r.close(id);
      },
    });
    this.endpoints.set(id, endpoint);
    r.open(id, port);
    return endpoint;
  }
  // HTTPS to `host` the page carries (/.net/https/NAME/PORT): a connection
  // to the page, if it offers it (remote.https).
  https(host: string, port: number): Endpoint | null {
    if (!this.remote.https) return null;
    const id = (this.next += 2);
    const r = this.remote;
    const endpoint = new Endpoint({
      send: (bytes) => r.send(id, bytes),
      end: () => r.end(id),
      close: () => {
        this.endpoints.delete(id);
        r.close(id);
      },
    });
    this.endpoints.set(id, endpoint);
    r.open(id, port, host);
    return endpoint;
  }
  // The node connects to another host (`address`, socket.js's text):
  // through the page, which dials it (remote.dial) and says how it went
  // (connected); unreachable without it.
  dial(address: string, port: number): Endpoint {
    const id = (this.next += 2);
    const r = this.remote;
    const endpoint = new Endpoint({
      send: (bytes) => r.send(id, bytes),
      end: () => r.end(id),
      close: () => {
        this.endpoints.delete(id);
        r.close(id);
      },
    });
    endpoint.status = 0;
    this.endpoints.set(id, endpoint);
    if (r.dial) r.dial(id, address, port);
    else endpoint.connected(UNREACHABLE);
    return endpoint;
  }
  // From the page: how dialing `id` went (1, or a negative errno), and
  // where from.
  connected(id: number, status: number, end?: { address: string; port: number }): void {
    const endpoint = this.endpoints.get(id);
    if (!endpoint) return;
    if (status !== 1) this.endpoints.delete(id);
    endpoint.local = end;
    endpoint.connected(status);
  }
  // A UDP port, `port` or (0) an ephemeral one; null if it is taken.
  udpBind(port: number): UdpPort | null {
    if (port === 0)
      do port = nextEphemeral();
      while (this.udp.has(port));
    if (this.udp.has(port)) return null;
    const bound: UdpPort = { port, queue: [] };
    this.udp.set(port, bound);
    this.remote.bound?.(port);
    return bound;
  }
  udpUnbind(port: number): void {
    if (this.udp.delete(port)) this.remote.unbound?.(port);
  }
  // A datagram from the node's port `from`: to another of its ports, or to
  // the page (its ports, the project's other nodes', other hosts), which
  // drops what nobody takes, as UDP does.
  udpSend(from: number, address: string, port: number, bytes: Uint8Array): void {
    const target = local(address) ? this.udp.get(port) : null;
    if (target) {
      target.queue.push({ address: '127.0.0.1', port: from, bytes });
      target.notify?.();
    } else this.remote.datagram?.(from, address, port, bytes);
  }
  // From the page: a datagram for the node's port `to`.
  datagram(to: number, address: string, port: number, bytes: Uint8Array): void {
    const target = this.udp.get(to);
    if (!target) return;
    target.queue.push({ address, port, bytes });
    target.notify?.();
  }
  // From the page: data for, or the end of, connection `id`.
  data(id: number, bytes: Uint8Array): void {
    this.endpoints.get(id)?.receive(bytes);
  }
  ended(id: number): void {
    this.endpoints.get(id)?.finish();
  }
  // The node stops listening on `port`.
  unlisten(port: number): void {
    if (this.listeners.delete(port)) this.remote.listening?.(port, false);
  }
}
