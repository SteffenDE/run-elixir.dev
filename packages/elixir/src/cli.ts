#!/usr/bin/env node
// The elixir package's command (cli.js): prepare a build's layer for a
// site that the vite package does not lay out (docs/api.md, "Elixir").
//
//   npx @elixir-playground/elixir prepare [BUILD] --otp DIR --into DIR [--untested] [--force]
//
// BUILD is builds.hex.pm's name (1.20.4-otp-29; default: the package's
// default); --otp an installed otp package; --into the elixir package's
// directory as the site serves it (/npm/@elixir-playground/elixir@VERSION/).
import { parseArgs } from 'node:util';
import { BUILDS, DEFAULT } from './builds.js';
import { prepare } from './prepare.js';

const USAGE = `usage: elixir-playground-elixir prepare [BUILD] --otp DIR --into DIR [--untested] [--force]
       elixir-playground-elixir builds

BUILD: an Elixir build as builds.hex.pm names it (default ${DEFAULT}).
--otp: an installed otp package (node_modules/@elixir-playground/otp-29.1.2).
--into: the elixir package's directory as the site serves it.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    otp: { type: 'string' },
    into: { type: 'string' },
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
  try {
    await prepare({
      build: build ?? DEFAULT,
      otp: values.otp,
      into: values.into,
      cache: values.cache,
      untested: values.untested,
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
