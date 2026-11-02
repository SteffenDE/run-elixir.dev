// A worker that starts again when its script does not load
// (src/host/worker.ts): what it was sent before its first message reaches
// the worker that loads, once; a worker that loaded and then fails is not
// started again.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LOADED, RetryingWorker } from '../../src/host/worker';

// A Worker that records what it was sent, and fails or answers on cue.
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  sent: unknown[] = [];
  terminated = false;
  postMessage(message: unknown): void {
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  fail(message = ''): void {
    this.onerror?.({ message, preventDefault: () => {} });
  }
  say(data: unknown): void {
    this.onmessage?.({ data });
  }
}

let made: FakeWorker[];
const create = () => {
  const thread = new FakeWorker();
  made.push(thread);
  return thread as unknown as Worker;
};

beforeEach(() => {
  made = [];
  vi.useFakeTimers();
  // Its warnings and errors, which these failures cause.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('holds what it is sent until the worker loads, through failed loads', () => {
  const worker = new RetryingWorker('test.js', create, true);
  const heard: unknown[] = [];
  worker.onmessage = ({ data }) => heard.push(data);
  worker.postMessage({ kind: 'start' });
  expect(made[0].sent).toEqual([]);
  made[0].fail();
  expect(made[0].terminated).toBe(true);
  vi.runAllTimers();
  expect(made).toHaveLength(2);
  made[1].say(LOADED);
  expect(made[1].sent).toEqual([{ kind: 'start' }]);
  expect(heard).toEqual([]);
  worker.postMessage({ kind: 'run' });
  made[1].say({ kind: 'out' });
  expect(made[1].sent).toEqual([{ kind: 'start' }, { kind: 'run' }]);
  expect(heard).toEqual([{ kind: 'out' }]);
});

it('posts at once and again to the next worker, without holding', () => {
  const worker = new RetryingWorker('test.js', create, false);
  worker.postMessage({ kind: 'start' });
  worker.postMessage({ kind: 'stdin' });
  expect(made[0].sent).toEqual([{ kind: 'start' }, { kind: 'stdin' }]);
  made[0].fail();
  vi.runAllTimers();
  expect(made[1].sent).toEqual([{ kind: 'start' }, { kind: 'stdin' }]);
  made[1].say({ kind: 'out' });
  // Nothing is kept once it runs: a later failure is not a load's.
  made[1].fail();
  vi.runAllTimers();
  expect(made).toHaveLength(2);
});

it('reports the failure after its retries, and an error with a message at once', () => {
  const failures: string[] = [];
  const worker = new RetryingWorker('test.js', create, true);
  worker.onerror = (event) => failures.push(event.message || 'did not load');
  for (let i = 0; i < 5; i++) {
    made.at(-1)!.fail();
    vi.runAllTimers();
  }
  expect(made).toHaveLength(5);
  expect(failures).toEqual(['did not load']);

  const thrown = new RetryingWorker('test.js', create, true);
  thrown.onerror = (event) => failures.push(event.message);
  made.at(-1)!.fail('ReferenceError: x is not defined');
  vi.runAllTimers();
  expect(made).toHaveLength(6);
  expect(failures).toEqual(['did not load', 'ReferenceError: x is not defined']);
});

it('starts no other worker once terminated', () => {
  const worker = new RetryingWorker('test.js', create, true);
  made[0].fail();
  worker.terminate();
  vi.runAllTimers();
  expect(made).toHaveLength(1);
});

it('loads gated workers one at a time', async () => {
  const first = new RetryingWorker('test.js', create, true, true);
  const second = new RetryingWorker('test.js', create, true, true);
  const third = new RetryingWorker('test.js', create, true, true);
  await vi.advanceTimersByTimeAsync(0);
  expect(made).toHaveLength(1);
  made[0].say(LOADED);
  await vi.advanceTimersByTimeAsync(0);
  expect(made).toHaveLength(2);
  // A failed load lets the next one load, and waits its turn to retry.
  made[1].fail();
  await vi.advanceTimersByTimeAsync(0);
  expect(made).toHaveLength(3);
  made[2].say(LOADED);
  await vi.advanceTimersByTimeAsync(1000);
  expect(made).toHaveLength(4);
  made[3].say(LOADED);
  for (const each of [first, second, third]) each.terminate();
});

it('lets the next gated worker load when one hangs, or ends', async () => {
  const hung = new RetryingWorker('test.js', create, true, true);
  const ended = new RetryingWorker('test.js', create, true, true);
  const last = new RetryingWorker('test.js', create, true, true);
  ended.terminate();
  await vi.advanceTimersByTimeAsync(0);
  expect(made).toHaveLength(1);
  // The first never loads: the next goes after 2 s, past the ended one.
  await vi.advanceTimersByTimeAsync(2000);
  expect(made).toHaveLength(2);
  hung.terminate();
  last.terminate();
});
