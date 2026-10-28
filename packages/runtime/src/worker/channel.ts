// The page's frames to a node's worker (host/node.ts writes them), and the
// programs the page runs for it.
import type { Network } from '../wasi/net';
import type { Process, Program } from '../wasi/process';

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
  PEERS: 10,
  TERMINATE: 11,
  CONNECTED: 12,
  DATAGRAM: 13,
  MODE: 14,
  TAKEN: 15,
  OUTPUT_ERR: 16,
};
export const RING = 1 << 20;
// Atomics.waitAsync, which not every browser has.
const waitAsync = (
  Atomics as unknown as {
    waitAsync?: (
      array: Int32Array,
      index: number,
      value: number,
    ) => { async: boolean; value: Promise<string> };
  }
).waitAsync;
// INPUT frames' ids: the terminal's typing (Ctrl+D on an empty line its
// end), or a process's input (programs/node.ts): its bytes as they are, and
// their end.
export const INPUT = { TERMINAL: 0, PIPE: 1, PIPE_END: 2 };
// The end of the node's input, among its bytes (Channel.input).
export const END = new Uint8Array([4]);

// An address's bytes (4 or 16) as socket.js writes it.
function decodeAddress(bytes: Uint8Array): string {
  if (bytes.length === 4) return bytes.join('.');
  const words: string[] = [];
  for (let i = 0; i < 16; i += 2) words.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return words.join(':');
}

// The page's frames: input, connections, interrupts, page programs.
export class Channel {
  declare control: Int32Array;
  declare ring: Uint8Array;
  declare input: Uint8Array[];
  declare network: Network | null;
  declare interrupted: boolean;
  // The page stops what runs at once (TERMINATE).
  declare terminated: boolean;
  declare size: number[];
  declare raw: boolean;
  // Whether Ctrl+C interrupts (a tty's ISIG): off while a page program
  // set raw input itself (Node's setRawMode), which reads it as a key.
  declare signals: boolean;
  // The page program the terminal's input goes to now (runOnPage), 0 for
  // a tool reading it, or null: Ctrl+D (end of input) is the shell's to
  // ignore.
  declare reading: number | null;
  // Whether the node's own input and output are a terminal (a shell's) or
  // not (sh -c from a program that pipes, child_process).
  declare tty: boolean[];
  declare processes: Map<number, Process>;
  // The ports the project's other nodes listen on (PEERS frames).
  declare peers: Set<number>;
  // The wait for the page's next frame that rest races (null: none yet).
  declare next: Promise<unknown> | null;

  constructor(shared: SharedArrayBuffer) {
    this.control = new Int32Array(shared, 0, 2);
    this.ring = new Uint8Array(shared, 8, RING);
    this.input = [];
    this.network = null;
    this.interrupted = false;
    this.terminated = false;
    // The terminal's size (RESIZE frames) and whether the node set it to
    // raw input.
    this.size = [80, 24];
    this.raw = false;
    this.signals = true;
    this.reading = null;
    this.tty = [true, true];
    // Programs the page runs (host/programs.ts), by id.
    this.processes = new Map();
    this.peers = new Set();
    this.next = null;
  }
  bytes(from: number, count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = this.ring[(from + i) % RING];
    return out;
  }
  pump(): void {
    const written = Atomics.load(this.control, 0);
    let read = Atomics.load(this.control, 1);
    while (read !== written) {
      const header = new DataView(this.bytes(read, 9).buffer);
      const kind = header.getUint8(0);
      const id = header.getUint32(1, true);
      const length = header.getUint32(5, true);
      const payload = this.bytes(read + 9, length);
      read += 9 + length;
      const net = this.network;
      if (kind === FRAME.INPUT) {
        // Ctrl+D on an empty line (the line discipline's end of input) is
        // a page program's (or a tool's) to read as the end, a key when
        // raw; nothing else reads it.
        if (id === INPUT.PIPE) this.input.push(payload);
        else if (id === INPUT.PIPE_END) this.input.push(END);
        else if (payload.length !== 1 || payload[0] !== 4 || this.raw) this.input.push(payload);
        else if (this.reading !== null) this.input.push(END);
      } else if (kind === FRAME.MODE) this.mode(payload[0] === 1, payload[1] === 1);
      else if (kind === FRAME.INTERRUPT) this.interrupted = true;
      else if (kind === FRAME.TERMINATE) this.terminated = true;
      else if (kind === FRAME.RESIZE) {
        const view = new DataView(payload.buffer);
        this.size = [view.getUint16(0, true), view.getUint16(2, true)];
      } else if (kind === FRAME.OPEN) {
        if (!net || !net.accepted(id, (payload[0] << 8) | payload[1])) {
          postMessage({ kind: 'net', op: 'refused', id });
        }
      } else if (kind === FRAME.PEERS) {
        this.peers = new Set();
        for (let at = 0; at + 1 < payload.length; at += 2)
          this.peers.add((payload[at] << 8) | payload[at + 1]);
        if (net) net.peers = this.peers;
      } else if (kind === FRAME.OUTPUT) this.processes.get(id)?.write(payload);
      else if (kind === FRAME.OUTPUT_ERR) this.processes.get(id)?.writeError(payload);
      else if (kind === FRAME.TAKEN) {
        const process = this.processes.get(id);
        if (process) {
          process.taken += new DataView(payload.buffer).getUint32(0, true);
          process.notify?.();
        }
      } else if (kind === FRAME.EXIT) {
        this.processes.get(id)?.exit(payload[0]);
        this.processes.delete(id);
      } else if (kind === FRAME.CONNECTED) {
        // How dialing went, then (connected) the local end's family,
        // address and port.
        const view = new DataView(payload.buffer);
        const size = payload[1] === 6 ? 16 : 4;
        const local =
          payload.length > 2
            ? {
                address: decodeAddress(payload.subarray(2, 2 + size)),
                port: view.getUint16(2 + size),
              }
            : undefined;
        net?.connected(id, view.getInt8(0), local);
      } else if (kind === FRAME.DATAGRAM) {
        // id: the node's port; the source's port, family and address, then
        // the bytes.
        const view = new DataView(payload.buffer);
        const port = view.getUint16(0);
        const address = decodeAddress(payload.subarray(3, 3 + (payload[2] === 6 ? 16 : 4)));
        net?.datagram(id, address, port, payload.subarray(payload[2] === 6 ? 19 : 7));
      } else if (kind === FRAME.DATA) net?.data(id, payload);
      else if (kind === FRAME.END || kind === FRAME.CLOSE) net?.ended(id);
    }
    Atomics.store(this.control, 1, read);
  }
  // Until a frame comes or `ms` pass.
  sleep(ms: number): void {
    Atomics.wait(this.control, 0, Atomics.load(this.control, 1), ms);
  }
  // sleep, without holding the thread: the worker's processes
  // (processes.ts) run meanwhile. One wait with no timeout, which every
  // rest shares, ends with the page's notify; a timer ends a rest before
  // it. (In WebKit a waitAsync that times out never settles, and no notify
  // finds it again.) Without waitAsync, 10 ms at most.
  rest(ms: number): Promise<void> {
    if (!waitAsync) return new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10)));
    if (!this.next) {
      const waiting = waitAsync(this.control, 0, Atomics.load(this.control, 1));
      if (!waiting.async) return Promise.resolve();
      this.next = waiting.value.then(() => (this.next = null));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this.next,
      new Promise((resolve) => (timer = setTimeout(resolve, ms))),
    ]).then(() => clearTimeout(timer));
  }
  // Up to `max` bytes of the input (past its ends: what reads this has none).
  take(max: number): Uint8Array {
    const out: Uint8Array[] = [];
    let count = 0;
    while (this.input.length && count < max) {
      const chunk = this.input[0];
      if (chunk === END) {
        this.input.shift();
        continue;
      }
      const part = chunk.subarray(0, max - count);
      out.push(part);
      count += part.length;
      if (part.length === chunk.length) this.input.shift();
      else this.input[0] = chunk.subarray(part.length);
    }
    const bytes = new Uint8Array(count);
    let at = 0;
    for (const part of out) {
      bytes.set(part, at);
      at += part.length;
    }
    return bytes;
  }
  // Up to `max` bytes of the input as far as its end, which it takes (then
  // none), or null while nothing has come.
  takeInput(max: number): Uint8Array | null {
    const end = this.input.indexOf(END);
    if (end === 0) {
      this.input.shift();
      return new Uint8Array(0);
    }
    if (!this.input.length) return null;
    const after = end > 0 ? this.input.splice(end) : [];
    const bytes = this.take(max);
    this.input.push(...after);
    return bytes;
  }
  // The node set the terminal to raw input (IEx's line editing) or back:
  // the page passes keys through instead of editing lines; `signals`: Ctrl+C
  // still interrupts (off: it is a key, as Node's setRawMode has it).
  mode(raw: boolean, signals = true): void {
    if (raw === this.raw && signals === this.signals) return;
    this.raw = raw;
    this.signals = signals;
    postMessage({ kind: 'tty', raw, signals });
  }
}

// A program the page runs (host/programs.ts): its output and exit come back
// as frames; it is told when the node closes its port. Its input: bytes,
// then their end; or (null) none that ends, as an open pipe's (the BEAM's
// ports), unless the caller forwards some (pageProgram, the terminal's);
// `tty`: whether its stdin and stdout are the terminal. started(id) hears
// its id.
let processes = 0;
export function onPage(
  channel: Channel,
  name: string,
  io: { input: Uint8Array | null; tty: boolean[]; started?: (id: number) => void } = {
    input: null,
    tty: [false, false],
  },
): Program {
  return (process, { args, cwd, env }) => {
    const id = (processes += 1);
    channel.processes.set(id, process);
    process.onclose = () => {
      channel.processes.delete(id);
      postMessage({ kind: 'kill', id });
    };
    postMessage({ kind: 'spawn', id, name, args, cwd, env, tty: io.tty });
    if (io.input) {
      if (io.input.length) postMessage({ kind: 'stdin', id, bytes: io.input });
      postMessage({ kind: 'stdin', id, end: true });
    }
    io.started?.(id);
  };
}
