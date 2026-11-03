// Elixir's commands under Node (the elixir package's command: `npx
// @elixir-playground/elixir --version 1.20.5-otp-29 iex`): a build
// prepared into the user's cache, run on an installed otp package through
// the runtime's harness, in this terminal or over a pipe.
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { envMounts, processTerminal, start } from '@elixir-playground/runtime/harness';
import { BUILDS, DEFAULT, parseBuild } from './builds.js';
import { PLAYGROUND, described } from './elixir.js';
import { prepare } from './prepare.js';
import { COMMANDS, buildName, findOtp } from './commands.js';

export { COMMANDS } from './commands.js';

// Where builds are prepared for the command: the user's cache.
const cacheDirectory = () =>
  join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'elixir-playground', 'elixir');

export interface RunOptions {
  build?: string;
  command: string;
  args: string[];
  // An otp package's directory (default: an installed one of the build's
  // OTP major).
  otp?: string;
  archives?: Record<string, string>;
  log?: (line: string) => void;
}

// Runs the command; its exit status.
export async function run(options: RunOptions): Promise<number> {
  const log = options.log ?? ((line: string) => console.error(line));
  const build = buildName(options.build ?? DEFAULT);
  const { elixir, otp: major } = parseBuild(build);
  const command = COMMANDS[options.command];
  if (!command)
    throw new Error(`${options.command}: not one of ${Object.keys(COMMANDS).join(', ')}`);
  const here = dirname(fileURLToPath(import.meta.url));
  const otp = options.otp ?? findOtp(major, [process.cwd(), here])[0];
  if (!otp)
    throw new Error(
      `Elixir ${build} runs on OTP ${major}, and no @elixir-playground/otp-${major}.… is installed: ` +
        `npx -p @elixir-playground/otp-${major}.… -p @elixir-playground/elixir elixir-playground-elixir …, ` +
        'or --otp DIR',
    );
  // A build the package was not tested with runs too, checked against
  // builds.hex.pm's builds.txt.
  if (!BUILDS[build])
    log(`elixir: Elixir ${build} is not among the builds this package was tested with`);
  const cache = cacheDirectory();
  await prepare({
    build,
    otp,
    into: cache,
    archives: options.archives,
    cache: join(cache, 'downloads'),
    untested: true,
    log,
  });
  const descriptor = {
    name: '@elixir-playground/elixir',
    version: '0.0.0',
    base: pathToFileURL(`${cache}/`).href,
    files: {},
    playground: PLAYGROUND,
  };
  const root = `/opt/elixir/${elixir}`;
  const terminal = processTerminal();
  const node = await start({
    packages: [otp, ...described(descriptor, build, { archives: options.archives })],
    args: [
      '-noshell',
      '-elixir_root',
      `${root}/lib`,
      '-pa',
      `${root}/lib/elixir/ebin`,
      ...command(root),
      ...options.args,
    ],
    mounts: envMounts(),
    ...terminal.options,
  });
  return terminal.attach(node);
}
