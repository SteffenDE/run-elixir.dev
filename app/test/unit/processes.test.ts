import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  HOSTED_LIMIT,
  Processes,
  SIGINT,
  hosted,
  inputPipe,
  pipe,
  release,
  wasmProgram,
  type Program,
} from '@/runtime/processes';
import type { Descriptor } from '@/runtime/wasi/descriptors';
import { CAPACITY, Pipe } from '@/runtime/wasi/pipe';
import { Dir, File, devnull } from '@/runtime/wasi/fs';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// A capture: a stream whose writes are kept.
function capture(): { entry: Descriptor; text: () => string } {
  let text = '';
  return { entry: { stream: true, sink: (bytes) => (text += decode(bytes)) }, text: () => text };
}

// Reads a pipe's end to its end, waiting as a process would.
async function drain(entry: Descriptor): Promise<string> {
  let out = '';
  for (;;) {
    const bytes = entry.pipe!.read(4096);
    if (!bytes) await entry.pipe!.changed();
    else if (!bytes.length) return out;
    else out += decode(bytes);
  }
}

describe('Pipe', () => {
  test('waits while empty, ends once its writers are gone', () => {
    const between = new Pipe();
    between.open(true);
    between.open(false);
    expect(between.read(10)).toBeNull();
    expect(between.write(encode('hi'))).toBe(2);
    expect(decode(between.read(10)!)).toBe('hi');
    between.close(false);
    expect(between.read(10)!.length).toBe(0);
  });

  test('takes what it has room for; a writer that cannot wait writes past it', () => {
    const between = new Pipe();
    between.open(true);
    between.open(false);
    expect(between.write(new Uint8Array(CAPACITY + 10))).toBe(CAPACITY);
    expect(between.write(new Uint8Array(1))).toBeNull();
    expect(between.write(new Uint8Array(5), false)).toBe(5);
    expect(between.size).toBe(CAPACITY + 5);
  });

  test('a write with no reader left fails', () => {
    const between = new Pipe();
    between.open(false);
    expect(between.write(encode('x'))).toBe(-1);
  });

  test('wakes who waits when it changes', async () => {
    const between = new Pipe();
    between.open(true);
    between.open(false);
    const woken = between.changed();
    between.write(encode('x'));
    await woken;
  });
});

describe('Processes', () => {
  test('runs a producer and its reader at once, bounded by the pipe', async () => {
    // Writes 1 MiB in 4 KiB pieces, waiting for room as a process does.
    const producer: Program = async (_child, { stdio }) => {
      const out = stdio[1].pipe!;
      for (let i = 0; i < 256; i++) {
        const piece = new Uint8Array(4096).fill(97);
        let at = 0;
        while (at < piece.length) {
          const took = out.write(piece.subarray(at));
          if (took === -1) return 141;
          if (took === null) await out.changed();
          else at += took;
        }
        expect(out.size).toBeLessThanOrEqual(CAPACITY);
      }
      return 0;
    };
    const counter: Program = async (_child, { stdio }) => {
      const text = await drain(stdio[0]);
      stdio[1].sink!(encode(String(text.length)));
      return 0;
    };
    const processes = new Processes((name) => ({ producer, counter })[name] ?? null);
    const [read, write] = pipe();
    const out = capture();
    const none = inputPipe(new Uint8Array(0));
    const first = processes.spawn({
      program: 'producer',
      args: [],
      cwd: '/',
      env: {},
      stdio: [none, write, out.entry],
    })!;
    const second = processes.spawn({
      program: 'counter',
      args: [],
      cwd: '/',
      env: {},
      stdio: [read, out.entry, out.entry],
    })!;
    for (const entry of [read, write, none]) release(entry);
    expect(await processes.wait(first.pid, 0)).toBe(0);
    expect(await processes.wait(second.pid, 0)).toBe(0);
    expect(out.text()).toBe(String(256 * 4096));
    expect(processes.table.size).toBe(0);
  });

  test('has no program for a name it does not know', () => {
    const processes = new Processes(() => null);
    const none = inputPipe(new Uint8Array(0));
    expect(
      processes.spawn({ program: 'nope', args: [], cwd: '/', env: {}, stdio: [none, none, none] }),
    ).toBeNull();
  });

  test('a signal ends a process that waits', async () => {
    const sleeper: Program = async (child) => {
      await child.woken;
      child.check();
      return 0;
    };
    const processes = new Processes(() => sleeper);
    const out = capture();
    const child = processes.spawn({
      program: 'sleeper',
      args: [],
      cwd: '/',
      env: {},
      stdio: [out.entry, out.entry, out.entry],
    })!;
    const shell = processes.adopt();
    processes.interrupt();
    expect(await processes.wait(child.pid, 0)).toBe(128 + SIGINT);
    expect(shell.signal).toBeNull();
  });

  test("a host's program takes its input whole, and is bounded ahead of its reader", async () => {
    const processes = new Processes(() =>
      hosted(
        processes,
        async (_program, args, _cwd, _env, io) => {
          if (args[0] === 'echo') io.stdout!(io.input!);
          else io.stdout!(new Uint8Array(HOSTED_LIMIT + 1));
          return 0;
        },
        null,
      ),
    );
    const out = capture();
    expect(
      await processes.run({
        program: 'host',
        args: ['echo'],
        cwd: '/',
        env: {},
        stdio: [inputPipe(encode('whole')), out.entry, out.entry],
      }),
    ).toBe(0);
    expect(out.text()).toBe('whole');
    const [read, write] = pipe();
    const errors = capture();
    expect(
      await processes.run({
        program: 'host',
        args: ['flood'],
        cwd: '/',
        env: {},
        stdio: [inputPipe(new Uint8Array(0)), write, errors.entry],
      }),
    ).toBe(1);
    release(read);
    expect(errors.text()).toContain('exceeded 16 MiB');
  });
});

// git itself (git/build.py), when it is built: what it runs as processes.
const GIT = new URL('../../../target/git/git.wasm', import.meta.url).pathname;
describe.skipIf(!existsSync(GIT))('git.wasm as processes', () => {
  test('a merge with local changes, a worktree, gc and fsck', { timeout: 60_000 }, async () => {
    const module = new WebAssembly.Module(readFileSync(GIT));
    const root = new Dir();
    root.put('dev/null', devnull());
    root.put('home/.keep', new File());
    root.put('work/repo/a.txt', new File(encode('one\n')));
    const fetch = () => {
      throw new Error('no fetch');
    };
    const processes: Processes = new Processes((program) =>
      program.split('/').pop() === 'git'
        ? wasmProgram(processes, module, { root, fetch, shared: null })
        : null,
    );
    const env = {
      HOME: '/home',
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@example.com',
      GIT_PAGER: 'cat',
    };
    const git = async (...args: string[]) => {
      const out = capture();
      const status = await processes.run({
        program: 'git',
        args,
        cwd: '/work/repo',
        env,
        stdio: [inputPipe(new Uint8Array(0)), out.entry, out.entry],
      });
      return { status, text: out.text() };
    };
    await git('init', '-q', '-b', 'main');
    await git('add', 'a.txt');
    expect((await git('commit', '-qm', 'first')).text).not.toContain('cannot run');
    await git('switch', '-qc', 'feature');
    root.put('work/repo/b.txt', new File(encode('b\n')));
    await git('add', 'b.txt');
    await git('commit', '-qm', 'feature');
    await git('switch', '-q', 'main');
    root.put('work/repo/a.txt', new File(encode('one\nlocal\n')));
    expect((await git('merge', '--autostash', '--no-edit', 'feature')).text).toContain(
      'Applied autostash.',
    );
    expect((await git('worktree', 'add', '-q', '../wt')).status).toBe(0);
    expect((await git('gc', '-q')).status).toBe(0);
    expect((await git('count-objects', '-v')).text).toContain('count: 0');
    expect((await git('fsck')).status).toBe(0);
    expect(processes.table.size).toBe(0);
  });
});
