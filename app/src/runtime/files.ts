// The playground's shared filesystem: /work and /tmp, in a worker of their
// own that runs no node. Every node (each shell in its own worker) reaches
// them through this one, so what a shell writes, the server in another
// sees; the page reads and writes them here too, and hears what changed.
//
// A node asks synchronously (wasi/shared.ts): each has a channel, a
// SharedArrayBuffer whose control[0] is 0 when idle, 1 with a request in
// it, 2 with the answer; it rings the shared doorbell and waits on
// control[0]. Requests and answers are a JSON header and bytes:
// [header length u32][header][bytes]. The page asks with messages.
//
// With a `store`, what changes below /work is kept (overlay.ts): written
// a second after it changes, and laid over the template when the files
// start again.
import { Site, type SiteRef } from './packages/manifest';
import {
  Dir,
  File,
  Symlink,
  lookup,
  entries as tarEntries,
  gunzip,
  untarInto,
  mount,
  load,
  bundled,
  fetchBundle,
  type Fetch,
  type Found,
  type FsNode,
} from './wasi/fs';
import * as overlays from './overlay';
import type { KeptRecord } from './overlay';
import type { Entry, SearchHit, SearchQuery } from './host/files';
import { LARGEST, pattern, searchFile } from './search';

// This worker's postMessage (a dedicated worker's: the app's DOM library
// has the page's).
declare function postMessage(message: unknown, transfer?: Transferable[]): void;

// A node's request (wasi/shared.ts sharedCalls): the fields its op takes.
interface NodeRequest {
  op: string;
  path: string;
  to: string;
  target: string;
  follow?: boolean;
  handle: number;
  offset: number;
  length: number;
  oflags?: number;
  append: boolean;
  size: number;
}
// What answers it: its fields, or `answer` with `bytes` after it.
type NodeAnswer = { error?: number; answer?: object; bytes?: Uint8Array; [field: string]: unknown };

// The page's request (host/files.ts) and its reply.
interface PageRequest {
  id: number;
  op: string;
  path: string;
  to: string;
  target?: string;
  skip?: string[];
  data: Uint8Array;
  query?: SearchQuery;
  limit?: number;
}
type PageReply = {
  id: number;
  error?: string;
  data?: Uint8Array;
  changed?: { path: string; data: Uint8Array }[];
  [field: string]: unknown;
};

const E = {
  SUCCESS: 0,
  EXIST: 20,
  INVAL: 28,
  IO: 29,
  ISDIR: 31,
  LOOP: 32,
  NOENT: 44,
  NOTDIR: 54,
  NOTEMPTY: 55,
  PERM: 63,
  XDEV: 75,
};
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
// /shared: the user's, the same in every project that has it (kept on the
// apex, settings.ts); empty and kept nowhere in one that has not.
export const SHARED = ['/work', '/tmp', '/home', '/shared'];
// What is kept in the project's database: its files, and its home's.
const KEPT = ['/work/', '/home/'];
const KEPT_SHARED = ['/shared/'];
export const CHANNEL = 1 << 20;

const now = () => BigInt(Date.now()) * 1000000n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The tree and its lazily fetched files, from 'start' on.
let root: Dir = null!;
let fetchFile: Fetch = null!;
const handles = new Map<number, { node: FsNode; path: string; changed: boolean }>();
let nextHandle = 1;
const changed = new Set<string>();
let reported = 0;
const channels: { control: Int32Array; data: Uint8Array }[] = [];
let doorbell: Int32Array = null!;
// Where changes are kept: the project's database (/work, /home), and
// /shared's (every project's); each with the paths below its prefixes
// changed since they were last written (true: with everything in them).
// /shared's saves are reported, for the other projects open (`apply`).
interface Keeper {
  prefixes: string[];
  store: overlays.Store;
  version: string;
  whiteouts: Set<string>;
  dirty: Map<string, boolean>;
  saving: Promise<void> | null;
  saved: number;
  // How often it writes, at most: /shared's more often, so the other
  // projects hear its changes soon.
  every: number;
  report: boolean;
  // Hidden for a while (/shared, while a live session's guest may type):
  // nothing kept, and what other projects kept held until it is back.
  paused: KeptRecord[][] | null;
}
const keepers: Keeper[] = [];
const keeperOf = (path: string) =>
  keepers.find((keeper) => keeper.prefixes.some((prefix) => path.startsWith(prefix)));
// The template's files, as the project started (what 'changes' compares
// with).
const templateFiles = new Set<string>();

// { node, parent, name } or { error, parent?, name? } for an absolute path:
// symbolic links on the way followed, a last one only when `follow`.
function resolve(path: string, follow = false): Found {
  return lookup(root, root, path, follow);
}

function type(node: FsNode): 'dir' | 'link' | 'file' {
  return node instanceof Dir ? 'dir' : node instanceof Symlink ? 'link' : 'file';
}

function status(node: FsNode) {
  return {
    type: type(node),
    size: node instanceof Dir ? 0 : node.size,
    ino: Number(node.ino),
    mtime: String(node.mtime),
  };
}

// `deep`: everything in it changed too (a directory moved there). It is
// kept by its path with no symbolic links on the way, so it is laid back
// where it is whether or not the links are back yet.
function report(path: string, deep = false): void {
  changed.add(path);
  if (!keepers.length) return;
  path = physical(path);
  const keeper = keeperOf(path);
  if (keeper && !keeper.paused) keeper.dirty.set(path, keeper.dirty.get(path) || deep);
}

// An absolute path with its directory's symbolic links resolved (its last
// name, a link itself, stays).
function physical(path: string): string {
  const cut = path.lastIndexOf('/');
  const found = resolve(path.slice(0, cut) || '/', true);
  if (!(found.node instanceof Dir)) return path;
  const names: string[] = [];
  for (let dir = found.node; dir.parent; dir = dir.parent) {
    for (const [name, child] of dir.parent.entries) {
      if (child === dir) {
        names.unshift(name);
        break;
      }
    }
  }
  return `/${names.join('/')}${path.slice(cut)}`;
}

// The records for what changed (overlay.ts), and the directories whose
// earlier records go.
function collect(
  keeper: Keeper,
  path: string,
  node: FsNode,
  deep: boolean,
  records: KeptRecord[],
  cleared: string[],
): void {
  if (node instanceof Dir) {
    const opaque = deep || keeper.whiteouts.has(path);
    records.push({ path, kind: 'dir', opaque, mtime: String(node.mtime) });
    if (opaque) cleared.push(path);
    keeper.whiteouts.delete(path);
    if (deep)
      for (const [name, child] of node.entries)
        collect(keeper, `${path}/${name}`, child, true, records, cleared);
  } else if (node instanceof File) {
    load(node, fetchFile);
    records.push({ path, kind: 'file', data: node.bytes.slice(), mtime: String(node.mtime) });
    keeper.whiteouts.delete(path);
  } else if (node instanceof Symlink) {
    records.push({ path, kind: 'link', target: node.target, mtime: String(node.mtime) });
    keeper.whiteouts.delete(path);
  }
}

// Persist pending changes, serializing writes within each keeper.
function persist(keeper: Keeper): Promise<void> | null {
  if (keeper.saving || !keeper.dirty.size) return keeper.saving;
  const records: KeptRecord[] = [];
  const cleared: string[] = [];
  for (const [path, deep] of [...keeper.dirty].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const found = resolve(path);
    if (found.node) {
      try {
        collect(keeper, path, found.node, deep, records, cleared);
      } catch (error) {
        postMessage({
          kind: 'warning',
          message: `${path}: not kept (${(error as Error).message})`,
        });
      }
    } else {
      records.push({ path, kind: 'gone' });
      cleared.push(path);
      keeper.whiteouts.add(path);
    }
  }
  keeper.dirty.clear();
  keeper.saved = performance.now();
  // What the other projects open hear (the store takes the records' bytes).
  if (keeper.report)
    postMessage({
      kind: 'kept',
      records: records.map((record) =>
        record.kind === 'file' ? { ...record, data: record.data.slice() } : record,
      ),
    });
  keeper.saving = keeper.store
    .save(records, cleared, keeper.version)
    .catch((error: Error) =>
      postMessage({ kind: 'warning', message: `changes not kept: ${error.message}` }),
    )
    .finally(() => {
      keeper.saving = null;
    });
  return keeper.saving;
}

// Flush all pending changes to storage.
async function flush(): Promise<void> {
  for (const keeper of keepers) {
    if (keeper.paused) continue;
    await keeper.saving;
    await persist(keeper);
  }
}

// /shared hidden (an empty folder in its place, kept nowhere) while a live
// session's guest may type, at the host's choice; back after, with what
// the other projects kept meanwhile.
let hiddenShared: FsNode | null = null;
let sharedVisibility = Promise.resolve();
function hideShared(hide: boolean): Promise<void> {
  const transition = sharedVisibility.then(() => setSharedHidden(hide));
  sharedVisibility = transition.catch(() => {});
  return transition;
}

async function setSharedHidden(hide: boolean): Promise<void> {
  const keeper = keepers.find((each) => each.prefixes === KEPT_SHARED);
  if (hide && !hiddenShared) {
    if (keeper) {
      await keeper.saving;
      await persist(keeper);
      keeper.paused = [];
    }
    hiddenShared = root.entries.get('shared') ?? new Dir();
    const empty = new Dir();
    empty.parent = root;
    root.entries.set('shared', empty);
  } else if (!hide && hiddenShared) {
    root.entries.set('shared', hiddenShared);
    hiddenShared = null;
    const held = keeper?.paused ?? [];
    if (keeper) keeper.paused = null;
    for (const records of held) apply(records, true, true);
  }
  changed.add('/shared');
}

// Lay the kept changes over the files. Those another project kept (/shared:
// `live`) change a file in place, so what has it open reads them, and are
// reported to the watchers and the page, not kept again.
function apply(records: KeptRecord[], live = false, shared = false): void {
  for (const record of records) {
    if (shared) {
      if (!overlays.sharedRecords([record])) continue;
      // Records describe physical paths. Never follow a project's links
      // while applying another project's changes, even links inside /shared.
      let parent = root;
      let safe = true;
      for (const name of record.path.split('/').slice(1, -1)) {
        let next = parent.entries.get(name);
        if (!next && record.kind !== 'gone') {
          next = new Dir();
          next.parent = parent;
          parent.entries.set(name, next);
        }
        if (!(next instanceof Dir)) {
          safe = false;
          break;
        }
        parent = next;
      }
      if (!safe) continue;
    }
    const found = resolve(record.path);
    if (live) changed.add(record.path);
    if (live && record.kind === 'file' && found.node instanceof File) {
      found.node.truncate(record.data.length);
      found.node.data.set(record.data);
      found.node.written = true;
      found.node.mtime = BigInt(record.mtime);
      continue;
    }
    if (live && record.kind !== 'gone')
      root.mkdirs(record.path.slice(0, record.path.lastIndexOf('/')) || '/');
    if (record.kind === 'gone') {
      if (found.node) found.parent!.entries.delete(found.name!);
    } else if (record.kind === 'dir') {
      const dir =
        record.opaque || !(found.node instanceof Dir)
          ? root.put(record.path, new Dir())
          : found.node;
      dir.mtime = BigInt(record.mtime);
    } else if (record.kind === 'file') {
      const file = root.put(record.path, new File(record.data));
      file.written = true;
      file.mtime = BigInt(record.mtime);
    } else if (record.kind === 'link') {
      root.put(record.path, new Symlink(record.target)).mtime = BigInt(record.mtime);
    }
  }
}

// One request: { op, ... } and bytes; the answer and its bytes.
function handle(
  {
    op,
    path,
    to,
    target,
    follow = true,
    handle: id,
    offset,
    length,
    oflags = 0,
    append,
    size,
  }: NodeRequest,
  bytes?: Uint8Array,
): NodeAnswer {
  switch (op) {
    case 'stat': {
      const found = resolve(path, follow);
      return found.node ? status(found.node) : { error: found.error };
    }
    case 'open': {
      const found = resolve(path, follow);
      let node = found.node;
      let created = false;
      if (node && oflags & OFLAGS.CREAT && oflags & OFLAGS.EXCL) return { error: E.EXIST };
      // O_NOFOLLOW on a symbolic link.
      if (node instanceof Symlink) return { error: E.LOOP };
      if (!node) {
        if (!(oflags & OFLAGS.CREAT) || !found.parent) return { error: found.error };
        node = new File();
        node.written = true;
        found.parent.entries.set(found.name!, node);
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
      const end = at + bytes!.length;
      file.reserve(end);
      file.data.set(bytes!, at);
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
        entries: [...entry.node.entries].map(([name, node]) => [
          name,
          type(node),
          Number(node.ino),
        ]),
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
      found.parent.entries.set(found.name!, dir);
      report(path);
      return {};
    }
    case 'rmdir': {
      const found = resolve(path);
      if (!found.node) return { error: found.error };
      if (!(found.node instanceof Dir)) return { error: E.NOTDIR };
      if (found.node.entries.size) return { error: E.NOTEMPTY };
      found.parent!.entries.delete(found.name!);
      report(path);
      return {};
    }
    case 'unlink': {
      const found = resolve(path);
      if (!found.node) return { error: found.error };
      if (found.node instanceof Dir) return { error: E.ISDIR };
      found.parent!.entries.delete(found.name!);
      report(path);
      return {};
    }
    case 'rename': {
      const from = resolve(path);
      if (!from.node) return { error: from.error };
      const onto = resolve(to);
      if (!onto.parent) return { error: onto.error };
      if (onto.node instanceof Dir && onto.node.entries.size) return { error: E.NOTEMPTY };
      from.parent!.entries.delete(from.name!);
      onto.parent.entries.set(onto.name!, from.node);
      if (from.node instanceof Dir) from.node.parent = onto.parent;
      report(path);
      report(to, true);
      return {};
    }
    case 'link': {
      const from = resolve(path, follow);
      if (!from.node) return { error: from.error };
      if (from.node instanceof Dir) return { error: E.PERM };
      const onto = resolve(to);
      if (onto.node) return { error: E.EXIST };
      if (!onto.parent) return { error: onto.error };
      onto.parent.entries.set(onto.name!, from.node);
      report(to);
      return {};
    }
    case 'symlink': {
      const found = resolve(path);
      if (found.node) return { error: E.EXIST };
      if (!found.parent) return { error: found.error };
      found.parent.entries.set(found.name!, new Symlink(target));
      found.parent.mtime = now();
      report(path);
      return {};
    }
    case 'readlink': {
      const found = resolve(path);
      if (!found.node) return { error: found.error };
      if (!(found.node instanceof Symlink)) return { error: E.INVAL };
      return { target: found.node.target };
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
    let result: NodeAnswer;
    try {
      result = handle(request, bytes);
    } catch (error) {
      result = { error: E.IO, message: (error as Error).message };
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
  for (const keeper of keepers)
    if (!keeper.paused && keeper.dirty.size && performance.now() - keeper.saved > keeper.every)
      persist(keeper);
}

// Every file below `dir` (at `path`), but in directories named in `skip`.
function walkFiles(
  dir: Dir,
  path: string,
  visit: (path: string, node: File) => void,
  skip: string[] = [],
): void {
  for (const [name, node] of dir.entries) {
    if (skip.includes(name)) continue;
    if (node instanceof Dir) walkFiles(node, `${path}/${name}`, visit, skip);
    else if (node instanceof File) visit(`${path}/${name}`, node);
  }
}

// The page's requests (host/files.ts): the same filesystem, by message.
function page({
  id,
  op,
  path,
  to,
  target: link,
  skip = [],
  data,
  query,
  limit = 1000,
}: PageRequest): PageReply {
  // Symbolic links are followed, but by what removes or renames them.
  // Every request with a path needs it.
  const found = (
    path ? resolve(path, !['unlink', 'rmdir', 'remove', 'rename', 'symlink'].includes(op)) : null
  ) as Found;
  switch (op) {
    case 'list': {
      const entries: Entry[] = [];
      const walk = (dir: Dir, prefix: string) => {
        for (const [name, node] of dir.entries) {
          if (skip.includes(name)) continue;
          const full = `${prefix}/${name}`;
          // A symbolic link as what it names, not walked into (no cycles).
          const target = node instanceof Symlink ? lookup(root, dir, node.target).node : node;
          entries.push({ path: full, dir: target instanceof Dir });
          if (node instanceof Dir) walk(node, full);
        }
      };
      if (found.node instanceof Dir) walk(found.node, path === '/' ? '' : path);
      return { id, entries };
    }
    // Every match of `query` in the files below `path` (search.ts), in
    // the order of their paths.
    case 'search': {
      const expression = pattern(query!);
      if (typeof expression === 'string')
        return { id, hits: [], truncated: false, error: expression };
      const files: [string, File][] = [];
      if (found.node instanceof Dir)
        walkFiles(found.node, path, (file, node) => files.push([file, node]), skip);
      files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const hits: SearchHit[] = [];
      let truncated = false;
      for (const [file, node] of files) {
        // Not fetched only to be skipped.
        if (node.size > LARGEST) continue;
        load(node, fetchFile);
        hits.push(...searchFile(file, node.bytes, expression, limit + 1 - hits.length));
        if (hits.length > limit) {
          hits.length = limit;
          truncated = true;
          break;
        }
      }
      return { id, hits, truncated };
    }
    // What the project changed below /work over its template, but in
    // directories named in `skip` (builds, dependencies): the files it
    // added or wrote, with their bytes, and the template's it removed.
    case 'changes': {
      const files: { path: string; data: Uint8Array }[] = [];
      const present = new Set<string>();
      walkFiles(
        resolve('/work').node as Dir,
        '/work',
        (file, node) => {
          present.add(file);
          if (templateFiles.has(file) && !node.written) return;
          load(node, fetchFile);
          files.push({ path: file, data: node.bytes.slice() });
        },
        skip,
      );
      const removed = [...templateFiles].filter(
        (file) => !present.has(file) && !file.split('/').some((part) => skip.includes(part)),
      );
      return { id, changed: files, removed };
    }
    case 'stat':
      return {
        id,
        type: found.node instanceof Dir ? 'dir' : found.node instanceof File ? 'file' : null,
      };
    // POSIX's shape, with its error codes (as Node's fs has them).
    case 'lstat': {
      if (!found.node) return { id, error: `${path}: no such file`, code: 'ENOENT' };
      const node = found.node;
      return {
        id,
        type: node instanceof Dir ? 'dir' : 'file',
        size: node instanceof File ? node.size : 0,
        mtime: Number(node.mtime / 1000000n),
        ino: Number(node.ino),
      };
    }
    case 'readdir':
      if (!found.node) return { id, error: `${path}: no such directory`, code: 'ENOENT' };
      if (!(found.node instanceof Dir))
        return { id, error: `${path}: not a directory`, code: 'ENOTDIR' };
      return { id, names: [...found.node.entries.keys()] };
    case 'unlink':
      if (!found.node) return { id, error: `${path}: no such file`, code: 'ENOENT' };
      if (found.node instanceof Dir)
        return { id, error: `${path}: is a directory`, code: 'EISDIR' };
      found.parent!.entries.delete(found.name!);
      report(path);
      return { id };
    case 'rmdir':
      if (!found.node) return { id, error: `${path}: no such directory`, code: 'ENOENT' };
      if (!(found.node instanceof Dir))
        return { id, error: `${path}: not a directory`, code: 'ENOTDIR' };
      if (found.node.entries.size) return { id, error: `${path}: not empty`, code: 'ENOTEMPTY' };
      found.parent!.entries.delete(found.name!);
      report(path);
      return { id };
    case 'read': {
      if (!(found.node instanceof File))
        return { id, error: `${path}: not a file`, code: found.node ? 'EISDIR' : 'ENOENT' };
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
        found.parent.entries.set(found.name!, file);
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
      found.parent!.entries.delete(found.name!);
      report(path);
      return { id };
    case 'rename': {
      const result = handle({ op: 'rename', path, to } as NodeRequest);
      return result.error ? { id, error: `${path}: cannot rename` } : { id };
    }
    // A symbolic link at `path` to `target` (npm's bin links).
    case 'symlink': {
      const result = handle({ op: 'symlink', path, target: link } as NodeRequest);
      return result.error ? { id, error: `${path}: cannot link`, code: 'EEXIST' } : { id };
    }
  }
  return { id, error: `${op}: no such request` };
}

let loop: Promise<void> | null = null;

function keeperFor(
  prefixes: string[],
  store: overlays.Store,
  version: string,
  records: KeptRecord[],
  reports: boolean,
): Keeper {
  const whiteouts = new Set<string>(
    records.filter((record) => record.kind === 'gone').map((record) => record.path),
  );
  return {
    prefixes,
    store,
    version,
    whiteouts,
    dirty: new Map(),
    saving: null,
    saved: 0,
    every: reports ? 200 : 1000,
    report: reports,
    paused: null,
  };
}

onmessage = async ({ data }) => {
  if (data.kind === 'start') {
    try {
      // boots: the boot images to unpack (worker.js); template: the
      // directories below /work the project starts with, from the site's
      // files (/work/playground for a Phoenix project); store: the
      // IndexedDB database the project's changes are kept in, or
      // storePort: a port to the apex's (overlay.ts remote); sharedPort:
      // a port to /shared's, the user's for every project (or none);
      // archive: a gzipped tar's URL whose directories go below /work as a
      // template's (an embedder's app: docs/embed.md), their mtimes kept.
      const {
        site,
        boots: requestedBoots = ['boot'],
        template: given = [],
        archive = null,
        store = null,
        storePort = null,
        sharedPort = null,
      }: {
        // The site manifest: where the fs image is.
        site: SiteRef;
        boots?: string[];
        template?: string[];
        archive?: string | null;
        store?: string | null;
        storePort?: MessagePort | null;
        sharedPort?: MessagePort | null;
      } = data;
      const packages = new Site(site);
      const boots = packages.boots(requestedBoots);
      const [images, manifest, version, archived] = await Promise.all([
        Promise.all(boots.map((boot) => fetch(packages.boot(boot)).then((r) => r.arrayBuffer()))),
        packages.tree(),
        packages.fsVersion(),
        archive
          ? fetch(archive).then(async (r) => {
              if (!r.ok) throw new Error(`${archive}: ${r.status} ${r.statusText}`);
              return gunzip(new Uint8Array(await r.arrayBuffer()));
            })
          : null,
      ]);
      // The archive's top directories (/work/APP), a template's.
      const tops = archived
        ? [...new Set([...tarEntries(archived)].map(({ name }) => name.split('/')[0]))].filter(
            (name) => name && name !== '.' && name !== '..',
          )
        : [];
      const template = [...given, ...tops.map((name) => `/work/${name}`)];
      root = new Dir();
      const shared = (path: string) =>
        `/${path}`.startsWith('/tmp/') ||
        template.some((prefix) => `/${path}/`.startsWith(`${prefix}/`));
      mount(
        manifest.filter(([path]) => shared(path)),
        root,
      );
      // Gunzipped once: the nodes' workers start from these tars (the
      // page's Node.start), not from the site's gzipped images.
      const tars = await Promise.all(images.map((image) => gunzip(new Uint8Array(image))));
      for (const tar of tars) untarInto(tar, root, shared);
      if (archived) untarInto(archived, root.mkdirs('work'));
      for (const prefix of template) {
        const found = resolve(prefix);
        if (found.node instanceof Dir)
          walkFiles(found.node, prefix, (path) => templateFiles.add(path));
      }
      for (const prefix of SHARED) root.mkdirs(prefix);
      root.mkdirs('/home/user');
      const keeper = store
        ? await overlays.local(store)
        : storePort
          ? overlays.remote(storePort)
          : null;
      if (keeper) {
        let kept = await keeper.load();
        // Another site build: the template's own build is the new one, and
        // the project's sources recompile over it.
        if (kept.version && kept.version !== version.trim() && template.length) {
          for (const prefix of template) await keeper.drop(`${prefix}/_build`);
          kept = await keeper.load();
        }
        apply(kept.records);
        keepers.push(keeperFor(KEPT, keeper, version.trim(), kept.records, false));
      }
      if (sharedPort) {
        const sharedStore = overlays.remote(sharedPort);
        const records = (await sharedStore.load()).records;
        apply(records, false, true);
        keepers.push(keeperFor(KEPT_SHARED, sharedStore, '', records, true));
      }
      fetchFile = bundled((bundle) => fetchBundle(packages.bundle(bundle)));
      doorbell = new Int32Array(data.doorbell);
      // The boot images, gunzipped, and the manifest, for the page to start
      // nodes with; files.js keeps no tar (its files are copies).
      const boot = Object.fromEntries(boots.map((name, i) => [name, tars[i].buffer]));
      postMessage(
        { kind: 'ready', boot: { images: boot, manifest }, archived: tops },
        tars.map((tar) => tar.buffer),
      );
      loop ??= serve();
    } catch (error) {
      postMessage({ kind: 'failed', message: (error as Error).stack || String(error) });
    }
  } else if (data.kind === 'connect') {
    channels.push({
      control: new Int32Array(data.channel, 0, 2),
      data: new Uint8Array(data.channel, 8),
    });
  } else if (data.kind === 'disconnect') {
    const index = channels.findIndex((c) => c.control.buffer === data.channel);
    if (index >= 0) channels.splice(index, 1);
  } else if (data.kind === 'request' && data.op === 'flush') {
    await flush();
    postMessage({ kind: 'reply', id: data.id });
  } else if (data.kind === 'apply') {
    if (!overlays.sharedRecords(data.records)) return;
    // What another project kept in /shared (held while it is hidden).
    const keeper = keepers.find((each) => each.prefixes === KEPT_SHARED);
    if (keeper?.paused) keeper.paused.push(data.records);
    else apply(data.records, true, true);
  } else if (data.kind === 'request' && data.op === 'hide-shared') {
    await hideShared(Boolean(data.hide));
    postMessage({ kind: 'reply', id: data.id });
  } else if (data.kind === 'request') {
    let reply: PageReply;
    try {
      reply = page(data);
    } catch (error) {
      reply = { id: data.id, error: (error as Error).message };
    }
    const transfer = reply.data
      ? [reply.data.buffer]
      : (reply.changed ?? []).map((file) => file.data.buffer);
    postMessage({ kind: 'reply', ...reply }, transfer);
  }
};

// Answer nodes as they ring; let the page's messages in between.
async function serve(): Promise<void> {
  for (;;) {
    const started = performance.now();
    while (performance.now() - started < 20) {
      const rung = Atomics.load(doorbell, 0);
      answer();
      if (Atomics.wait(doorbell, 0, rung, 5) === 'timed-out') break;
    }
    answer();
    await new Promise((wake) => setTimeout(wake, 0));
  }
}
