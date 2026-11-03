#!/usr/bin/env node
// The elixir package's command (cli.js): Elixir's commands under Node, on
// an installed otp package, and prepare, a build's layer for a site that
// the vite package does not lay out (docs/api.md, "Elixir").
//
//   npx @elixir-playground/elixir [--version BUILD] [--otp DIR] [--archive NAME@VERSION…] iex|elixir|mix|elixirc [ARGS…]
//
//   npx @elixir-playground/elixir prepare [BUILD] --otp DIR --into DIR [--archive NAME@VERSION…] [--untested] [--force]
//
// BUILD is builds.hex.pm's name (1.20.4-otp-29; default: the package's
// default); --otp an installed otp package; --into the elixir package's
// directory as the site serves it (/npm/@elixir-playground/elixir@VERSION/);
// --archive a Mix archive from Hex besides Hex (phx_new@1.8.16), each.
// Without BUILD, the builds the package.json here names
// (`elixirPlayground.elixir`: { builds, archives, untested }, as the vite
// package's plugin takes them), else the default.
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { BUILDS, DEFAULT } from './builds.js';
import { prepare } from './prepare.js';
import { COMMANDS, run } from './run.js';

const USAGE = `usage: elixir-playground-elixir [--version BUILD] [--otp DIR] [--archive NAME@VERSION…] iex|elixir|mix|elixirc [ARGS…]
       elixir-playground-elixir prepare [BUILD] --otp DIR --into DIR [--archive NAME@VERSION…] [--untested] [--force]
       elixir-playground-elixir builds

BUILD: an Elixir build as builds.hex.pm names it; by default those the
  package.json here names (elixirPlayground.elixir.builds), else ${DEFAULT}.
--otp: an installed otp package (node_modules/@elixir-playground/otp-29.1.2).
--into: the elixir package's directory as the site serves it.
--archive: a Mix archive from Hex besides Hex itself (phx_new@1.8.16), each.`;

// NAME@VERSION, each: { NAME: VERSION }.
const archivesOf = (given: string[]) =>
  Object.fromEntries(
    given.map((each) => {
      const at = each.lastIndexOf('@');
      return at > 0 ? [each.slice(0, at), each.slice(at + 1)] : [each, ''];
    }),
  );

// One of Elixir's commands: the options before it are ours, what follows
// it the command's. It runs in this terminal; MOUNT=VFSDIR:HOSTDIR puts
// host directories in the node's tree (/work is empty, and what the node
// writes stays in memory).
const argv = process.argv.slice(2);
const at = argv.findIndex((arg) => arg in COMMANDS);
if (at >= 0 && !['prepare', 'builds'].includes(argv[0])) {
  const { values: ours } = parseArgs({
    args: argv.slice(0, at),
    options: {
      version: { type: 'string' },
      otp: { type: 'string' },
      archive: { type: 'string', multiple: true },
    },
  });
  try {
    process.exit(
      await run({
        build: ours.version,
        command: argv[at],
        args: argv.slice(at + 1),
        otp: ours.otp,
        archives: ours.archive ? archivesOf(ours.archive) : undefined,
      }),
    );
  } catch (error) {
    console.error(`elixir-playground-elixir: ${(error as Error).message}`);
    process.exit(1);
  }
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    otp: { type: 'string' },
    into: { type: 'string' },
    archive: { type: 'string', multiple: true },
    cache: { type: 'string' },
    untested: { type: 'boolean' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
const [command, build, ...rest] = positionals;
if (values.help || rest.length) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}
if (command === 'builds') {
  for (const each of Object.keys(BUILDS))
    console.log(each === DEFAULT ? `${each} (default)` : each);
} else if (command === 'prepare' && values.otp && values.into) {
  // The site's own: its package.json's elixirPlayground.elixir.
  const site: { builds?: string[]; archives?: Record<string, string>; untested?: boolean } =
    (existsSync('package.json') &&
      JSON.parse(readFileSync('package.json', 'utf8')).elixirPlayground?.elixir) ||
    {};
  const archives = values.archive ? archivesOf(values.archive) : site.archives;
  try {
    for (const each of build ? [build] : (site.builds ?? [DEFAULT]))
      await prepare({
        build: each,
        otp: values.otp,
        into: values.into,
        archives,
        cache: values.cache,
        untested: values.untested ?? site.untested,
        force: values.force,
      });
  } catch (error) {
    console.error(`elixir-playground-elixir: ${(error as Error).message}`);
    process.exit(1);
  }
} else {
  console.error(USAGE);
  process.exit(2);
}
