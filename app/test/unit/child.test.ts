import { describe, expect, test, vi } from 'vitest';
import { createChildProcess } from '@/runtime/nodejs/child';

type Spawn = { id: number; shared?: SharedArrayBuffer };

// node:child_process with an exec frame that answers each spawn with
// `output` (and `errors` on its stderr) and `code`: at once to a
// synchronous one, else when asked.
function children(
  output: string,
  code: number,
  written: [number, string][] = [],
  files?: { dup(fd: number): number; close(fd: number): void; throughFd(path: string): string },
  errors = '',
) {
  const spawned: Spawn[] = [];
  const posted: { op: string }[] = [];
  const bytes = new TextEncoder().encode(output);
  const errorBytes = new TextEncoder().encode(errors);
  const post = (message: unknown) => {
    const m = message as Spawn & { op: string };
    posted.push(m);
    if (m.op !== 'spawn') return;
    spawned.push(m);
    if (!m.shared) return;
    // [done, status, stdout's length, stderr's], then a room for each.
    const header = new Int32Array(m.shared, 0, 4);
    const room = (m.shared.byteLength - 16) / 2;
    new Uint8Array(m.shared, 16).set(bytes);
    new Uint8Array(m.shared, 16 + room).set(errorBytes);
    Atomics.store(header, 1, code);
    Atomics.store(header, 2, bytes.length);
    Atomics.store(header, 3, errorBytes.length);
    Atomics.store(header, 0, 1);
  };
  const { module, receive } = createChildProcess(post, () => () => {}, {
    cwd: () => '/',
    env: {},
    write: (fd, data) => written.push([fd, new TextDecoder().decode(data)]),
    files,
  });
  const answer = () => {
    for (const { id } of spawned.splice(0)) {
      receive({ kind: 'child', op: 'out', id, bytes });
      if (errorBytes.length) receive({ kind: 'child', op: 'err', id, bytes: errorBytes });
      receive({ kind: 'child', op: 'exit', id, code });
    }
  };
  return { module, answer, posted };
}

type Done = (error: (Error & { code?: unknown }) | null, stdout: unknown) => void;

describe('child_process', () => {
  test("a child's stderr is its own stream, apart from its stdout", async () => {
    const { module, answer } = children('out\n', 0, [], undefined, 'err\n');
    const child = module.spawn('sh', ['-c', 'echo out; echo err >&2']);
    const got: Record<string, string> = { out: '', err: '' };
    child.stdout!.on('data', (chunk: Uint8Array) => (got.out += new TextDecoder().decode(chunk)));
    child.stderr!.on('data', (chunk: Uint8Array) => (got.err += new TextDecoder().decode(chunk)));
    const closed = new Promise((resolve) => child.on('close', resolve));
    answer();
    expect(await closed).toBe(0);
    expect(got).toEqual({ out: 'out\n', err: 'err\n' });
  });

  test("exec's callback and spawnSync have the stderr apart; execSync's error says it", async () => {
    const { module, answer } = children('out\n', 1, [], undefined, 'it failed\n');
    const done = new Promise<unknown[]>((resolve) =>
      module.exec('false', (...args: unknown[]) => resolve(args)),
    );
    answer();
    const [error, stdout, stderr] = await done;
    expect([stdout, stderr]).toEqual(['out\n', 'it failed\n']);
    expect((error as Error).message).toContain('it failed');
    const result = module.spawnSync('false', [], { encoding: 'utf8' });
    expect([result.stdout, result.stderr, result.status]).toEqual(['out\n', 'it failed\n', 1]);
    expect(() => module.execSync('false')).toThrow(/it failed/);
  });

  test("sh's not found on stderr is spawn's ENOENT", async () => {
    const { module, answer } = children('', 127, [], undefined, 'error: command not found: nope\n');
    const child = module.spawn('nope', []);
    const failed = new Promise<Error & { code?: string }>((resolve) => child.on('error', resolve));
    answer();
    expect((await failed).code).toBe('ENOENT');
    expect(module.spawnSync('nope', []).error).toMatchObject({ code: 'ENOENT' });
  });

  test("a child's output to a file the process opened goes there, by an fd of its own", async () => {
    const written: [number, string][] = [];
    const closed: number[] = [];
    const files = {
      dup: (fd: number) => fd + 100,
      close: (fd: number) => void closed.push(fd),
      throughFd: (path: string) => path.replace(/^\/proc\/self\/fd\/31/, '/usr/bin/rg'),
    };
    const { module, answer, posted } = children('from the child\n', 0, written, files);
    const child = module.spawn('/proc/self/fd/31', ['--files', '/proc/self/fd/31'], {
      stdio: ['ignore', 7, 7],
    });
    const done = new Promise((resolve) => child.on('close', resolve));
    answer();
    await done;
    // Claude Code closes its own fd once it has spawned: the child writes on.
    expect(written).toEqual([[107, 'from the child\n']]);
    expect(closed).toEqual([107]);
    expect((posted[0] as unknown as { line: string }).line).toBe('/usr/bin/rg --files /usr/bin/rg');
  });

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
  test('a child says which of stdin and stdout it inherits, and an inherited stdin is not ended', () => {
    const { module, posted } = children('', 0);
    const stdin = { fd: 0 };
    module.spawn('a', [], { stdio: 'inherit' });
    module.spawn('b', [], { stdio: [stdin, 'pipe', 'inherit'] });
    module.spawn('c', [], { stdio: ['pipe', 1, 2] });
    module.spawn('d', []);
    module.spawnSync('e', [], { stdio: 'inherit' });
    module.spawnSync('f', [], { stdio: 'inherit', input: 'x' });
    const spawns = posted.filter((m) => m.op === 'spawn') as unknown as {
      terminal: boolean[];
      input?: Uint8Array;
    }[];
    expect(spawns.map((m) => m.terminal)).toEqual([
      [true, true],
      [true, false],
      [false, true],
      [false, false],
      [true, true],
      [true, true],
    ]);
    expect(spawns[4].input).toBeUndefined();
    expect(spawns[5].input).toEqual(new TextEncoder().encode('x'));
  });
});
