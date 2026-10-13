// The playground's shared filesystem: /work and /tmp, in a worker of their
// own that runs no node. Every node (each shell in its own worker) reaches
// them through this one, so what a shell writes, the server in another
// sees; the page reads and writes them here too, and hears what changed.
//
// A node asks synchronously (wasi.js shared): each has a channel, a
// SharedArrayBuffer whose control[0] is 0 when idle, 1 with a request in
// it, 2 with the answer; it rings the shared doorbell and waits on
// control[0]. Requests and answers are a JSON header and bytes:
// [header length u32][header][bytes]. The page asks with messages.
//
// With a `store`, what changes below /work is kept (overlay.js): written
// a second after it changes, and laid over the template when the files
// start again.
import { Dir, File, untar, mount, load, bundled } from './wasi.js';
import * as overlays from './overlay.js';

const E = { SUCCESS: 0, EXIST: 20, INVAL: 28, IO: 29, ISDIR: 31, NOENT: 44, NOTDIR: 54, NOTEMPTY: 55, PERM: 63, XDEV: 75 };
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
export const SHARED = ['/work', '/tmp'];
export const CHANNEL = 1 << 20;

const now = () => BigInt(Date.now()) * 1000000n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let root = null;
let fetchFile = null;
const handles = new Map(); // handle -> { node, path, changed }
let nextHandle = 1;
const changed = new Set();
let reported = 0;
const channels = []; // { control: Int32Array, data: Uint8Array }
let doorbell = null;
// The kept changes: { db, version, whiteouts }, and the paths below /work
// changed since they were last written (true: with everything in them).
let overlay = null;
const dirty = new Map();
let saving = null;
let saved = 0;

function parts(path) {
  return path.split('/').filter((p) => p && p !== '.');
}

// { node, parent, name } or { error, parent?, name? } for an absolute path.
function resolve(path) {
  let dir = root;
  const list = parts(path);
  for (let i = 0; i < list.length; i++) {
    if (!(dir instanceof Dir)) return { error: E.NOTDIR };
    const part = list[i];
    if (part === '..') {
      dir = dir.parent || dir;
      continue;
    }
    const node = dir.entries.get(part);
    if (i === list.length - 1) return node ? { node, parent: dir, name: part } : { error: E.NOENT, parent: dir, name: part };
    if (!node) return { error: E.NOENT };
    dir = node;
  }
  return { node: dir };
}

function status(node) {
  return {
    type: node instanceof Dir ? 'dir' : 'file',
    size: node instanceof File ? node.size : 0,
    ino: Number(node.ino),
    mtime: String(node.mtime),
  };
}

// `deep`: everything in it changed too (a directory moved there).
function report(path, deep = false) {
  changed.add(path);
  if (overlay && path.startsWith('/work/')) dirty.set(path, dirty.get(path) || deep);
}

// The records for what changed (overlay.js), and the directories whose
// earlier records go.
function collect(path, node, deep, records, cleared) {
  if (node instanceof Dir) {
    const opaque = deep || overlay.whiteouts.has(path);
    records.push({ path, kind: 'dir', opaque, mtime: String(node.mtime) });
    if (opaque) cleared.push(path);
    overlay.whiteouts.delete(path);
    if (deep) for (const [name, child] of node.entries) collect(`${path}/${name}`, child, true, records, cleared);
  } else if (node instanceof File) {
    load(node, fetchFile);
    records.push({ path, kind: 'file', data: node.bytes.slice(), mtime: String(node.mtime) });
    overlay.whiteouts.delete(path);
  }
}

// Write what changed; one write at a time.
function persist() {
  if (saving || !dirty.size) return saving;
  const records = [];
  const cleared = [];
  for (const [path, deep] of [...dirty].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const found = resolve(path);
    if (found.node) {
      try {
        collect(path, found.node, deep, records, cleared);
      } catch (error) {
        postMessage({ kind: 'warning', message: `${path}: not kept (${error.message})` });
      }
    } else {
      records.push({ path, kind: 'gone' });
      cleared.push(path);
      overlay.whiteouts.add(path);
    }
  }
  dirty.clear();
  saved = performance.now();
  saving = overlays
    .save(overlay.db, records, cleared, overlay.version)
    .catch((error) => postMessage({ kind: 'warning', message: `changes not kept: ${error.message}` }))
    .finally(() => {
      saving = null;
    });
  return saving;
}

// Lay the kept changes over the files.
function apply(records) {
  for (const record of records) {
    const found = resolve(record.path);
    if (record.kind === 'gone') {
      if (found.node) found.parent.entries.delete(found.name);
    } else if (record.kind === 'dir') {
      const dir = record.opaque || !(found.node instanceof Dir) ? root.put(record.path, new Dir()) : found.node;
      dir.mtime = BigInt(record.mtime);
    } else if (record.kind === 'file') {
      const file = root.put(record.path, new File(record.data));
      file.written = true;
      file.mtime = BigInt(record.mtime);
    }
  }
}

// One request: { op, ... } and bytes; the answer and its bytes.
function handle({ op, path, to, handle: id, offset, length, oflags = 0, append, size }, bytes) {
  switch (op) {
    case 'stat': {
      const found = resolve(path);
      return found.node ? status(found.node) : { error: found.error };
    }
    case 'open': {
      const found = resolve(path);
      let node = found.node;
      let created = false;
      if (node && oflags & OFLAGS.CREAT && oflags & OFLAGS.EXCL) return { error: E.EXIST };
      if (!node) {
        if (!(oflags & OFLAGS.CREAT) || !found.parent) return { error: found.error };
        node = new File();
        node.written = true;
        found.parent.entries.set(found.name, node);
        found.parent.mtime = now();
        created = true;
      }
      if (oflags & OFLAGS.DIRECTORY && !(node instanceof Dir)) return { error: E.NOTDIR };
      try {
        load(node, fetchFile);
      } catch {
        return { error: E.IO };
      }
      if (node instanceof File && oflags & OFLAGS.TRUNC) {
        node.truncate(0);
        created = true;
      }
      const opened = nextHandle++;
      handles.set(opened, { node, path, changed: created });
      return { handle: opened, ...status(node) };
    }
    case 'read': {
      const entry = handles.get(id);
      if (!entry) return { error: E.INVAL };
      if (!(entry.node instanceof File)) return { error: E.ISDIR };
      return { answer: {}, bytes: entry.node.bytes.subarray(offset, offset + length) };
    }
    case 'write': {
      const entry = handles.get(id);
      if (!entry) return { error: E.INVAL };
      const file = entry.node;
      if (!(file instanceof File)) return { error: E.ISDIR };
      const at = append ? file.size : offset;
      const end = at + bytes.length;
      file.reserve(end);
      file.data.set(bytes, at);
      if (end > file.size) file.size = end;
      file.mtime = now();
      file.written = true;
      entry.changed = true;
      return { position: end };
    }
    case 'truncate': {
      const entry = handles.get(id);
      if (!entry || !(entry.node instanceof File)) return { error: E.INVAL };
      entry.node.truncate(size);
      entry.changed = true;
      return {};
    }
    case 'fstat': {
      const entry = handles.get(id);
      return entry ? status(entry.node) : { error: E.INVAL };
    }
    case 'readdir': {
      const entry = handles.get(id);
      if (!entry || !(entry.node instanceof Dir)) return { error: E.NOTDIR };
      return {
        entries: [...entry.node.entries].map(([name, node]) => [name, node instanceof Dir ? 'dir' : 'file', Number(node.ino)]),
      };
    }
    case 'close': {
      const entry = handles.get(id);
      handles.delete(id);
      if (entry?.changed) report(entry.path);
      return {};
    }
    case 'mkdir': {
      const found = resolve(path);
      if (found.node) return { error: E.EXIST };
      if (!found.parent) return { error: found.error };
      const dir = new Dir();
      dir.parent = found.parent;
      found.parent.entries.set(found.name, dir);
      report(path);
      return {};
    }
    case 'rmdir': {
      const found = resolve(path);
      if (!found.node) return { error: found.error };
      if (!(found.node instanceof Dir)) return { error: E.NOTDIR };
      if (found.node.entries.size) return { error: E.NOTEMPTY };
      found.parent.entries.delete(found.name);
      report(path);
      return {};
    }
    case 'unlink': {
      const found = resolve(path);
      if (!found.node) return { error: found.error };
      if (found.node instanceof Dir) return { error: E.ISDIR };
      found.parent.entries.delete(found.name);
      report(path);
      return {};
    }
    case 'rename': {
      const from = resolve(path);
      if (!from.node) return { error: from.error };
      const target = resolve(to);
      if (!target.parent) return { error: target.error };
      if (target.node instanceof Dir && target.node.entries.size) return { error: E.NOTEMPTY };
      from.parent.entries.delete(from.name);
      target.parent.entries.set(target.name, from.node);
      if (from.node instanceof Dir) from.node.parent = target.parent;
      report(path);
      report(to, true);
      return {};
    }
    case 'link': {
      const from = resolve(path);
      if (!from.node) return { error: from.error };
      if (from.node instanceof Dir) return { error: E.PERM };
      const target = resolve(to);
      if (target.node) return { error: E.EXIST };
      if (!target.parent) return { error: target.error };
      target.parent.entries.set(target.name, from.node);
      report(to);
      return {};
    }
  }
  return { error: E.INVAL };
}

// The nodes' requests, answered in turn.
function answer() {
  for (const channel of channels) {
    if (Atomics.load(channel.control, 0) !== 1) continue;
    const view = new DataView(channel.data.buffer, channel.data.byteOffset);
    const headerLength = view.getUint32(0, true);
    const total = Atomics.load(channel.control, 1);
    const request = JSON.parse(decoder.decode(channel.data.slice(4, 4 + headerLength)));
    const bytes = channel.data.slice(4 + headerLength, total);
    let result;
    try {
      result = handle(request, bytes);
    } catch (error) {
      result = { error: E.IO, message: error.message };
    }
    const out = result.bytes ?? new Uint8Array(0);
    const header = encoder.encode(JSON.stringify(result.answer ?? result));
    view.setUint32(0, header.length, true);
    channel.data.set(header, 4);
    channel.data.set(out.subarray(0, channel.data.length - 4 - header.length), 4 + header.length);
    Atomics.store(channel.control, 1, 4 + header.length + out.length);
    Atomics.store(channel.control, 0, 2);
    Atomics.notify(channel.control, 0);
  }
  if (changed.size && performance.now() - reported > 200) {
    postMessage({ kind: 'changed', paths: [...changed] });
    changed.clear();
    reported = performance.now();
  }
  if (overlay && dirty.size && performance.now() - saved > 1000) persist();
}

// The page's requests (host.js Files): the same filesystem, by message.
function page({ id, op, path, to, skip = [], data }) {
  const found = path ? resolve(path) : null;
  switch (op) {
    case 'list': {
      const entries = [];
      const walk = (dir, prefix) => {
        for (const [name, node] of dir.entries) {
          if (skip.includes(name)) continue;
          const full = `${prefix}/${name}`;
          entries.push({ path: full, dir: node instanceof Dir });
          if (node instanceof Dir) walk(node, full);
        }
      };
      if (found.node instanceof Dir) walk(found.node, path === '/' ? '' : path);
      return { id, entries };
    }
    case 'stat':
      return { id, type: found.node instanceof Dir ? 'dir' : found.node instanceof File ? 'file' : null };
    // POSIX's shape, with its error codes (isomorphic-git's fs).
    case 'lstat': {
      if (!found.node) return { id, error: `${path}: no such file`, code: 'ENOENT' };
      const node = found.node;
      return { id, type: node instanceof Dir ? 'dir' : 'file', size: node instanceof File ? node.size : 0,
        mtime: Number(node.mtime / 1000000n), ino: Number(node.ino) };
    }
    case 'readdir':
      if (!found.node) return { id, error: `${path}: no such directory`, code: 'ENOENT' };
      if (!(found.node instanceof Dir)) return { id, error: `${path}: not a directory`, code: 'ENOTDIR' };
      return { id, names: [...found.node.entries.keys()] };
    case 'unlink':
      if (!found.node) return { id, error: `${path}: no such file`, code: 'ENOENT' };
      if (found.node instanceof Dir) return { id, error: `${path}: is a directory`, code: 'EISDIR' };
      found.parent.entries.delete(found.name);
      report(path);
      return { id };
    case 'rmdir':
      if (!found.node) return { id, error: `${path}: no such directory`, code: 'ENOENT' };
      if (!(found.node instanceof Dir)) return { id, error: `${path}: not a directory`, code: 'ENOTDIR' };
      if (found.node.entries.size) return { id, error: `${path}: not empty`, code: 'ENOTEMPTY' };
      found.parent.entries.delete(found.name);
      report(path);
      return { id };
    case 'read': {
      if (!(found.node instanceof File)) return { id, error: `${path}: not a file`, code: found.node ? 'EISDIR' : 'ENOENT' };
      load(found.node, fetchFile);
      return { id, data: found.node.bytes.slice() };
    }
    case 'write': {
      if (found.node instanceof Dir) return { id, error: `${path}: is a directory` };
      if (found.node instanceof File) {
        load(found.node, fetchFile);
        found.node.truncate(data.length);
        found.node.data.set(data);
        found.node.written = true;
      } else if (found.parent) {
        const file = new File(data.slice());
        file.written = true;
        found.parent.entries.set(found.name, file);
      } else return { id, error: `${path}: no such directory` };
      report(path);
      return { id };
    }
    case 'mkdir':
      root.mkdirs(path);
      report(path);
      return { id };
    case 'remove':
      if (!found.node) return { id, error: `${path}: no such file` };
      found.parent.entries.delete(found.name);
      report(path);
      return { id };
    case 'rename': {
      const result = handle({ op: 'rename', path, to });
      return result.error ? { id, error: `${path}: cannot rename` } : { id };
    }
  }
  return { id, error: `${op}: no such request` };
}

let loop = null;

onmessage = async ({ data }) => {
  if (data.kind === 'start') {
    try {
      // boots: the boot images to unpack (worker.js); template: the
      // directories below /work the project starts with, from the site's
      // files (/work/playground for a Phoenix project); store: the
      // IndexedDB database the project's changes are kept in.
      const { base, boots = ['boot'], template = [], store = null } = data;
      const [images, manifest, version] = await Promise.all([
        Promise.all(boots.map((boot) => fetch(new URL(`fs/${boot}.tar.gz`, base)).then((r) => r.arrayBuffer()))),
        fetch(new URL('fs/manifest.json', base)).then((r) => r.json()),
        fetch(new URL('fs/version', base)).then((r) => (r.ok ? r.text() : '')),
      ]);
      root = new Dir();
      const shared = (path) =>
        `/${path}`.startsWith('/tmp/') || template.some((prefix) => `/${path}/`.startsWith(`${prefix}/`));
      mount(manifest.filter(([path]) => shared(path)), root);
      for (const image of images) await untar(new Uint8Array(image), root, shared);
      for (const prefix of SHARED) root.mkdirs(prefix);
      if (store) {
        const db = await overlays.open(store);
        let kept = await overlays.load(db);
        // Another site build: the template's own build is the new one, and
        // the project's sources recompile over it.
        if (kept.version && kept.version !== version.trim() && template.length) {
          for (const prefix of template) await overlays.drop(db, `${prefix}/_build`);
          kept = await overlays.load(db);
        }
        apply(kept.records);
        const whiteouts = new Set(kept.records.filter((record) => record.kind === 'gone').map((record) => record.path));
        overlay = { db, version: version.trim(), whiteouts };
      }
      fetchFile = bundled((bundle) => {
        const request = new XMLHttpRequest();
        request.open('GET', new URL(`fs/bundles/${bundle}.tar`, base), false);
        request.responseType = 'arraybuffer';
        request.send();
        if (request.status !== 200) throw new Error(`bundle ${bundle}: ${request.status}`);
        return new Uint8Array(request.response);
      });
      doorbell = new Int32Array(data.doorbell);
      postMessage({ kind: 'ready' });
      loop ??= serve();
    } catch (error) {
      postMessage({ kind: 'failed', message: error.stack || String(error) });
    }
  } else if (data.kind === 'connect') {
    channels.push({ control: new Int32Array(data.channel, 0, 2), data: new Uint8Array(data.channel, 8) });
  } else if (data.kind === 'disconnect') {
    const index = channels.findIndex((c) => c.control.buffer === data.channel);
    if (index >= 0) channels.splice(index, 1);
  } else if (data.kind === 'request' && data.op === 'flush') {
    // Everything changed so far, kept.
    if (overlay) {
      await saving;
      await persist();
    }
    postMessage({ kind: 'reply', id: data.id });
  } else if (data.kind === 'request') {
    let reply;
    try {
      reply = page(data);
    } catch (error) {
      reply = { id: data.id, error: error.message };
    }
    postMessage({ kind: 'reply', ...reply }, reply.data ? [reply.data.buffer] : []);
  }
};

// Answer nodes as they ring; let the page's messages in between.
async function serve() {
  for (;;) {
    const started = performance.now();
    while (performance.now() - started < 20) {
      const rung = Atomics.load(doorbell, 0);
      answer();
      if (Atomics.wait(doorbell, 0, rung, 5) === 'timed-out') break;
    }
    answer();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
