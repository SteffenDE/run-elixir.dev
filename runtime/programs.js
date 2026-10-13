// Programs a playground node can run (open_port, System.cmd), in place of
// the OS's. Each gets its Process (write, exit) and { args, cwd, env, root }.
import { Dir, File } from './wasi.js';

function lookup(root, path) {
  let node = root;
  for (const part of path.split('/').filter((p) => p && p !== '.')) {
    if (!(node instanceof Dir)) return null;
    node = part === '..' ? node.parent || node : node.entries.get(part);
    if (!node) return null;
  }
  return node;
}
const absolute = (cwd, path) => (path.startsWith('/') ? path : `${cwd}/${path}`);
const read = (root, path, fetch) => {
  const node = lookup(root, path);
  if (!(node instanceof File)) return null;
  if (node.source) {
    node.data = fetch(node.source);
    node.size = node.data.length;
    node.source = null;
  }
  return new TextDecoder().decode(node.bytes);
};

// git, as far as Mix asks a checked-out dependency (Mix.SCM.Git's
// lock_status): its origin and its revision, from .git.
export const git = (fetch) => (process, { args, cwd, root }) => {
  let gitDir = '.git';
  const rest = [];
  for (const arg of args) {
    if (arg.startsWith('--git-dir=')) gitDir = arg.slice('--git-dir='.length);
    else rest.push(arg);
  }
  const dir = absolute(cwd, gitDir);
  const [command, ...more] = rest;
  if (command === '--version') {
    process.write('git version 2.47.0 (playground)\n');
    return process.exit(0);
  }
  if (command === 'config' && more.length === 1) {
    const config = read(root, `${dir}/config`, fetch) ?? '';
    const [section, ...keys] = more[0].split('.');
    const key = keys.pop();
    const subsection = keys.join('.');
    let current = null;
    for (const line of config.split('\n')) {
      const header = line.match(/^\s*\[([^\s\]]+)(?:\s+"([^"]*)")?\]/);
      if (header) current = `${header[1]}.${header[2] ?? ''}`;
      const pair = line.match(/^\s*([\w-]+)\s*=\s*(.*)$/);
      if (pair && current === `${section}.${subsection}` && pair[1] === key) {
        process.write(pair[2].trim() + '\n');
        return process.exit(0);
      }
    }
    return process.exit(1);
  }
  if (command === 'rev-parse' && more.at(-1) === 'HEAD') {
    let head = (read(root, `${dir}/HEAD`, fetch) ?? '').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5);
      head = (read(root, `${dir}/${ref}`, fetch) ?? '').trim();
      if (!head) {
        const packed = read(root, `${dir}/packed-refs`, fetch) ?? '';
        head = packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.split(' ')[0] ?? '';
      }
    }
    if (!/^[0-9a-f]{40}$/.test(head)) return process.exit(1);
    process.write(head + '\n');
    return process.exit(0);
  }
  process.write(`git ${rest.join(' ')}: not available in the playground\n`);
  process.exit(1);
};

// esbuild and tailwind, as the Hex packages run them. For now they answer
// the version checks (the versions phx.new 1.8.15 configures); the assets
// in the image are prebuilt.
export const ESBUILD_VERSION = '0.25.4';
export const TAILWIND_VERSION = '4.3.3';

export function esbuild(process, { args }) {
  if (args[0] === '--version') {
    process.write(ESBUILD_VERSION + '\n');
    return process.exit(0);
  }
  process.write('esbuild: not yet available in the playground\n');
  process.exit(1);
}

export function tailwind(process, { args }) {
  if (args[0] === '--help') {
    process.write(`\u2248 tailwindcss v${TAILWIND_VERSION}\n`);
    return process.exit(0);
  }
  process.write('tailwind: not yet available in the playground\n');
  process.exit(1);
}
