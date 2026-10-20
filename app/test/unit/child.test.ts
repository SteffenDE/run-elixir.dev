import { describe, expect, test, vi } from 'vitest';
import { createChildProcess } from '../../src/runtime/nodejs/child';

type Spawn = { id: number; shared?: SharedArrayBuffer };

// node:child_process with an exec frame that answers each spawn with
// `output` and `code`: at once to a synchronous one, else when asked.
function children(output: string, code: number) {
  const spawned: Spawn[] = [];
  const posted: { op: string }[] = [];
  const bytes = new TextEncoder().encode(output);
  const post = (message: unknown) => {
    const m = message as Spawn & { op: string };
    posted.push(m);
    if (m.op !== 'spawn') return;
    spawned.push(m);
    if (!m.shared) return;
    const header = new Int32Array(m.shared, 0, 3);
    new Uint8Array(m.shared, 12).set(bytes);
    Atomics.store(header, 1, code);
    Atomics.store(header, 2, bytes.length);
    Atomics.store(header, 0, 1);
  };
  const { module, receive } = createChildProcess(post, () => () => {}, {
    cwd: () => '/',
    env: {},
    write: () => {},
  });
  const answer = () => {
    for (const { id } of spawned.splice(0)) {
      receive({ kind: 'child', op: 'out', id, bytes });
      receive({ kind: 'child', op: 'exit', id, code });
    }
  };
  return { module, answer, posted };
}

type Done = (error: (Error & { code?: unknown }) | null, stdout: unknown) => void;

describe('child_process', () => {
  test('a program that exits 127 is not one that was not found', async () => {
    const { module, answer } = children('error: command not found: eslint\n', 127);
    const done = new Promise<Parameters<Done>>((resolve) =>
      module.execFile('npm', ['run', 'lint'], ((...args) => resolve(args)) as Done),
    );
    answer();
    const [error, stdout] = await done;
    expect(error?.code).toBe(127);
    expect(stdout).toBe('error: command not found: eslint\n');
    const result = module.spawnSync('npm', ['run', 'lint']);
    expect(result.status).toBe(127);
    expect(result.error).toBeUndefined();
  });

  test("a program sh did not find is spawn's ENOENT", async () => {
    const { module, answer } = children('error: command not found: nothere\n', 127);
    const done = new Promise<Parameters<Done>>((resolve) =>
      module.execFile('nothere', ((...args) => resolve(args)) as Done),
    );
    answer();
    const [error] = await done;
    expect(error?.code).toBe('ENOENT');
    expect(module.spawnSync('nothere').error).toMatchObject({ code: 'ENOENT' });
  });

  test("exec's output is a Buffer with encoding null or 'buffer', else text", async () => {
    const { module, answer } = children('hi\n', 0);
    const run = (options: object) =>
      new Promise<unknown>((resolve) => {
        module.exec('echo hi', options, (_error, stdout) => resolve(stdout));
        answer();
      });
    expect(Buffer.isBuffer(await run({ encoding: null }))).toBe(true);
    expect(Buffer.isBuffer(await run({ encoding: 'buffer' }))).toBe(true);
    expect(await run({})).toBe('hi\n');
    expect(await run({ encoding: 'hex' })).toBe('68690a');
  });

  test('null or undefined arguments are none, before the options', async () => {
    const { module, answer, posted } = children('hi\n', 0);
    const spawns = () => posted.filter(({ op }) => op === 'spawn') as { cwd?: string }[];
    const done = new Promise<Parameters<Done>>((resolve) =>
      module.execFile('ls', null, { cwd: '/work' }, ((...args) => resolve(args)) as Done),
    );
    answer();
    expect((await done)[1]).toBe('hi\n');
    module.spawn('ls', undefined, { cwd: '/work' });
    module.fork('script.js', null, { cwd: '/work' });
    module.spawnSync('ls', null, { cwd: '/work' });
    module.execFileSync('ls', null, { cwd: '/work' });
    expect(spawns().map(({ cwd }) => cwd)).toEqual(Array(5).fill('/work'));
  });

  test.each([
    ['SIGKILL', 'SIGKILL'],
    ['SIGINT', 'SIGINT'],
    [9, 'SIGKILL'],
    [undefined, 'SIGTERM'],
  ])('a child killed with %s says it ended by %s', async (sent, said) => {
    const { module, answer } = children('', 143);
    const child = module.spawn('sleep', ['10']);
    const exit = new Promise((resolve) => child.on('exit', (...args) => resolve(args)));
    child.kill(sent);
    answer();
    expect(await exit).toEqual([null, said]);
    expect(child.signalCode).toBe(said);
  });

  test("a child's timeout and abort signal hold nothing once it has exited", async () => {
    vi.useFakeTimers();
    try {
      const { module, answer, posted } = children('', 0);
      const abort = new AbortController();
      const done = new Promise((resolve) =>
        module.exec('ls', { timeout: 60000, signal: abort.signal }, resolve),
      );
      answer();
      await done;
      expect(vi.getTimerCount()).toBe(0);
      abort.abort();
      expect(posted.filter(({ op }) => op === 'kill')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
