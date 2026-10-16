// git on the page, for the node: isomorphic-git over the node's files,
// fetching through the site's proxy at /git/ (GitHub and others send no
// CORS headers; serve.py, Caddy in docs/deploy.md). It answers what Mix
// asks of git for a dependency (Mix.SCM.Git): init, remote add and
// set-head, config, fetch (a branch, a tag, or a locked revision, with a
// depth), checkout (sparse, as .git/info/sparse-checkout says), read-tree
// -mu HEAD, rev-parse; and --version. In the shell: clone, and pull as a
// fast-forward (docs/git.md).
import { Buffer } from 'buffer';
import type { FileSystem as Files } from '@/runtime/host/files';
import type { Context, Process } from './tailwind';

// isomorphic-git expects Node's Buffer.
(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
const git = import('isomorphic-git');
const http = import('isomorphic-git/http/web').then((module) => module.default);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

class Failure extends Error {
  constructor(
    message: string,
    readonly status = 128,
  ) {
    super(message);
  }
}

const posixError = (code: string, path: string) =>
  Object.assign(new Error(`${code}: ${path}`), { code });

// Node's fs.promises, as much as isomorphic-git uses, over the node's files.
function fsFor(files: Files) {
  const stats = async (path: string) => {
    const { type, size, mtime, ino } = await files.lstat(path);
    const dir = type === 'dir';
    return {
      type,
      mode: dir ? 0o40755 : 0o100644,
      size,
      ino,
      mtimeMs: mtime,
      ctimeMs: mtime,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => !dir,
      isDirectory: () => dir,
      isSymbolicLink: () => false,
    };
  };
  return {
    promises: {
      async readFile(path: string, options?: string | { encoding?: string }) {
        const bytes = await files.read(path);
        const encoding = typeof options === 'string' ? options : options?.encoding;
        return encoding === 'utf8' ? decoder.decode(bytes) : Buffer.from(bytes);
      },
      async writeFile(path: string, data: string | Uint8Array) {
        await files.write(path, typeof data === 'string' ? encoder.encode(data) : data);
      },
      unlink: (path: string) => files.unlink(path),
      rmdir: (path: string) => files.rmdir(path),
      readdir: (path: string) => files.readdir(path),
      async mkdir(path: string) {
        if ((await files.stat(path)) !== null) throw posixError('EEXIST', path);
        const parent = path.replace(/\/[^/]*$/, '') || '/';
        if ((await files.stat(parent)) !== 'dir') throw posixError('ENOENT', parent);
        await files.mkdir(path);
      },
      stat: stats,
      lstat: stats,
      async readlink(path: string): Promise<string> {
        throw posixError('ENOENT', path);
      },
      async symlink(_target: string, path: string) {
        throw posixError('EPERM', path);
      },
      async chmod() {},
    },
  };
}

const join = (cwd: string, path: string) => (path.startsWith('/') ? path : `${cwd}/${path}`);

// join, without . and .. (a clone's directory).
function joinPath(cwd: string, path: string): string {
  const out: string[] = [];
  for (const part of join(cwd, path).split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return `/${out.join('/')}`;
}

// The hosts the site's proxy serves (serve.py, Caddy in docs/deploy.md).
const HOSTS = ['github.com', 'gitlab.com', 'codeberg.org'];

// A clone's address as HTTPS (git@HOST:OWNER/REPO and ssh:// too: there is
// no SSH from the page), on a host the proxy serves.
function cloneUrl(address: string): string {
  const scp = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(address);
  const url = scp ? `https://${scp[1]}/${scp[2]}` : address;
  const host = /^https?:\/\/([^/]+)\//.exec(url)?.[1];
  if (!host || !HOSTS.includes(host))
    throw new Failure(`fatal: the playground clones only from ${HOSTS.join(', ')} (over HTTPS)`);
  return url.replace(/^http:/, 'https:');
}

// What the server says, each line as git prints it.
const remoteSays = (out: (text: string) => void) => (message: string) =>
  out(`remote: ${message.replace(/\n(?!$)/g, '\nremote: ')}`);

// isomorphic-git's progress as git prints it: one line per phase, counted
// in place.
function progress(out: (text: string) => void) {
  let phase = '';
  let done = false;
  return ({ phase: next, loaded, total }: { phase: string; loaded: number; total: number }) => {
    if (next === phase && done) return;
    if (next !== phase && phase && !done) out('\n');
    phase = next;
    done = !!total && loaded >= total;
    const count = total
      ? `${Math.floor((loaded * 100) / total)}% (${loaded}/${total})`
      : `${loaded}`;
    out(`\r${next}: ${count}${done ? ', done.\n' : ''}`);
  };
}

export async function gitProgram(process: Process, { args, cwd, fs: files }: Context) {
  const out = (text: string) => process.write(text);
  try {
    await run(args, cwd, files, out);
    process.exit(0);
  } catch (error) {
    out(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof Failure ? error.status : 128);
  }
}

async function run(args: string[], cwd: string, files: Files, out: (text: string) => void) {
  // Global options: -c NAME=VALUE (hooks: there are none), --git-dir, -C.
  let gitdir = join(cwd, '.git');
  let dir = cwd;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c') i++;
    else if (arg.startsWith('--git-dir=')) gitdir = join(cwd, arg.slice('--git-dir='.length));
    else if (arg === '-C') dir = join(cwd, args[++i]);
    else rest.push(arg);
  }
  if (!args.some((arg) => arg.startsWith('--git-dir='))) gitdir = `${dir}/.git`;
  const [command, ...more] = rest;
  const flags = more.filter((arg) => arg.startsWith('-'));
  const words = more.filter((arg) => !arg.startsWith('-'));
  const flag = (name: string) => flags.find((f) => f === name || f.startsWith(`${name}=`));

  if (command === '--version' || command === 'version') {
    out('git version 2.47.0 (isomorphic-git)\n');
    return;
  }

  const g = await git;
  const fs = fsFor(files);
  const base = { fs, dir, gitdir };
  const remote = {
    http: await http,
    corsProxy: `${location.origin}/git`,
  };
  const url = async () => {
    const value = await g.getConfig({ ...base, path: 'remote.origin.url' });
    if (!value) throw new Failure("fatal: 'origin' does not appear to be a git repository");
    return value as string;
  };
  // A revision's commit: a hash, a tag (annotated ones peeled), a branch,
  // origin/NAME, HEAD.
  const commitOf = async (rev: string) => {
    let oid: string;
    try {
      oid = /^[0-9a-f]{40}$/.test(rev) ? rev : await g.resolveRef({ ...base, ref: rev });
    } catch {
      throw new Failure(`fatal: ambiguous argument '${rev}': unknown revision`);
    }
    // Without the objects (a dependency's .git that keeps only config and
    // HEAD, as the template's do), the hash is all there is.
    for (;;) {
      const read = await g.readObject({ ...base, oid, format: 'parsed' }).catch(() => null);
      if (read?.type !== 'tag') return oid;
      oid = (read.object as { object: string }).object;
    }
  };

  switch (command) {
    case 'init':
      await g.init({ ...base, defaultBranch: 'main' });
      if (!flag('--quiet') && !flag('-q')) out(`Initialized empty Git repository in ${gitdir}/\n`);
      return;

    case 'remote': {
      const [action, name, value] = words;
      if (action === 'add') await g.addRemote({ ...base, remote: name, url: value, force: true });
      else if (action === 'set-head') {
        // The remote's default branch, as origin/HEAD.
        const refs = await g.listServerRefs({
          ...remote,
          url: await url(),
          symrefs: true,
          prefix: 'HEAD',
        });
        const head = (refs.find((r) => r.ref === 'HEAD')?.target ?? 'refs/heads/main').replace(
          'refs/heads/',
          '',
        );
        await g.writeRef({
          ...base,
          ref: `refs/remotes/${name}/HEAD`,
          value: `refs/remotes/${name}/${head}`,
          symbolic: true,
          force: true,
        });
      } else throw new Failure(`git remote ${action}: not available in the playground`, 1);
      return;
    }

    case 'config': {
      const [path, value] = words;
      if (value === undefined) {
        const found = await g.getConfig({ ...base, path });
        if (found === undefined) throw new Failure('', 1);
        out(`${found}\n`);
      } else await g.setConfig({ ...base, path, value });
      return;
    }

    case 'fetch': {
      const depthFlag = flag('--depth');
      let depth = depthFlag ? Number(depthFlag.split('=')[1]) : undefined;
      const [, rev] = words;
      const options = {
        ...base,
        ...remote,
        url: await url(),
        remote: 'origin',
        tags: !!flag('--tags'),
      };
      if (!rev) {
        await g.fetch({ ...options, singleBranch: false, depth });
        return;
      }
      // What the server calls the revision (it answers refs, not bare
      // hashes, to isomorphic-git): a locked hash's ref is the one that
      // points at it.
      const refs = await g.listServerRefs({ ...remote, url: options.url, peelTags: true });
      const locked = /^[0-9a-f]{40}$/.test(rev);
      const tip = locked
        ? refs.find((r) => r.oid === rev || r.peeled === rev)
        : refs.find((r) => [rev, `refs/tags/${rev}`, `refs/heads/${rev}`].includes(r.ref));
      if (!tip) {
        if (!locked) throw new Failure(`fatal: couldn't find remote ref ${rev}`);
        // Somewhere in a branch's history: all of it.
        await g.fetch({ ...options, singleBranch: false });
        return;
      }
      // Only a locked revision is checked out; its history is not needed.
      if (locked) depth ??= 1;
      await g.fetch({ ...options, ref: tip.ref, singleBranch: true, depth });
      // A fetched tag is checked out by name: keep it as a local tag.
      if (tip.ref.startsWith('refs/tags/')) {
        await g.writeRef({ ...base, ref: tip.ref, value: tip.oid, force: true });
      }
      return;
    }

    case 'checkout':
    case 'read-tree': {
      const rev = command === 'read-tree' ? 'HEAD' : words[0];
      if (!rev) throw new Failure(`git ${command}: which revision?`, 1);
      const oid = await commitOf(rev);
      // A sparse checkout: the patterns Mix wrote, as paths.
      const sparse = (await g.getConfig({ ...base, path: 'core.sparsecheckout' })) === 'true';
      let filepaths: string[] | undefined;
      if (sparse) {
        const patterns = await files.read(`${gitdir}/info/sparse-checkout`).then(
          (bytes) => decoder.decode(bytes),
          () => '*',
        );
        const paths = patterns
          .split('\n')
          .map((line) =>
            line
              .trim()
              .replace(/^\//, '')
              .replace(/\/\*?$/, ''),
          )
          .filter((line) => line && !line.startsWith('#'));
        if (!paths.includes('*')) filepaths = paths;
      }
      await g.checkout({ ...base, ref: oid, force: true, noUpdateHead: true, filepaths });
      // Detached, as git checks out a revision.
      await files.write(`${gitdir}/HEAD`, encoder.encode(`${oid}\n`));
      return;
    }

    case 'clone': {
      // git clone [--depth N] [--branch NAME] URL [DIR]
      let depth: number | undefined;
      let ref: string | undefined;
      const operands: string[] = [];
      for (let i = 0; i < more.length; i++) {
        const arg = more[i];
        const [name, inline] = arg.split(/=(.*)/s);
        const value = () => inline ?? more[++i];
        if (name === '--depth') depth = Number(value());
        else if (name === '--branch' || name === '-b') ref = value();
        else if (arg === '-q' || arg === '--quiet' || arg === '--single-branch') continue;
        else if (arg.startsWith('-')) throw new Failure(`git clone ${arg}: not available`, 129);
        else operands.push(arg);
      }
      const [address, target] = operands;
      if (!address) throw new Failure('usage: git clone [--depth N] [-b BRANCH] URL [DIR]', 129);
      const from = cloneUrl(address);
      const name =
        target ??
        from
          .replace(/\/$/, '')
          .split('/')
          .pop()!
          .replace(/\.git$/, '');
      const into = joinPath(dir, name);
      if ((await files.stat(into)) === 'file' || (await files.readdir(into).catch(() => [])).length)
        throw new Failure(
          `fatal: destination path '${name}' already exists and is not an empty directory.`,
        );
      out(`Cloning into '${name}'...\n`);
      await g.clone({
        ...remote,
        fs,
        dir: into,
        url: from,
        ref,
        depth,
        singleBranch: !!ref || depth !== undefined,
        onProgress: progress(out),
        onMessage: remoteSays(out),
      });
      return;
    }

    case 'pull': {
      // The branch's upstream, fast-forward only.
      await url();
      const branch = await g.currentBranch(base);
      if (!branch) throw new Failure('You are not currently on a branch.');
      const before = await g.resolveRef({ ...base, ref: 'HEAD' });
      try {
        await g.fastForward({
          ...base,
          ...remote,
          remote: 'origin',
          ref: branch,
          singleBranch: true,
          onProgress: progress(out),
          onMessage: remoteSays(out),
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'FastForwardError')
          throw new Failure(
            'fatal: Not possible to fast-forward, aborting. (Merges are not available in the playground.)',
          );
        throw error;
      }
      const after = await g.resolveRef({ ...base, ref: 'HEAD' });
      out(
        before === after
          ? 'Already up to date.\n'
          : `Updating ${before.slice(0, 7)}..${after.slice(0, 7)}\nFast-forward\n`,
      );
      return;
    }

    case 'rev-parse': {
      const rev = words.at(-1) ?? 'HEAD';
      try {
        out(`${await commitOf(rev)}\n`);
      } catch (error) {
        if (flag('--quiet') || flag('-q')) throw new Failure('', 1);
        throw error;
      }
      return;
    }
  }
  throw new Failure(`git ${rest.join(' ')}: not available in the playground`, 1);
}
