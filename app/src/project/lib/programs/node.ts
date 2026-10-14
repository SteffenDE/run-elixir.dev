// Programs that are Rust-OTP itself, each run as a node of its own over the
// project's files, as the shell runs its commands: `sh -c 'mix deps.get'`
// (open_port's {spawn, Command}, System.shell; phx.new runs Mix that way)
// and rebar3, the escript Mix builds rebar3 dependencies with.
import type { Context, Process } from './tailwind';

// Start a node for `command` (['mix', 'deps.get']): its output is the
// process's, and its exit status the process's.
export type StartNode = (
  command: string[],
  context: Context,
  output: (bytes: Uint8Array) => void,
  exit: (code: number) => void,
) => { stop(): void };

// The commands a shell line can run: Rust-OTP's.
const NODE_COMMANDS = new Set(['mix', 'elixir', 'iex', 'erl', 'escript']);

// Words, with '' and "" quoting (as the playground's shell splits them).
export function words(line: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      word ??= '';
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? '') + c;
  }
  if (word !== null) out.push(word);
  return out;
}

// Run `command` as a node; `done` gets its exit status.
function run(
  start: StartNode,
  process: Process,
  command: string[],
  context: Context,
  done: (code: number) => void = (code) => process.exit(code),
): void {
  const node = start(
    command,
    context,
    (bytes) => process.write(bytes),
    (code) => {
      node.stop();
      done(code);
    },
  );
  process.onkill = () => node.stop();
}

// A command line's commands, as far as the playground runs them: words
// joined by &&, without the ( ) and </dev/null that System.shell and
// os:cmd wrap them in.
export function commands(line: string): string[][] {
  let text = line.trim();
  for (;;) {
    const unwrapped = text
      .replace(/\s*<\s*\/dev\/null\s*$/, '')
      .replace(/^\(([\s\S]*)\)$/, '$1')
      .trim();
    if (unwrapped === text) break;
    text = unwrapped;
  }
  const out: string[][] = [[]];
  for (const word of words(text)) {
    if (word === '&&') out.push([]);
    else out[out.length - 1].push(word);
  }
  return out;
}

const join = (cwd: string, path: string) => {
  const out: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return '/' + out.join('/');
};

// sh -c LINE: its Rust-OTP commands and cd, one after another while they
// succeed; anything else is not found (127), as a shell without the
// program says.
export const shProgram =
  (start: StartNode) =>
  (process: Process, context: Context): void => {
    const [flag, line = ''] = context.args;
    const queue = flag === '-c' ? commands(line) : [[]];
    let cwd = context.cwd;
    const next = (code: number): void => {
      const command = queue.shift();
      if (code !== 0 || !command) return process.exit(code);
      if (!command.length) return next(0);
      if (command[0] === 'cd') {
        cwd = join(cwd, command[1] ?? context.env.HOME ?? '/work');
        return next(0);
      }
      if (!NODE_COMMANDS.has(command[0])) {
        process.write(`sh: ${command[0]}: not found in the playground\n`);
        return process.exit(127);
      }
      run(start, process, command, { ...context, cwd }, next);
    };
    next(0);
  };

// A Rust-OTP command run as a program (System.cmd("mix", ...) finds
// /rotp/bin/mix on PATH; igniter.new runs `mix deps.get` that way).
export const commandProgram =
  (start: StartNode, name: string) =>
  (process: Process, context: Context): void =>
    run(start, process, [name, ...context.args], context);

// rebar3 ARGS: escript /rotp/mix/rebar3 ARGS.
export const REBAR3 = '/rotp/mix/rebar3';
export const rebar3Program =
  (start: StartNode) =>
  (process: Process, context: Context): void =>
    run(start, process, ['escript', REBAR3, ...context.args], context);
