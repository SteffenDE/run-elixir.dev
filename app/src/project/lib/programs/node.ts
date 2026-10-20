// Programs that are OTP's and Elixir's commands, each run as a node of its own over the
// project's files, as the shell runs its commands: `sh -c 'mix deps.get'`
// (open_port's {spawn, Command}, System.shell; phx.new runs Mix that way)
// and rebar3, the escript Mix builds rebar3 dependencies with.
import { CHUNK, FRAME } from '@/runtime/host/node';
import type { Context, Process } from './tailwind';

// Start a node for `command` (['mix', 'deps.get']): its output is the
// process's, and its exit status the process's; terminal(raw, signals):
// it set the terminal's input mode. It takes the process's input (as
// frames) and the terminal's size.
export type StartNode = (
  command: string[],
  context: Context,
  output: (bytes: Uint8Array) => void,
  exit: (code: number) => void,
  terminal?: (raw: boolean, signals: boolean) => void,
) => {
  stop(): void;
  frame?(kind: number, id: number, payload?: Uint8Array): void;
  resize?(columns: number, rows: number): void;
};

// INPUT frames' ids for a process's input (worker/channel.ts INPUT): its
// bytes as they are, and their end.
const PIPE = 1;
const PIPE_END = 2;

// Run `command` as a node; its exit status is the process's. What the
// process reads is the node's input, byte for byte, and then its end; the
// terminal's mode the node sets is the process's to set.
function run(start: StartNode, process: Process, command: string[], context: Context): void {
  const node = start(
    command,
    context,
    (bytes) => process.write(bytes),
    (code) => {
      node.stop();
      process.exit(code);
    },
    (raw, signals) => process.raw?.(raw, signals),
  );
  process.oninput = (bytes) => {
    if (!bytes) return node.frame?.(FRAME.INPUT, PIPE_END);
    for (let at = 0; at < bytes.length; at += CHUNK)
      node.frame?.(FRAME.INPUT, PIPE, bytes.subarray(at, at + CHUNK));
  };
  process.onresize = (columns, rows) => node.resize?.(columns, rows);
  const [columns, rows] = process.size?.() ?? [80, 24];
  node.resize?.(columns, rows);
  // Its port closed: the node runs on, as an OS process outlives its
  // port (Livebook's runtime node is started from a process that then
  // ends), until it ends by itself or the node that started it stops.
  process.onkill = () => {};
  process.onowner = () => node.stop();
}

// sh -c LINE: a worker of its own whose brush runs the line as the
// terminal's runs it (worker/index.ts): pipes, redirections, variables,
// and node commands, page programs and coreutils' tools, a node command
// in that worker.
export const shProgram =
  (start: StartNode) =>
  (process: Process, context: Context): void =>
    run(start, process, ['sh', ...context.args], context);

// A node command run as a program (System.cmd("mix", ...) finds
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
