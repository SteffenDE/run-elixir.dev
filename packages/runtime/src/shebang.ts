// A script's #! line, as execve reads it: the shell's commands
// (worker/index.ts find) and the nodes' ports (beam/run.ts spawn) run a
// file that starts with one by its interpreter, with the script's path
// and arguments after the line's own argument. `#!/usr/bin/env NAME`
// finds NAME on PATH, as env would. A package's scripts (the elixir
// package's bin/elixir, bin/iex, bin/mix) run this way: through the shell
// (#!/bin/sh), or directly by another program (#!/usr/bin/env elixir,
// #!/usr/bin/env escript).

// Interpreters of interpreters (bin/mix's elixir is a script for sh), at
// most this deep: Linux's limit.
const DEPTH = 4;

const LINE = /^#![ \t]*(\S+)(?:[ \t]+([^\n]*?))?[ \t]*\r?(?:\n|$)/;

// The #! line of `bytes`: its interpreter and argument, or null.
export function shebang(bytes: Uint8Array | null): { interpreter: string; arg?: string } | null {
  if (!bytes || bytes[0] !== 0x23 || bytes[1] !== 0x21) return null;
  const line = new TextDecoder().decode(bytes.subarray(0, 256)).match(LINE);
  return line ? { interpreter: line[1], ...(line[2] ? { arg: line[2] } : {}) } : null;
}

// Where `name` is on PATH: the first file there that is more than a
// stand-in (prepare's /usr/bin stand-ins are empty), or null.
export function which(
  name: string,
  path: string | undefined,
  read: (path: string) => Uint8Array | null,
): string | null {
  for (const dir of (path ?? '').split(':').filter(Boolean)) {
    const candidate = `${dir.replace(/\/$/, '')}/${name}`;
    if ((read(candidate)?.length ?? 0) > 2) return candidate;
  }
  return null;
}

// What runs the script at `path` with `args`: the first program in its
// chain of #! lines that is no script (/bin/sh, escript, node: a name the
// caller knows), and its arguments. Null when `path` is no script, or its
// chain is too deep (execve's ELOOP).
export function interpret(
  path: string,
  args: string[],
  read: (path: string) => Uint8Array | null,
  env: Record<string, string | undefined>,
): { program: string; args: string[] } | null {
  let program = path;
  let argv = args;
  for (let depth = 0; ; depth++) {
    // A name, not a path: the caller's program of that name.
    const line = depth && !program.includes('/') ? null : shebang(read(program));
    if (!line) return depth ? { program, args: argv } : null;
    if (depth === DEPTH) return null;
    argv = [program, ...argv];
    if (line.interpreter.split('/').pop() === 'env' && line.arg) {
      // env NAME: NAME as PATH has it (a script again, or a stand-in's
      // name: the caller's program).
      const name = line.arg.replace(/^-S[ \t]+/, '').split(/[ \t]+/);
      program = which(name[0], env.PATH, read) ?? name[0];
      argv = [...name.slice(1), ...argv];
    } else {
      program = line.interpreter;
      if (line.arg) argv = [line.arg, ...argv];
    }
  }
}
