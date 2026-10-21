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
async function install(fs: Files, dir: string, files: GraphFile[]): Promise<void> {
  if (await fs.stat(`${dir}/cli.js`)) return;
  const dirs = new Set<string>([dir]);
  for (const { name } of files)
    for (let at = name.indexOf('/'); at >= 0; at = name.indexOf('/', at + 1))
      dirs.add(`${dir}/${name.slice(0, at)}`);
  for (const path of [...dirs].sort()) await fs.mkdir(path);
  const entry = files.find((file) => file.name === 'cli.js');
  await Promise.all(
    files
      .filter((file) => file !== entry)
      .map((file) => fs.write(`${dir}/${file.name}`, file.data)),
  );
  if (entry) await fs.write(`${dir}/cli.js`, entry.data);
}

type Program = (process: Process, context: Context) => void | Promise<void>;

// The claude frame's files for this version, its progress written as it
// goes; over a port to it (`connect`: the IDE's page's).
async function claudeFiles(
  connect: () => Promise<MessagePort>,
  say: (text: string) => void,
): Promise<{ version: string; files: GraphFile[] }> {
  const rpc = new Rpc(await connect());
  rpc.on<string>('progress', say);
  try {
    return await rpc.call<{ version: string; files: GraphFile[] }>('files');
  } finally {
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
    let dir: string;
    try {
      const { version, files } = await claudeFiles(connect, (text) => process.write(text));
      dir = `${DIR}/${version}`;
      await install(context.fs as unknown as Files, dir, files);
    } catch (error) {
      process.write(`claude: ${(error as Error).message}\n`);
      return process.exit(1);
    }
    return node(process, {
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
  };
