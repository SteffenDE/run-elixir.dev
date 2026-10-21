// claude: Claude Code on the page, its JavaScript on the playground's Node
// with a stand-in for Bun's own APIs (nodejs/claude/bun.ts). The site
// hosts none of it: the claude frame (worker.ts, on claude.USERCONTENT)
// makes its files once a version for every project (build.ts), and hands
// them over a port the IDE's page gives (frame.ts). Each run puts them in
// /opt/claude-code/VERSION (files.js's memory, outside /work, so a project
// does not keep them) and runs cli.js there with node.
import type { Files } from '@/runtime/host/files';
import { Rpc } from '@/shared/lib/rpc';
import type { GraphFile } from './bungraph';
import { DIR } from './build';
import type { Context, Process } from '../tailwind';

// The files in `dir`, unless they are there already (cli.js last, so its
// being there means they all are).
async function install(
  fs: Files,
  dir: string,
  files: GraphFile[],
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (await fs.stat(`${dir}/cli.js`)) return;
  signal.throwIfAborted();
  const dirs = new Set<string>([dir]);
  for (const { name } of files)
    for (let at = name.indexOf('/'); at >= 0; at = name.indexOf('/', at + 1))
      dirs.add(`${dir}/${name.slice(0, at)}`);
  for (const path of [...dirs].sort()) {
    signal.throwIfAborted();
    await fs.mkdir(path);
  }
  signal.throwIfAborted();
  const entry = files.find((file) => file.name === 'cli.js');
  await Promise.all(
    files
      .filter((file) => file !== entry)
      .map((file) => fs.write(`${dir}/${file.name}`, file.data)),
  );
  signal.throwIfAborted();
  if (entry) await fs.write(`${dir}/cli.js`, entry.data);
}

type Program = (process: Process, context: Context) => void | Promise<void>;

// The claude frame's files for this version, its progress written as it
// goes; over a port to it (`connect`: the IDE's page's).
async function claudeFiles(
  connect: () => Promise<MessagePort>,
  say: (text: string) => void,
  signal: AbortSignal,
): Promise<{ version: string; files: GraphFile[] }> {
  const port = await connect();
  if (signal.aborted) {
    port.close();
    signal.throwIfAborted();
  }
  const rpc = new Rpc(port);
  const cancel = () => rpc.close();
  signal.addEventListener('abort', cancel, { once: true });
  rpc.on<string>('progress', say);
  try {
    return await rpc.call<{ version: string; files: GraphFile[] }>('files');
  } finally {
    signal.removeEventListener('abort', cancel);
    rpc.close();
  }
}

export const claudeProgram =
  (programs: () => Record<string, Program>, connect: () => Promise<MessagePort>) =>
  async (process: Process, context: Context): Promise<void> => {
    const node = programs().node;
    if (!node) {
      process.write('claude: node is not in this playground\n');
      return process.exit(1);
    }
    // Input (including EOF) can arrive while the shared cache prepares.
    // Keep it until node installs its handlers; a stopped command never
    // starts a runtime after its preparation eventually finishes.
    const controller = new AbortController();
    const { signal } = controller;
    const pending: (Uint8Array | null)[] = [];
    process.oninput = (bytes) => pending.push(bytes?.slice() ?? null);
    const cancel = () => {
      controller.abort();
      pending.length = 0;
      process.exit(130);
    };
    process.onkill = cancel;
    process.onowner = cancel;
    let dir: string;
    try {
      const { version, files } = await claudeFiles(connect, (text) => process.write(text), signal);
      dir = `${DIR}/${version}`;
      await install(context.fs as unknown as Files, dir, files, signal);
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) return;
      process.write(`claude: ${(error as Error).message}\n`);
      return process.exit(1);
    }
    const running = node(process, {
      ...context,
      // Its Glob and Grep tools (ripgrep's), named so it keeps them: else
      // a build such as this one drops them for the find and grep its own
      // executable embeds (bfs, ugrep), which a shell here cannot reach.
      // As one word, so no argument after it is taken for another tool.
      args: [`${dir}/cli.js`, '--allowedTools=Glob,Grep', ...context.args],
      env: {
        // Anthropic's API answers a browser, its other endpoints
        // (settings, telemetry) do not: without the tailnet, Claude Code
        // would retry them at each start.
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        SHELL: '/usr/bin/bash',
        ...context.env,
      },
      bun: true,
    });
    for (const bytes of pending.splice(0)) process.oninput?.(bytes);
    return running;
  };
