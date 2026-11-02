#!/usr/bin/env node
// An otp package's erl command (erl.js): erl on this OTP in this
// terminal, or over a pipe.
//
//   npx @elixir-playground/otp-29.1.2 -noshell -eval 'io:format("hello~n"), halt().'
//
// The node's tree is its own: /work is empty, and what the node writes
// stays in memory. MOUNT=VFSDIR:HOSTDIR (comma-separated) puts host
// directories in it, read when first opened.
import { erl } from './node.js';

const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
const mounts = Object.fromEntries(
  (process.env.MOUNT || '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split(':')),
);
let raw = false;
const node = await erl(process.argv.slice(2), {
  mounts,
  tty,
  size: tty ? [process.stdout.columns, process.stdout.rows] : undefined,
  // The shell edits its lines itself in raw mode; otherwise the
  // terminal does.
  onMode: (mode) => {
    raw = mode;
    if (tty) process.stdin.setRawMode(mode);
  },
});
// Ctrl+C: the node's SIGINT (erts' break menu), from the terminal in
// cooked mode, and as a key in raw mode.
process.on('SIGINT', () => node.signal(2));
process.stdin.on('data', (bytes: Buffer) => {
  if (raw && bytes.length === 1 && bytes[0] === 3) node.signal(2);
  else node.input(new Uint8Array(bytes));
});
process.stdin.on('end', () => node.end());
if (tty)
  process.stdout.on('resize', () => node.resize(process.stdout.columns, process.stdout.rows));
const { status } = await node.done;
if (tty) process.stdin.setRawMode(false);
process.exit(status);
