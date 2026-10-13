// The page's side of a playground node (worker.js): start it, type into it,
// interrupt it, and connect to it or let it connect out.
//
// The page writes to the worker through frames in a SharedArrayBuffer ring
// (the worker sleeps on its write count, so a frame wakes it):
// [kind u8][id u32][length u32][payload]. The worker answers with
// messages.
export const FRAME = { INPUT: 0, OPEN: 1, DATA: 2, END: 3, CLOSE: 4, INTERRUPT: 5 };
export const RING = 1 << 20;
const CHUNK = 1 << 16;

// A connection between the page and the node.
class Connection {
  constructor(node, id) {
    this.node = node;
    this.id = id;
    this.ondata = () => {};
    this.onend = () => {};
    this.onclose = () => {};
  }
  write(bytes) {
    for (let at = 0; at < bytes.length; at += CHUNK) {
      this.node.frame(FRAME.DATA, this.id, bytes.subarray(at, at + CHUNK));
    }
  }
  end() {
    this.node.frame(FRAME.END, this.id);
  }
  close() {
    this.node.frame(FRAME.CLOSE, this.id);
    this.node.connections.delete(this.id);
  }
}

export class Node {
  // base: where the site's runtime files are; onoutput(bytes),
  // onstatus(text), onexit(code); serve: { port: (connection) => ... }
  // for ports the node may connect to on the page.
  constructor({ base = './', onoutput = () => {}, onstatus = () => {}, onexit = () => {}, serve = {} }) {
    this.shared = new SharedArrayBuffer(8 + RING);
    this.control = new Int32Array(this.shared, 0, 2);
    this.ring = new Uint8Array(this.shared, 8, RING);
    this.pending = [];
    this.connections = new Map();
    this.next = 1;
    this.serve = serve;
    this.worker = new Worker(new URL('worker.js', new URL(base, location.href)), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.kind === 'out') onoutput(data.payload);
      else if (data.kind === 'status') onstatus(data.payload);
      else if (data.kind === 'exit') onexit(data.payload);
      else if (data.kind === 'net') this.network(data);
    };
  }

  // shell: a shell (true), or one command: { args, env }.
  start({ shell = false, args, env = {} }) {
    this.worker.postMessage({ shared: this.shared, shell, args, env, ports: Object.keys(this.serve).map(Number) });
  }

  input(text) {
    this.frame(FRAME.INPUT, 0, new TextEncoder().encode(text));
  }
  interrupt() {
    this.frame(FRAME.INTERRUPT, 0);
  }

  // A connection to the node's listener on `port`.
  connect(port) {
    const id = (this.next += 2);
    const connection = new Connection(this, id);
    this.connections.set(id, connection);
    this.frame(FRAME.OPEN, id, new Uint8Array([port >> 8, port & 255]));
    return connection;
  }

  network({ op, id, port, payload }) {
    let connection = this.connections.get(id);
    if (op === 'open') {
      connection = new Connection(this, id);
      this.connections.set(id, connection);
      const handler = this.serve[port];
      if (handler) handler(connection);
      else connection.close();
    } else if (!connection) {
      return;
    } else if (op === 'data') connection.ondata(payload);
    else if (op === 'end') connection.onend();
    else if (op === 'close' || op === 'refused') {
      this.connections.delete(id);
      connection.onclose(op);
    }
  }

  frame(kind, id, payload = new Uint8Array(0)) {
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
  flush() {
    let written = Atomics.load(this.control, 0);
    while (this.pending.length) {
      const frame = this.pending[0];
      if (RING - (written - Atomics.load(this.control, 1)) < frame.length) {
        this.retry ??= setTimeout(() => { this.retry = null; this.flush(); }, 2);
        break;
      }
      for (const byte of frame) this.ring[written++ % RING] = byte;
      this.pending.shift();
    }
    Atomics.store(this.control, 0, written);
    Atomics.notify(this.control, 0);
  }
}
