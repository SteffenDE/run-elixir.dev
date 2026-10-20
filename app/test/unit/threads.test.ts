import { describe, expect, test } from 'vitest';
import { createThreads } from '../../src/runtime/nodejs/threads';

// A thread's worker_threads, with `workerData`, counting what holds it.
function thread(workerData: unknown) {
  const held = { count: 0 };
  const threads = createThreads({
    script: '',
    shared: {},
    cwd: () => '/',
    env: {},
    write() {},
    hold: () => {
      held.count++;
      return () => held.count--;
    },
    resolve: (file) => file,
    self: { threadId: 1, token: 2, file: null, code: '', workerData, argv: [], env: {} },
    post() {},
  });
  return { threads, held };
}

describe('a port a thread receives', () => {
  test("in its workerData is Node's, holding the thread while listened to", () => {
    const { port1, port2 } = new MessageChannel();
    const { held } = thread({ nested: [{ port: port1 }] });
    const listener = () => {};
    (port1 as unknown as { on(e: string, f: () => void): void }).on('message', listener);
    expect(held.count).toBe(1);
    (port1 as unknown as { off(e: string, f: () => void): void }).off('message', listener);
    expect(held.count).toBe(0);
    port1.close();
    port2.close();
  });

  test("in a message is Node's", () => {
    const { port1, port2 } = new MessageChannel();
    const { threads, held } = thread(null);
    threads.deliver({ port: port1 }, [port1]);
    (port1 as unknown as { ref(): void }).ref();
    expect(held.count).toBe(1);
    port1.close();
    port2.close();
    expect(held.count).toBe(0);
  });
});
