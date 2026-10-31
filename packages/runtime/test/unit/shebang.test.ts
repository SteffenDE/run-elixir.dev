// A script's #! line (shebang.ts): Elixir's own scripts run as execve
// would run them, through sh or another program by name.
import { expect, it } from 'vitest';
import { interpret, shebang, which } from '../../src/shebang';

const files: Record<string, string> = {
  '/usr/bin/elixir': '#!/bin/sh\nexec erl "$@"\n',
  '/usr/bin/mix': '#!/usr/bin/env elixir\nMix.CLI.main()\n',
  '/usr/bin/escript': '',
  '/opt/elixir/mix/rebar3': '#!/usr/bin/env escript\n%%! +sbtu +A1\n',
  '/work/a.js': '#!/usr/bin/env -S node --no-warnings\n',
  '/work/b': '#!/usr/local/bin/python3 -u\r\n',
  '/work/loop': '#!/work/loop\n',
  '/work/plain': 'echo hi\n',
};
const read = (path: string) => (path in files ? new TextEncoder().encode(files[path]) : null);
const env = { PATH: '/usr/bin:/home/user/.mix/escripts' };

it('reads a #! line', () => {
  expect(shebang(read('/usr/bin/elixir'))).toEqual({ interpreter: '/bin/sh' });
  expect(shebang(read('/work/b'))).toEqual({ interpreter: '/usr/local/bin/python3', arg: '-u' });
  expect(shebang(read('/work/plain'))).toBeNull();
  expect(shebang(null)).toBeNull();
});

it('finds a name on PATH, past the empty stand-ins', () => {
  expect(which('mix', env.PATH, read)).toBe('/usr/bin/mix');
  expect(which('escript', env.PATH, read)).toBeNull();
});

it('runs a script by its interpreter, through a chain of scripts', () => {
  expect(interpret('/usr/bin/elixir', ['-v'], read, env)).toEqual({
    program: '/bin/sh',
    args: ['/usr/bin/elixir', '-v'],
  });
  // mix: elixir runs it, and sh runs elixir.
  expect(interpret('/usr/bin/mix', ['deps.get'], read, env)).toEqual({
    program: '/bin/sh',
    args: ['/usr/bin/elixir', '/usr/bin/mix', 'deps.get'],
  });
  // A name that is no script: the caller's program (escript, node).
  expect(interpret('/opt/elixir/mix/rebar3', ['compile'], read, env)).toEqual({
    program: 'escript',
    args: ['/opt/elixir/mix/rebar3', 'compile'],
  });
  expect(interpret('/work/a.js', ['x'], read, env)).toEqual({
    program: 'node',
    args: ['--no-warnings', '/work/a.js', 'x'],
  });
  expect(interpret('/work/b', [], read, env)).toEqual({
    program: '/usr/local/bin/python3',
    args: ['-u', '/work/b'],
  });
});

it('runs no script for a file without a #! line, or one that never ends', () => {
  expect(interpret('/work/plain', [], read, env)).toBeNull();
  expect(interpret('/usr/bin/escript', [], read, env)).toBeNull();
  expect(interpret('/work/loop', [], read, env)).toBeNull();
});
