// Programs that are OTP's and Elixir's commands, each run as a node of its own over the
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

// Run `command` as a node; its exit status is the process's.
function run(start: StartNode, process: Process, command: string[], context: Context): void {
  const node = start(
    command,
    context,
    (bytes) => process.write(bytes),
    (code) => {
      node.stop();
      process.exit(code);
    },
  );
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
