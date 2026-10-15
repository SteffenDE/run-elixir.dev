// Files for code beside the node (the shell's builtins, programs.js): the
// worker's own tree, and the shared directories through their channel
// (sharedClient), as one.
import { Dir, File, load, lookup as find } from './wasi.js';

const CREATE = 1 | 8; // OFLAGS CREAT | TRUNC

// The node at `path`, symbolic links followed, or null.
function lookup(root, path) {
  return find(root, root, path).node ?? null;
}

// root: the worker's tree; fetch: its lazily fetched files; shared:
// { prefixes, call } or null.
export function vfs(root, fetch, shared = null) {
  const remote = (path) => shared?.prefixes.some((p) => path === p || path.startsWith(`${p}/`));
  const ask = (request, bytes) => shared.call(request, bytes);
  const decoder = new TextDecoder();
  const api = {
    // { dir } or null.
    stat(path) {
      if (remote(path)) {
        const { answer } = ask({ op: 'stat', path });
        return answer.error ? null : { dir: answer.type === 'dir' };
      }
      const node = lookup(root, path);
      return node ? { dir: node instanceof Dir } : null;
    },
    // [{ name, dir }] or null.
    list(path) {
      if (remote(path)) {
        const opened = ask({ op: 'open', path, oflags: 2 }).answer;
        if (opened.error) return null;
        const { entries = [] } = ask({ op: 'readdir', handle: opened.handle }).answer;
        ask({ op: 'close', handle: opened.handle });
        // A symbolic link counts as a file here (remove unlinks it).
        return entries.map(([name, type]) => ({ name, dir: type === 'dir' }));
      }
      const node = lookup(root, path);
      if (!(node instanceof Dir)) return null;
      return [...node.entries].map(([name, entry]) => ({ name, dir: entry instanceof Dir }));
    },
    // The file's bytes, or null.
    read(path) {
      if (remote(path)) {
        const opened = ask({ op: 'open', path }).answer;
        if (opened.error || opened.type === 'dir') return null;
        const chunks = [];
        let offset = 0;
        for (;;) {
          const { bytes } = ask({ op: 'read', handle: opened.handle, offset, length: 512 * 1024 });
          chunks.push(bytes);
          offset += bytes.length;
          if (bytes.length < 512 * 1024) break;
        }
        ask({ op: 'close', handle: opened.handle });
        const out = new Uint8Array(offset);
        let at = 0;
        for (const chunk of chunks) {
          out.set(chunk, at);
          at += chunk.length;
        }
        return out;
      }
      const node = lookup(root, path);
      if (!(node instanceof File)) return null;
      load(node, fetch);
      return node.bytes;
    },
    readText(path) {
      const bytes = api.read(path);
      return bytes ? decoder.decode(bytes) : null;
    },
    mkdir(path) {
      if (remote(path)) {
        let at = '';
        for (const part of path.split('/').filter(Boolean)) {
          at += `/${part}`;
          if (!api.stat(at)) ask({ op: 'mkdir', path: at });
        }
        return;
      }
      root.mkdirs(path);
    },
    // A file with these bytes, made or replaced; its directory must exist.
    write(path, bytes) {
      if (remote(path)) {
        const opened = ask({ op: 'open', path, oflags: CREATE }).answer;
        if (opened.error) return false;
        for (let at = 0; at < bytes.length; at += 512 * 1024)
          ask(
            { op: 'write', handle: opened.handle, offset: at },
            bytes.subarray(at, at + 512 * 1024),
          );
        ask({ op: 'close', handle: opened.handle });
        return true;
      }
      const file = root.put(path, new File(bytes));
      file.written = true;
      return true;
    },
    // Recursively; a symbolic link is removed, not what it names.
    remove(path) {
      if (remote(path)) {
        const { answer: status } = ask({ op: 'stat', path, follow: false });
        if (status.error) return;
        if (status.type === 'dir') {
          for (const entry of api.list(path) ?? []) api.remove(`${path}/${entry.name}`);
          ask({ op: 'rmdir', path });
        } else ask({ op: 'unlink', path });
        return;
      }
      const parent = lookup(root, path.slice(0, path.lastIndexOf('/')) || '/');
      parent?.entries?.delete(path.slice(path.lastIndexOf('/') + 1));
    },
  };
  return api;
}
