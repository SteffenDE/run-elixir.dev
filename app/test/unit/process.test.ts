import { describe, expect, test } from 'vitest';
import { createProcess } from '@/runtime/nodejs/process';

// A process whose end is recorded, with `dirs` its directories and `files`
// its files.
function start(options: { dirs?: string[]; files?: string[] } = {}) {
  const ended: number[] = [];
  let resolveEnd: (code: number) => void = () => {};
  const end = new Promise<number>((resolve) => (resolveEnd = resolve));
  const created = createProcess({
    argv: ['/usr/bin/node'],
    env: {},
    cwd: '/home',
    io: {
      write() {},
      exit(code) {
        ended.push(code);
        resolveEnd(code);
        return undefined as never;
      },
    },
    tty: false,
    columns: 80,
    stat: (p) =>
      options.dirs?.includes(p) || options.files?.includes(p)
        ? { isDirectory: () => options.dirs!.includes(p) }
        : undefined,
  });
  const process = created.process as unknown as {
    cwd(): string;
    chdir(dir: string): void;
    exit(code?: number): never;
    exitCode?: number;
    on(event: string, fn: (...args: unknown[]) => void): void;
  };
  return { ...created, process, ended, end };
}

describe('process.chdir', () => {
  test('resolves against the directory it is in', () => {
    const { process } = start({ dirs: ['/home/a', '/home/a/b', '/'] });
    process.chdir('a');
    process.chdir('./b/');
    expect(process.cwd()).toBe('/home/a/b');
    process.chdir('../../..');
    expect(process.cwd()).toBe('/');
  });

  test("fails as Node's does for what is not a directory", () => {
    const { process } = start({ dirs: [], files: ['/home/f'] });
    for (const [dir, code, errno] of [
      ['nope', 'ENOENT', -2],
      ['f', 'ENOTDIR', -20],
    ] as const) {
      let error: (Error & Record<string, unknown>) | undefined;
      try {
        process.chdir(dir);
      } catch (e) {
        error = e as Error & Record<string, unknown>;
      }
      expect(error).toMatchObject({ code, errno, syscall: 'chdir', path: '/home', dest: dir });
      expect(error!.message).toContain(`chdir '/home' -> '${dir}'`);
    }
    expect(process.cwd()).toBe('/home');
  });
});

describe("the process's exit code", () => {
  test("is process.exit's, as process.exitCode in 'exit'", () => {
    const { process, ended } = start();
    const seen: unknown[] = [];
    process.on('exit', (code) => seen.push(code, process.exitCode));
    process.exit(5);
    expect(seen).toEqual([5, 5]);
    expect(ended).toEqual([5]);
  });

  test("is what an 'exit' listener sets", async () => {
    const { process, ended } = start();
    process.on('exit', () => (process.exitCode = 3));
    process.exit(5);
    expect(ended).toEqual([3]);
    const other = start();
    other.process.on('exit', () => (other.process.exitCode = 4));
    (other.timers.setTimeout as (fn: () => void) => void)(() => {});
    expect(await other.end).toBe(4);
  });
});

describe('a timer that has fired', () => {
  type Timer = { ref(): Timer; refresh(): Timer; hasRef(): boolean };
  const later = (timers: Record<string, unknown>, fn: () => void) =>
    (timers.setTimeout as (fn: () => void, ms: number) => Timer)(fn, 1);

  test('ref holds the process no longer', async () => {
    const { timers, end } = start();
    const timer: Timer = later(timers, () => timer.ref());
    expect(await end).toBe(0);
    expect(timer.hasRef()).toBe(true);
  });

  test('refresh runs it again, holding the process meanwhile', async () => {
    const { timers, end } = start();
    let runs = 0;
    const timer: Timer = later(timers, () => {
      if (++runs < 3) timer.refresh();
    });
    expect(await end).toBe(0);
    expect(runs).toBe(3);
  });
});
