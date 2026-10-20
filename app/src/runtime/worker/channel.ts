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
};
export const RING = 1 << 20;

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
  // The page program the terminal's input goes to now (runOnPage), or
  // null: Ctrl+D (end of input) is the shell's to ignore.
  declare reading: number | null;
  // Whether the node's own input and output are a terminal (a shell's) or
  // not (sh -c from a program that pipes, child_process).
  declare tty: boolean[];
  declare processes: Map<number, Process>;
  // The ports the project's other nodes listen on (PEERS frames).
  declare peers: Set<number>;

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
        // a page program's to read; nothing else reads it.
        if (payload.length !== 1 || payload[0] !== 4 || this.reading !== null || this.raw)
          this.input.push(payload);
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
      else if (kind === FRAME.EXIT) {
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
  take(max: number): Uint8Array {
    const out: Uint8Array[] = [];
    let count = 0;
    while (this.input.length && count < max) {
      const chunk = this.input[0];
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
  // The node set the terminal to raw input (IEx's line editing) or back:
  // the page passes keys through instead of editing lines; `signals`: Ctrl+C
  // still interrupts (off: it is a key, as Node's setRawMode has it).
  mode(raw: boolean, signals = true): void {
    if (raw === this.raw && signals === this.signals) return;
    this.raw = raw;
    this.signals = signals;
    postMessage({ kind: 'tty', raw, signals });
  }
  // A line typed at the shell (blocking).
  line(): string | null {
    for (;;) {
      this.pump();
      if (this.interrupted) {
        this.interrupted = false;
        this.input = [];
        return null;
      }
      const all = this.take(Infinity);
      const newline = all.indexOf(10);
      if (newline >= 0) {
        if (newline + 1 < all.length) this.input.unshift(all.subarray(newline + 1));
        return new TextDecoder().decode(all.subarray(0, newline));
      }
      if (all.length) this.input.unshift(all);
      this.sleep(1000);
    }
  }
}

// A program the page runs (host/programs.ts): its output and exit come back
// as frames; it is told when the node closes its port. Its input: bytes,
// then their end; or (null) none that ends, as an open pipe's (the BEAM's
// ports), unless the caller forwards some (runOnPage, the terminal's);
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
