// A threaded node (rotp.wasm built for wasm32-wasip1-threads): its
// threads run in workers on one shared memory, and the WASI state
// (files, descriptors, the network) stays with one host that runs no
// WebAssembly. A thread blocked in a futex cannot serve calls, so the
// host is never a thread. Each thread forwards a WASI call through its
// slot in a SharedArrayBuffer: the host runs wasi.js's own function with
// the same arguments on the shared memory (pointers are the same there),
// and answers. Clocks, randomness and sleeping stay with the thread.

const SLOT = 128; // bytes: state, call, argument count, i64 mask, result, then arguments
const ARGS = 4; // where the arguments start, in 8-byte words
const MAX_ARGS = 12;
const IDLE = 0;
const ASKED = 1;
const ANSWERED = 2;
const THROWN = 3;
// Calls that are not WASI functions.
const SPAWN = -1;

// The shared state of a threaded node: a doorbell the host sleeps on and
// one slot per thread.
// `end` says how the node ended: [0] 1 when its main thread returned
// (status in [1]), 2 when a thread failed (its message's length in [1],
// the message from byte 16); [2] is taken by the first to end, which
// writes the rest before [0].
export function channel(threads = 64) {
  return {
    doorbell: new SharedArrayBuffer(4),
    slots: new SharedArrayBuffer(SLOT * threads),
    end: new SharedArrayBuffer(16 + 4096),
    threads,
  };
}

const RETURNED = 1;
const FAILED = 2;

function finish(chan, how, value, message = '') {
  const end = new Int32Array(chan.end, 0, 3);
  if (Atomics.compareExchange(end, 2, 0, 1) !== 0) return;
  const bytes = new TextEncoder().encode(message).subarray(0, chan.end.byteLength - 16);
  new Uint8Array(chan.end, 16).set(bytes);
  end[1] = how === FAILED ? bytes.length : value;
  Atomics.store(end, 0, how);
  const doorbell = new Int32Array(chan.doorbell);
  Atomics.add(doorbell, 0, 1);
  Atomics.notify(doorbell, 0);
}

// The host: `wasi` (its memory the shared one) serves the threads' calls.
// spawn(tid, startArg) starts a thread; next tid from 1.
export class Host {
  constructor(wasi, chan, { spawn }) {
    this.wasi = wasi;
    this.chan = chan;
    this.names = Object.keys(wasi.imports.wasi_snapshot_preview1);
    this.functions = wasi.imports.wasi_snapshot_preview1;
    this.doorbell = new Int32Array(chan.doorbell);
    this.spawn = spawn;
    this.nextTid = 1;
  }

  // Serve every waiting call; true when one was.
  serve() {
    let served = false;
    for (let slot = 0; slot < this.chan.threads; slot++) {
      const words = new Int32Array(this.chan.slots, SLOT * slot, SLOT / 4);
      if (Atomics.load(words, 0) !== ASKED) continue;
      served = true;
      const call = words[1];
      const count = words[2];
      const mask = words[3];
      const wide = new BigInt64Array(this.chan.slots, SLOT * slot, SLOT / 8);
      const args = [];
      for (let i = 0; i < count; i++) {
        const value = wide[ARGS + i];
        args.push(mask & (1 << i) ? value : Number(BigInt.asUintN(32, value)));
      }
      let state = ANSWERED;
      try {
        if (call === SPAWN) {
          const tid = this.nextTid++;
          if (tid >= this.chan.threads) throw new Error(`a node has at most ${this.chan.threads} threads`);
          this.spawn(tid, args[0]);
          words[4] = tid;
        } else {
          words[4] = this.functions[this.names[call]](...args) ?? 0;
        }
      } catch (error) {
        // proc_exit's Exit, or a failure: the host deals with it, and the
        // thread waits for good.
        this.thrown = error;
        state = THROWN;
      }
      Atomics.store(words, 0, state);
      Atomics.notify(words, 0);
      if (state === THROWN) throw this.thrown;
    }
    return served;
  }

  // Sleep until a thread rings or `ms` pass. Then: the main thread's
  // status once it returned; a thread's failure is thrown.
  wait(ms) {
    const rung = Atomics.load(this.doorbell, 0);
    if (!this.serve()) Atomics.wait(this.doorbell, 0, rung, ms);
    const end = new Int32Array(this.chan.end, 0, 2);
    switch (Atomics.load(end, 0)) {
      case RETURNED:
        return end[1];
      case FAILED:
        throw new Error(new TextDecoder().decode(new Uint8Array(this.chan.end, 16, end[1]).slice()));
      default:
        return null;
    }
  }
}

// A thread's imports: `names` the host's WASI functions, by index.
export function threadImports({ memory, chan, slot, names }) {
  const words = new Int32Array(chan.slots, SLOT * slot, SLOT / 4);
  const wide = new BigInt64Array(chan.slots, SLOT * slot, SLOT / 8);
  const doorbell = new Int32Array(chan.doorbell);
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const ask = (call, args) => {
    let mask = 0;
    args.forEach((value, i) => {
      if (typeof value === 'bigint') mask |= 1 << i;
      wide[ARGS + i] = BigInt(value);
    });
    words[1] = call;
    words[2] = args.length;
    words[3] = mask;
    Atomics.store(words, 0, ASKED);
    Atomics.add(doorbell, 0, 1);
    Atomics.notify(doorbell, 0);
    while (Atomics.load(words, 0) === ASKED) Atomics.wait(words, 0, ASKED);
    if (Atomics.load(words, 0) === THROWN) {
      // The node is ending (proc_exit, or the host failed): wait for it.
      for (;;) Atomics.wait(nap, 0, 0);
    }
    Atomics.store(words, 0, IDLE);
    return words[4];
  };
  const view = () => new DataView(memory.buffer);
  const nanos = () => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
  const local = {
    clock_time_get(_id, _precision, ptr) {
      view().setBigUint64(ptr >>> 0, nanos(), true);
      return 0;
    },
    random_get(ptr, len) {
      // getRandomValues takes no view of shared memory: fill a copy.
      const bytes = new Uint8Array(len >>> 0);
      for (let at = 0; at < bytes.length; at += 65536) crypto.getRandomValues(bytes.subarray(at, at + 65536));
      new Uint8Array(memory.buffer, ptr >>> 0, bytes.length).set(bytes);
      return 0;
    },
    sched_yield: () => 0,
    // Only clock subscriptions are slept on (as wasi.js does); the host
    // takes in the page's input meanwhile.
    poll_oneoff(inPtr, outPtr, count, eventsPtr) {
      const v = view();
      let wait = Infinity;
      let events = 0;
      for (let i = 0; i < count >>> 0; i++) {
        const sub = (inPtr >>> 0) + 48 * i;
        const tag = v.getUint8(sub + 8);
        const out = (outPtr >>> 0) + 32 * events;
        if (tag === 0) {
          const timeout = v.getBigUint64(sub + 24, true);
          const absolute = v.getUint16(sub + 40, true) & 1;
          const ms = Number(absolute ? timeout - nanos() : timeout) / 1e6;
          wait = Math.min(wait, Math.max(0, ms));
        }
        v.setBigUint64(out, v.getBigUint64(sub, true), true);
        v.setUint16(out + 8, 0, true);
        v.setUint8(out + 10, tag);
        events++;
      }
      if (wait !== Infinity && wait > 0) Atomics.wait(nap, 0, 0, wait);
      v.setUint32(eventsPtr >>> 0, events, true);
      return 0;
    },
  };
  const preview1 = {};
  names.forEach((name, index) => {
    preview1[name] = local[name] ?? ((...args) => ask(index, args));
  });
  return {
    env: { memory },
    wasi: { 'thread-spawn': (startArg) => ask(SPAWN, [startArg]) },
    wasi_snapshot_preview1: preview1,
  };
}

// Run a thread: tid 0 is the node's main thread (_start), others start at
// wasi_thread_start(tid, startArg).
export function runThread({ module, memory, chan, slot, names, tid, startArg }) {
  try {
    const instance = new WebAssembly.Instance(module, threadImports({ memory, chan, slot, names }));
    if (tid === 0) {
      instance.exports._start();
      finish(chan, RETURNED, 0);
    } else {
      instance.exports.wasi_thread_start(tid, startArg);
    }
  } catch (error) {
    finish(chan, FAILED, 0, `thread ${tid}: ${error?.stack ?? error}`);
  }
}
