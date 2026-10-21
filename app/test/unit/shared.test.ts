import { afterEach, describe, expect, test } from 'vitest';
import {
  lockBusyUnder,
  lockFree,
  lockStop,
  lockThread,
  processLock,
  sharedClient,
} from '@/runtime/wasi/shared';

const realWait = Atomics.wait;
const realExchange = Atomics.compareExchange;
afterEach(() => {
  Atomics.wait = realWait;
  Atomics.compareExchange = realExchange;
});

// A channel to files.js, which `answer` answers in place of its wait for
// the answer (the lock's word, as the call saw it, kept in `seen`).
function channel(lock: SharedArrayBuffer, seen: number[]) {
  const doorbell = new SharedArrayBuffer(4);
  const shared = new SharedArrayBuffer(1024);
  const control = new Int32Array(shared, 0, 2);
  const answer = new TextEncoder().encode('{"ok":true}');
  Atomics.wait = ((array: Int32Array, index: number, value: number, timeout?: number) => {
    if (array.buffer !== shared) return realWait(array, index, value, timeout);
    seen.push(Atomics.load(new Int32Array(lock), 0));
    new DataView(shared, 8).setUint32(0, answer.length, true);
    new Uint8Array(shared, 12).set(answer);
    Atomics.store(control, 1, 4 + answer.length);
    Atomics.store(control, 0, 2);
    return 'ok';
  }) as typeof Atomics.wait;
  return { doorbell, shared };
}

// A wait on the lock throws: a thread that waits for good shows it so.
function waitsForGood(lock: SharedArrayBuffer) {
  const lockWait = Atomics.wait;
  Atomics.wait = ((array: Int32Array, index: number, value: number, timeout?: number) => {
    if (array.buffer === lock) throw new Error('waits for good');
    return lockWait(array, index, value, timeout);
  }) as typeof Atomics.wait;
}

describe("a process's lock", () => {
  test('says whether a thread, or one under it, holds it', () => {
    const lock = processLock();
    const a = lockThread(lock, 1);
    const b = lockThread(lock, a);
    const c = lockThread(lock, 1);
    const words = new Int32Array(lock);
    Atomics.store(words, 0, b);
    expect([a, b, c].map((token) => lockBusyUnder(lock, token))).toEqual([true, true, false]);
    Atomics.store(words, 0, 1);
    expect(lockBusyUnder(lock, a)).toBe(false);
    expect(lockBusyUnder(lock, 1)).toBe(true);
    Atomics.store(words, 0, 0);
    expect(lockBusyUnder(lock, 1)).toBe(false);
  });

  test("is a thread's, by its token, for its call, and free after", () => {
    const lock = processLock();
    const a = lockThread(lock, 1);
    const seen: number[] = [];
    const { doorbell, shared } = channel(lock, seen);
    const call = sharedClient(doorbell, shared, lock, a);
    expect(call({ op: 'status' }).answer).toEqual({ ok: true });
    expect(seen).toEqual([a]);
    expect(Atomics.load(new Int32Array(lock), 0)).toBe(0);
  });

  test('is not taken by a thread under one being stopped: it waits for good', () => {
    const lock = processLock();
    const a = lockThread(lock, 1);
    const b = lockThread(lock, a);
    lockStop(lock, a);
    const seen: number[] = [];
    const { doorbell, shared } = channel(lock, seen);
    const call = sharedClient(doorbell, shared, lock, b);
    waitsForGood(lock);
    expect(() => call({ op: 'status' })).toThrow('waits for good');
    expect(seen).toEqual([]);
    expect(Atomics.load(new Int32Array(lock), 0)).toBe(0);
  });

  test('is waited out for a thread stopped just as it takes it', () => {
    const lock = processLock();
    const a = lockThread(lock, 1);
    const seen: number[] = [];
    const { doorbell, shared } = channel(lock, seen);
    const call = sharedClient(doorbell, shared, lock, a);
    // Its parent stops it between its look at its stop word and its taking,
    // and sees it busy: it does not stop its worker yet.
    const busy: boolean[] = [];
    Atomics.compareExchange = ((...args: Parameters<typeof realExchange>) => {
      if (args[0].buffer === lock) {
        lockStop(lock, a);
        busy.push(lockBusyUnder(lock, a));
      }
      return realExchange(...args);
    }) as typeof realExchange;
    expect(call({ op: 'status' }).answer).toEqual({ ok: true });
    expect(busy).toEqual([true]);
    expect(lockBusyUnder(lock, a)).toBe(false);
    // Its next call waits for good.
    waitsForGood(lock);
    expect(() => call({ op: 'status' })).toThrow('waits for good');
    expect(seen).toEqual([a]);
    expect(lockBusyUnder(lock, a)).toBe(false);
  });

  test("gives a stopped thread's token, and those under it, to new ones", () => {
    const lock = processLock();
    for (let i = 0; i < 2000; i++) {
      const a = lockThread(lock, 1);
      lockThread(lock, a);
      lockStop(lock, a);
      lockFree(lock, a);
    }
    // A new thread is not stopped, and its stop still stops those under it.
    const seen: number[] = [];
    const { doorbell, shared } = channel(lock, seen);
    const a = lockThread(lock, 1);
    expect(sharedClient(doorbell, shared, lock, a)({ op: 'status' }).answer).toEqual({ ok: true });
    const call = sharedClient(doorbell, shared, lock, lockThread(lock, a));
    lockStop(lock, a);
    waitsForGood(lock);
    expect(() => call({ op: 'status' })).toThrow('waits for good');
    expect(seen).toEqual([a]);
  });

  test('leaves the tokens of threads not under a stopped one', () => {
    const lock = processLock();
    const a = lockThread(lock, 1);
    const b = lockThread(lock, 1);
    lockFree(lock, a);
    expect(lockThread(lock, 1)).toBe(a);
    expect(lockThread(lock, 1)).not.toBe(b);
  });

  test('is too small for more threads than its table at once', () => {
    const lock = processLock();
    expect(() => {
      for (;;) lockThread(lock, 1);
    }).toThrow('at most');
  });
});
