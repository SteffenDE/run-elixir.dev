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
  share,
  wasmProgram,
  type Program,
  type Resolve,
} from '@/runtime/processes';
import { remoteHelper } from '@/runtime/git-remote';
import type { Descriptor } from '@/runtime/wasi/descriptors';
import { CAPACITY, Pipe } from '@/runtime/wasi/pipe';
import { Dir, File, devnull } from '@/runtime/wasi/fs';
import { words } from '@/runtime/sh';

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
  // A repository at /work/repo with one commit, and git(cwd, ...args).
  async function repository(other: Resolve = () => null) {
    const module = new WebAssembly.Module(readFileSync(GIT));
    const root = new Dir();
    root.put('dev/null', devnull());
    root.put('home/.keep', new File());
    root.mkdirs('usr/share/git-core/templates');
    root.put('work/repo/a.txt', new File(encode('one\n')));
    const fetch = () => {
      throw new Error('no fetch');
    };
    // sh -c LINE as a simple command's words, run with sh's own streams
    // (the playground's sh is brush: worker/index.ts).
    const sh: Program = async (_child, { args, cwd, env: vars, stdio }) => {
      const [program, ...rest] = words(args[1] ?? '');
      const status = await processes.run({
        program,
        args: rest,
        cwd,
        env: vars,
        stdio: stdio.map((entry) => share(entry)) as typeof stdio,
      });
      return status ?? 127;
    };
    const processes: Processes = new Processes((program, args, cwd, env) => {
      const found = other(program, args, cwd, env);
      if (found) return found;
      const name = program.split('/').pop()!;
      if (name === 'sh') return sh;
      // git-upload-pack and its kind: git's dashed names.
      return name === 'git' || name.startsWith('git-')
        ? wasmProgram(processes, module, { root, fetch, shared: null, argv0: name })
        : null;
    });
    const env = {
      HOME: '/home',
      GIT_AUTHOR_NAME: 'A',
      GIT_AUTHOR_EMAIL: 'a@example.com',
      GIT_COMMITTER_NAME: 'A',
      GIT_COMMITTER_EMAIL: 'a@example.com',
      GIT_PAGER: 'cat',
    };
    const git = async (cwd: string, ...args: string[]) => {
      const out = capture();
      const status = await processes.run({
        program: 'git',
        args,
        cwd,
        env,
        stdio: [inputPipe(new Uint8Array(0)), out.entry, out.entry],
      });
      return { status, text: out.text() };
    };
    // git upload-pack as smart HTTP's server runs it (protocol v2): its
    // answer's bytes.
    const serve = async (dir: string, body: Uint8Array, info: boolean) => {
      const parts: Uint8Array[] = [];
      const out: Descriptor = { stream: true, sink: (bytes) => void parts.push(bytes.slice()) };
      await processes.run({
        program: 'git',
        args: [
          'upload-pack',
          '--stateless-rpc',
          ...(info ? ['--http-backend-info-refs'] : []),
          dir,
        ],
        cwd: '/',
        env: { ...env, GIT_PROTOCOL: 'version=2' },
        stdio: [inputPipe(body), out, capture().entry],
      });
      return new Blob(parts as BlobPart[]);
    };
    await git('/work/repo', 'init', '-q', '-b', 'main');
    await git('/work/repo', 'add', 'a.txt');
    await git('/work/repo', 'commit', '-qm', 'first');
    return { git, root, processes, serve };
  }

  test('a merge with local changes, a worktree, gc and fsck', { timeout: 60_000 }, async () => {
    const { git, root, processes } = await repository();
    const at = (...args: string[]) => git('/work/repo', ...args);
    await at('switch', '-qc', 'feature');
    root.put('work/repo/b.txt', new File(encode('b\n')));
    await at('add', 'b.txt');
    expect((await at('commit', '-qm', 'feature')).text).not.toContain('cannot run');
    await at('switch', '-q', 'main');
    root.put('work/repo/a.txt', new File(encode('one\nlocal\n')));
    expect((await at('merge', '--autostash', '--no-edit', 'feature')).text).toContain(
      'Applied autostash.',
    );
    expect((await at('worktree', 'add', '-q', '../wt')).status).toBe(0);
    expect((await at('gc', '-q')).status).toBe(0);
    expect((await at('count-objects', '-v')).text).toContain('count: 0');
    expect((await at('fsck')).status).toBe(0);
    expect(processes.table.size).toBe(0);
  });

  test(
    'a clone, a push and a fetch over file://, with start_async',
    { timeout: 60_000 },
    async () => {
      const { git, root, processes } = await repository();
      // --no-local: upload-pack as a child (through sh), the sideband
      // demultiplexed beside git (start_async).
      const cloned = await git('/work', 'clone', '--no-local', '-q', 'file:///work/repo', 'copy');
      expect(cloned.text).toBe('');
      expect(cloned.status).toBe(0);
      expect((await git('/work/copy', 'log', '--format=%s')).text).toBe('first\n');
      root.put('work/copy/c.txt', new File(encode('c\n')));
      await git('/work/copy', 'add', 'c.txt');
      await git('/work/copy', 'commit', '-qm', 'second');
      await git('/work', 'init', '-q', '--bare', 'bare.git');
      const pushed = await git('/work/copy', 'push', '-q', 'file:///work/bare.git', 'main');
      expect(pushed.text).toBe('');
      expect(pushed.status).toBe(0);
      expect((await git('/work/bare.git', 'log', '--format=%s', 'main')).text).toBe(
        'second\nfirst\n',
      );
      const fetched = await git('/work/repo', 'fetch', '-q', 'file:///work/bare.git', 'main');
      expect(fetched.status).toBe(0);
      expect((await git('/work/repo', 'log', '--format=%s', 'FETCH_HEAD')).text).toBe(
        'second\nfirst\n',
      );
      expect(processes.table.size).toBe(0);
    },
  );

  test(
    'a clone and a fetch over HTTPS, through the remote helper',
    { timeout: 60_000 },
    async () => {
      // The helper's server: git upload-pack for /work/repo (as a proxy's
      // smart HTTP would answer), its requests and answers counted.
      const asked: string[] = [];
      const fake = (async (url: string, init?: RequestInit) => {
        asked.push(`${init?.method ?? 'GET'} ${url}`);
        const body = init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array(0);
        return new Response(await serve('/work/repo', body, url.includes('/info/refs')));
      }) as typeof fetch;
      const helper = remoteHelper(
        (url) =>
          url.hostname === 'github.com' ? `http://proxy/git/github.com${url.pathname}` : null,
        fake,
      );
      const { git, root, processes, serve } = await repository((program, args) =>
        program === 'git' && args[0] === 'remote-https' ? helper : null,
      );
      const cloned = await git('/work', 'clone', '-q', 'https://github.com/a/repo', 'copy');
      expect(cloned.text).toBe('');
      expect(cloned.status).toBe(0);
      expect((await git('/work/copy', 'log', '--format=%s')).text).toBe('first\n');
      expect(asked[0]).toBe(
        'GET http://proxy/git/github.com/a/repo/info/refs?service=git-upload-pack',
      );
      expect(
        asked
          .slice(1)
          .every((line) => line === 'POST http://proxy/git/github.com/a/repo/git-upload-pack'),
      ).toBe(true);
      root.put('work/repo/b.txt', new File(encode('b\n')));
      await git('/work/repo', 'add', 'b.txt');
      await git('/work/repo', 'commit', '-qm', 'second');
      const fetched = await git('/work/copy', 'pull', '-q', '--ff-only');
      expect(fetched.text).toBe('');
      expect((await git('/work/copy', 'log', '--format=%s')).text).toBe('second\nfirst\n');
      expect((await git('/work/copy', 'ls-remote', 'origin')).text).toMatch(/refs\/heads\/main/);
      expect((await git('/work/copy', 'push', 'origin', 'main')).text).toContain('no push');
      expect(processes.table.size).toBe(0);
    },
  );
});

// GNU sed (sed/build.py), when it is built: a program built for WASI over
// the shared C layer (wasi-compat/), its `e` command through popen and sh.
const SED = new URL('../../../target/sed/sed.wasm', import.meta.url).pathname;
describe.skipIf(!existsSync(SED))('sed.wasm as a process', () => {
  const module = existsSync(SED) ? new WebAssembly.Module(readFileSync(SED)) : null;
  const root = new Dir();
  root.put('dev/null', devnull());
  root.mkdirs('tmp');
  const fetch = () => {
    throw new Error('no fetch');
  };
  // sh -c LINE as a simple command's words; echo as a program.
  const sh: Program = async (_child, { args, cwd, env, stdio }) => {
    const [program, ...rest] = words(args[1] ?? '');
    const status = await processes.run({
      program,
      args: rest,
      cwd,
      env,
      stdio: stdio.map((entry) => share(entry)) as typeof stdio,
    });
    return status ?? 127;
  };
  const echo: Program = async (_child, { args, stdio }) => {
    stdio[1].pipe!.write(encode(`${args.join(' ')}\n`), false);
    return 0;
  };
  const processes: Processes = new Processes((program) => {
    const name = program.split('/').pop()!;
    if (name === 'sh') return sh;
    if (name === 'echo') return echo;
    return name === 'sed' ? wasmProgram(processes, module!, { root, fetch, shared: null }) : null;
  });
  const sed = async (input: string, ...args: string[]) => {
    const out = capture();
    const status = await processes.run({
      program: 'sed',
      args,
      cwd: '/work',
      env: {},
      stdio: [inputPipe(encode(input)), out.entry, out.entry],
    });
    return { status, text: out.text() };
  };
  root.mkdirs('work');
  const read = (name: string) =>
    decode((root.mkdirs('work').entries.get(name) as File | undefined)?.bytes ?? encode('-'));

  test('substitutes, with GNU regex and -E, -n and -z', async () => {
    expect(await sed('hello world\n', 's/o/0/g')).toEqual({ status: 0, text: 'hell0 w0rld\n' });
    expect((await sed('a1b22\n', '-E', 's/([0-9])+/<\\1>/g')).text).toBe('a<1>b<2>\n');
    expect((await sed('aa bb\n', 's/\\(a\\)\\1/x/')).text).toBe('x bb\n');
    expect((await sed('1\n2\n3\n', '-n', '2p')).text).toBe('2\n');
    expect((await sed('a\0b\0', '-z', 's/^/>/')).text).toBe('>a\0>b\0');
    expect((await sed('', 's/(/')).status).toBe(1);
  });

  test('-i in place, without a suffix and with one', async () => {
    root.put('work/f.txt', new File(encode('one\ntwo\n')));
    expect((await sed('', '-i', 's/one/1/', 'f.txt')).status).toBe(0);
    expect(read('f.txt')).toBe('1\ntwo\n');
    expect((await sed('', '-i.bak', '2d', 'f.txt')).status).toBe(0);
    expect(read('f.txt')).toBe('1\n');
    expect(read('f.txt.bak')).toBe('1\ntwo\n');
  });

  test('e runs a command through sh, and s///e', async () => {
    expect((await sed('x\n', 'e echo before')).text).toBe('before\nx\n');
    expect((await sed('echo hi\n', 'e')).text).toBe('hi\n');
    expect((await sed('x\n', 's/x/echo made/e')).text).toBe('made\n');
    expect(processes.table.size).toBe(0);
  });
});
