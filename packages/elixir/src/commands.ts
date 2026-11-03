// The elixir package's command's names and lookups (run.ts), apart from
// the runtime's harness, which run.ts starts.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Elixir's commands: how each starts erl, after the root's paths (its
// scripts' own: bin/elixir, bin/iex, bin/mix, bin/elixirc). IEx is the
// node's user (its shell); the others run Elixir's CLI.
const CLI = ['-s', 'elixir', 'start_cli', '-extra'];
export const COMMANDS: Record<string, (root: string) => string[]> = {
  elixir: () => CLI,
  iex: () => ['-user', 'elixir', '-extra', '--no-halt', '+iex'],
  elixirc: () => [...CLI, '+elixirc'],
  mix: (root) => [...CLI, `${root}/bin/mix`],
};

// A build's name as builds.hex.pm has it: 1.20.5-otp-29 (or 1.20.5-otp29).
export const buildName = (build: string) => build.replace(/-otp(\d+)$/, '-otp-$1');

// The installed otp packages of OTP `major`, newest first: below
// node_modules here and above, and above this package (npx's install).
export function findOtp(major: number, from: string[]): string[] {
  const found = new Map<string, string>();
  for (const top of from)
    for (let at = resolve(top); ; at = dirname(at)) {
      const scope = join(at, 'node_modules', '@elixir-playground');
      if (existsSync(scope))
        for (const name of readdirSync(scope).filter((each) => each.startsWith(`otp-${major}.`))) {
          const directory = join(scope, name);
          if (!found.has(name) && existsSync(join(directory, 'package.json')))
            found.set(name, directory);
        }
      if (dirname(at) === at) break;
    }
  const version = (name: string) => name.slice('otp-'.length).split('.').map(Number);
  return [...found]
    .sort(([a], [b]) => {
      const [x, y] = [version(a), version(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      return 0;
    })
    .map(([, directory]) => directory);
}
