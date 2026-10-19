// node: Node.js scripts on the page's own JavaScript engine, each process
// in a worker of its own (runtime/nodejs, nodejs.js) with a channel to the
// shared files, as a node has. Its output is the process's, and its exit
// status; closing the port (Ctrl+C) stops the worker.
import type { Files } from '@/runtime/host/files';
import { worker } from '@/runtime/host/worker';
import type { Context, Process } from './tailwind';

export const nodeProgram =
  (base: string, files: () => Files | null) =>
  (process: Process, context: Context): void => {
    const shared = files();
    if (!shared) {
      process.write('node: no files\n');
      return process.exit(1);
    }
    const channel = shared.connect();
    const thread = worker('nodejs.js', base);
    let done = false;
    const stop = (code: number) => {
      if (done) return;
      done = true;
      thread.terminate();
      shared.disconnect(channel);
      process.exit(code);
    };
    thread.onmessage = ({ data }) => {
      if (data.kind === 'out') process.write(data.bytes);
      else if (data.kind === 'exit') stop(data.code);
    };
    thread.onerror = (event) => {
      event.preventDefault();
      process.write(`node: ${event.message || 'the worker failed to start'}\n`);
      stop(1);
    };
    process.onkill = () => stop(130);
    process.onowner = () => stop(130);
    thread.postMessage({
      kind: 'start',
      args: context.args,
      cwd: context.cwd,
      env: context.env,
      doorbell: channel.doorbell,
      channel: channel.channel,
    });
  };
