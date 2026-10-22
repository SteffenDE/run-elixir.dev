// git's own tests (git's t/, test-lib.sh) against git.wasm, in Node: brush
// is sh, git.wasm git (and its dashed programs), test-tool.wasm git's test
// helper, coreutils.wasm coreutils' tools, GNU's sed, grep, diffutils, awk
// and find (sed.wasm, …: GNU), and the shell's utilities (env, xargs,
// chmod), each a process of the table (processes.ts) as the playground runs
// them; what the playground lacks (perl, getconf, gpg, …) is the host's own
// program. The files
// are the host's (hostfs.ts) at their own paths: the build's tree, where
// test-lib.sh makes its trash directories, and a scratch directory.
import { spawn as spawnHost } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { TOOLS } from '@/runtime/coreutils';
import {
  Processes,
  feed,
  inputPipe,
  wasmProgram,
  writeAll,
  type Program,
} from '@/runtime/processes';
import type { Descriptor } from '@/runtime/wasi/descriptors';
import { Dir, File, devnull } from '@/runtime/wasi/fs';
import { GIT_DASHED } from '@/runtime/git-remote';
import { UTILITIES } from '@/runtime/utilities';
import { brush } from '@/runtime/worker/brush';
import { hostFiles } from './hostfs';

const TARGET = new URL('../../../target/', import.meta.url).pathname;
export const BUILD = `${TARGET}git/src`;
const module = (path: string) => new WebAssembly.Module(readFileSync(`${TARGET}${path}`));

export interface Machine {
  // Runs `program` to its end: its status and what it wrote (both streams).
  run(
    program: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
  ): Promise<{
    status: number | null;
    output: string;
  }>;
  // The host's programs it ran, by name (what the playground lacks).
  hosted: Map<string, number>;
  // Ends everything it runs (a script past its time).
  kill(): void;
}

export function machine(scratch: string): Machine {
  const git = module('git/git.wasm');
  const testTool = module('git/test-tool.wasm');
  const coreutils = module('coreutils/coreutils.wasm');
  // GNU's tools (sed/build.py, grep/build.py, diffutils/build.py), by name.
  const GNU: Record<string, WebAssembly.Module> = {
    sed: module('sed/sed.wasm'),
    grep: module('grep/grep.wasm'),
    awk: module('gawk/gawk.wasm'),
    find: module('findutils/find.wasm'),
    ...Object.fromEntries(
      ['diff', 'cmp', 'diff3', 'sdiff'].map((name) => [name, module(`diffutils/${name}.wasm`)]),
    ),
  };
  const shell = module('brush/brush.wasm');
  const root = new Dir();
  root.put('dev/null', devnull());
  root.mkdirs('tmp');
  root.mkdirs('usr/share/git-core/templates');
  // What brush finds on PATH (as setup.ts has the playground's): coreutils'
  // tools, sh, and the host's programs (the resolver's last resort). Never
  // read: the resolver runs them by name.
  const host = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
  for (const name of new Set([...TOOLS, 'sh', 'bash', ...host('/usr/bin'), ...host('/bin')]))
    root.put(`usr/bin/${name}`, new File());
  root.put('bin/sh', new File());
  const shared = { prefixes: [BUILD, scratch], call: hostFiles() };
  // Their parents, which git walks up through (real paths, discovery).
  for (const prefix of shared.prefixes) {
    const parent = prefix.slice(1, prefix.lastIndexOf('/'));
    if (parent) root.mkdirs(parent);
  }
  const fetch = () => {
    throw new Error('no fetch');
  };
  const hosted = new Map<string, number>();

  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  // sh -c LINE [NAME ARGS…] or sh FILE [ARGS…], from `cwd` (brush starts in
  // /), as the worker's shArgs has them; options before them (-e, -x) are
  // set first.
  const sh: Program = async (child, { args: given, cwd, env, stdio }) => {
    const args = [...given];
    const options: string[] = [];
    while (args[0]?.startsWith('-') && args[0] !== '-c' && args[0] !== '--')
      options.push(args.shift()!);
    if (args[0] === '--') args.shift();
    let line: string;
    let rest: string[];
    if (args[0] === '-c') [, line = '', ...rest] = args;
    else {
      const [file, ...more] = args;
      line = `. ${quote(file)}`;
      rest = [file, ...more];
    }
    const set = options.length ? `set ${options.join(' ')}\n` : '';
    return brush({
      module: shell,
      args: ['--norc', '--noprofile', '-c', `cd ${quote(cwd)} || exit 1\n${set}${line}`, ...rest],
      env: { ...env, PWD: cwd },
      root,
      fetch,
      shared,
      out: () => {},
      terminal: { raw: () => {}, size: () => [80, 24], read: async () => null },
      processes,
      standard: stdio,
      stdio,
      self: child,
    });
  };

  // A host's program, its streams the process's.
  const hostProgram =
    (name: string): Program =>
    (child, { args, cwd, env, stdio: [input, output, errors] }) => {
      hosted.set(name, (hosted.get(name) ?? 0) + 1);
      return new Promise((resolve) => {
        const run = spawnHost(name, args, { cwd, env, stdio: 'pipe' });
        let done = false;
        void feed(
          input,
          (bytes) => {
            if (bytes) run.stdin.write(bytes);
            else run.stdin.end();
          },
          async () => {},
          () => done,
          shared,
        );
        run.stdin.on('error', () => {});
        let writing = Promise.resolve(true);
        const pass = (entry: Descriptor) => (chunk: Buffer) => {
          writing = writing.then(() => writeAll(entry, new Uint8Array(chunk), child, shared));
        };
        run.stdout.on('data', pass(output));
        run.stderr.on('data', pass(errors));
        run.on('error', () => {
          done = true;
          resolve(127);
        });
        run.on('close', (code, signal) => {
          done = true;
          void writing.then(() => resolve(code ?? (signal ? 128 + 9 : 1)));
        });
        void child.woken.then(() => run.kill());
      });
    };

  // A path's #! line (a relative one's from `cwd`), as the worker reads it.
  const shebang = (program: string, cwd: string) => {
    if (!program.includes('/')) return null;
    const path = program.startsWith('/') ? program : `${cwd}/${program}`;
    try {
      const head = Buffer.alloc(64);
      const fd = openSync(path, 'r');
      const count = readSync(fd, head, 0, 64, 0);
      closeSync(fd);
      return { path, line: head.subarray(0, count).toString('latin1').split('\n')[0] };
    } catch {
      return null;
    }
  };

  const processes: Processes = new Processes((program, args, cwd, env) => {
    const name = program.split('/').pop()!;
    if (name === 'sh' || name === 'bash') return sh;
    // A script on PATH, as execvp finds it (git-remote-testgit; the build's
    // git-submodule, GIT_EXEC_PATH being on git's PATH).
    if (!program.includes('/'))
      for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
        const found = shebang(`${dir}/${program}`, cwd);
        if (found && /^#!.*\b(sh|bash)\b/.test(found.line))
          return (child, spawn) => sh(child, { ...spawn, args: [found.path, ...args] });
      }
    // A script for sh (#!/bin/sh), as the worker's resolver has it; git's
    // own (git-submodule) from its exec path, the build's.
    const script = shebang(
      name.startsWith('git-') && !program.includes('/') ? `${BUILD}/${name}` : program,
      cwd,
    );
    if (script && /^#!.*\b(sh|bash)\b/.test(script.line))
      return (child, spawn) => sh(child, { ...spawn, args: [script.path, ...args] });
    if (name === 'git' || GIT_DASHED.has(name))
      return wasmProgram(processes, git, { root, fetch, shared, argv0: name });
    // Another git-NAME is none: an alias's, then.
    if (name.startsWith('git-')) return null;
    if (name === 'test-tool')
      return wasmProgram(processes, testTool, { root, fetch, shared, argv0: name });
    if (TOOLS.has(name))
      return wasmProgram(processes, coreutils, { root, fetch, shared, argv0: name });
    if (name in GNU) return wasmProgram(processes, GNU[name], { root, fetch, shared, argv0: name });
    if (name in UTILITIES) return UTILITIES[name](processes, existsSync);
    return hostProgram(name);
  });

  return {
    hosted,
    kill: () => processes.interrupt(9),
    async run(program, args, cwd, env) {
      let output = '';
      const decoder = new TextDecoder();
      const out: Descriptor = {
        stream: true,
        sink: (bytes) => void (output += decoder.decode(bytes, { stream: true })),
      };
      const status = await processes.run({
        program,
        args,
        cwd,
        env,
        stdio: [inputPipe(new Uint8Array(0)), out, { ...out }],
      });
      return { status, output };
    },
  };
}

// A test script's TAP: each test's number, whether it passed, and what it
// is; and test-lib's own line at the end.
export interface Result {
  script: string;
  status: number | null;
  passed: number[];
  failed: { number: number; title: string }[];
  // Known breakages (test_expect_failure), as git has them.
  known: number;
  summary: string;
  seconds: number;
  // Ended past its limit (suite.test.ts).
  timedOut?: boolean;
}

export function results(
  script: string,
  status: number | null,
  output: string,
  seconds: number,
): Result {
  const passed: number[] = [];
  const failed: Result['failed'] = [];
  let known = 0;
  for (const line of output.split('\n')) {
    const ok = /^ok (\d+) - /.exec(line);
    const notOk = /^not ok (\d+) - (.*)$/.exec(line);
    if (ok) passed.push(Number(ok[1]));
    else if (notOk && /# TODO known breakage/.test(notOk[2])) known++;
    else if (notOk) failed.push({ number: Number(notOk[1]), title: notOk[2] });
  }
  const summary = output
    .split('\n')
    .filter((line) => /^# (passed|failed|still have|fixed)/.test(line))
    .join('; ');
  return { script, status, passed, failed, known, summary, seconds };
}
