// The page's side of a playground node (worker.js): start it, type into it,
// interrupt it, and connect to it or let it connect out.
//
// The page writes to the worker through frames in a SharedArrayBuffer ring
// (the worker sleeps on its write count, so a frame wakes it):
// [kind u8][id u32][length u32][payload]. The worker answers with
// messages.
export const FRAME = { INPUT: 0, OPEN: 1, DATA: 2, END: 3, CLOSE: 4, INTERRUPT: 5, FILES: 6, OUTPUT: 7, EXIT: 8 };
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
  // onstatus(text), onexit(code), onchange(paths): what the node created,
  // wrote, renamed or removed; serve: { port: (connection) => ... } for
  // ports the node may connect to on the page.
  // programs: { name: (process, { args, cwd, env, fs }) => ... }, programs
  // the node may spawn that run on the page (they may be async):
  // process.write(text | bytes), process.exit(code), process.onkill.
  constructor({ base = './', onoutput = () => {}, onstatus = () => {}, onexit = () => {}, onchange = () => {}, serve = {}, programs = {} }) {
    this.requests = new Map();
    this.programs = programs;
    this.running = new Map();
    this.shared = new SharedArrayBuffer(8 + RING);
    this.control = new Int32Array(this.shared, 0, 2);
    this.ring = new Uint8Array(this.shared, 8, RING);
    this.pending = [];
    this.connections = new Map();
    this.next = 1;
    this.serve = serve;
    // A blob that imports worker.js: Firefox does not start a worker from
    // a page its service worker controls (the Phoenix playground's); a
    // blob worker takes the page's cross-origin isolation in both.
    const script = new URL('worker.js', new URL(base, location.href)).href;
    const blob = new Blob([`import ${JSON.stringify(script)};`], { type: 'text/javascript' });
    this.worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.kind === 'out') onoutput(data.payload);
      else if (data.kind === 'status') onstatus(data.payload);
      else if (data.kind === 'exit') onexit(data.payload);
      else if (data.kind === 'net') this.network(data);
      else if (data.kind === 'changed') onchange(data.payload);
      else if (data.kind === 'spawn') this.spawn(data);
      else if (data.kind === 'kill') {
        this.running.get(data.id)?.onkill?.();
        this.running.delete(data.id);
      }
      else if (data.kind === 'files') {
        const request = this.requests.get(data.id);
        this.requests.delete(data.id);
        if (data.error) request?.reject(new Error(data.error));
        else request?.resolve(data);
      }
    };
    // A worker that does not load (or throws outside its own handler).
    this.worker.onerror = (event) => onstatus(`failed: ${event.message || 'the worker did not start'}`);
  }

  // shell: a shell (true), or one command: { args, env }.
  // initial: command lines the shell runs first, as if typed.
  start({ shell = false, args, env = {}, initial = [] }) {
    this.worker.postMessage({ shared: this.shared, shell, args, env, initial, ports: Object.keys(this.serve).map(Number),
      pagePrograms: Object.keys(this.programs) });
  }

  // The node's filesystem, answered by the worker whatever the node is
  // doing: paths are absolute.
  get fs() {
    const ask = (request, data = new Uint8Array(0)) => new Promise((resolve, reject) => {
      const id = (this.next += 2);
      this.requests.set(id, { resolve, reject });
      const json = new TextEncoder().encode(JSON.stringify(request));
      const payload = new Uint8Array(4 + json.length + data.length);
      new DataView(payload.buffer).setUint32(0, json.length, true);
      payload.set(json, 4);
      payload.set(data, 4 + json.length);
      this.frame(FRAME.FILES, id, payload);
    });
    return {
      list: (path, skip = []) => ask({ op: 'list', path, skip }).then((r) => r.entries),
      read: (path) => ask({ op: 'read', path }).then((r) => r.data),
      write: (path, data) => ask({ op: 'write', path }, typeof data === 'string' ? new TextEncoder().encode(data) : data).then(() => {}),
      mkdir: (path) => ask({ op: 'mkdir', path }).then(() => {}),
      remove: (path) => ask({ op: 'remove', path }).then(() => {}),
      rename: (path, to) => ask({ op: 'rename', path, to }).then(() => {}),
    };
  }

  // A program the node started (worker.js onPage).
  spawn({ id, name, args, cwd, env }) {
    let exited = false;
    const process = {
      onkill: null,
      write: (data) => {
        if (exited) return;
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        for (let at = 0; at < bytes.length; at += CHUNK) this.frame(FRAME.OUTPUT, id, bytes.subarray(at, at + CHUNK));
      },
      exit: (code = 0) => {
        if (exited) return;
        exited = true;
        this.running.delete(id);
        this.frame(FRAME.EXIT, id, new Uint8Array([code & 255]));
      },
    };
    this.running.set(id, process);
    Promise.resolve()
      .then(() => this.programs[name](process, { args, cwd, env, fs: this.fs }))
      .catch((error) => {
        process.write(`${name}: ${error.message}\n`);
        process.exit(1);
      });
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
