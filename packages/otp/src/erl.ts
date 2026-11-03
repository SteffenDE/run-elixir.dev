#!/usr/bin/env node
// An otp package's erl command (erl.js): erl on this OTP in this
// terminal, or over a pipe.
//
//   npx @elixir-playground/otp-29.1.2 -noshell -eval 'io:format("hello~n"), halt().'
//
// The node's tree is its own: /work is empty, and what the node writes
// stays in memory. MOUNT=VFSDIR:HOSTDIR (comma-separated) puts host
// directories in it, read when first opened.
import { envMounts, processTerminal } from '@elixir-playground/runtime/harness';
import { erl } from './node.js';

const terminal = processTerminal();
const node = await erl(process.argv.slice(2), { mounts: envMounts(), ...terminal.options });
process.exit(await terminal.attach(node));
