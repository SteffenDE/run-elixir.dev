// A folder from the user's computer, as a new project: an empty project
// whose /work starts with the folder's files (the seed a shared link
// makes, share.ts). Builds and dependencies stay behind: they were made
// for another machine, and `mix deps.get` fetches what mix.exs asks for.
// What the folder's .gitignore files ignore stays behind too.
import { HIDDEN } from '@/project/lib/store';
import { Ignores } from './gitignore';
import { fileEntry, type Shared } from './share';

// What a project may start with, past what is left out: it is read into
// memory, kept in IndexedDB until the project starts, and then in the tree.
// The user leaves out more until it fits (FolderReview).
export const MOST_FILES = 5000;
export const MOST_BYTES = 64 * 1024 * 1024;
// What is listed at all: a folder far larger (someone's home) is not read
// to its end. Files are handles until opened, so listing costs little.
const MOST_LISTED = 100_000;

// Directories of editors' and tools' that a .gitignore often misses:
// offered, but left out unless the user takes them.
export const LEFT_OUT = ['.expert', '.lexical', '.elixir-tools', '.next-ls', 'cover'];

export interface Folder {
  name: string;
  // Path below the folder → its file (a handle: nothing is read yet).
  files: Map<string, File>;
}

const GITIGNORE = '.gitignore';

export function tooLarge(count: number, bytes: number): string | null {
  if (count > MOST_FILES) return `more than ${MOST_FILES} files`;
  if (bytes > MOST_BYTES) return `more than ${MOST_BYTES / 1024 / 1024} MB`;
  return null;
}

const FAR_TOO_LARGE = `The folder has more than ${MOST_LISTED} files, past _build, deps, node_modules and what .gitignore ignores. Is it a project’s?`;

const entries = (dir: FileSystemDirectoryEntry) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => {
    const reader = dir.createReader();
    const all: FileSystemEntry[] = [];
    // readEntries gives a batch at a time, until an empty one.
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });

const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

// A dropped folder (DataTransfer's items, read while the drop event runs).
export async function droppedFolder(items: DataTransferItemList): Promise<Folder> {
  const dropped = [...items].flatMap((item) => {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry() : null;
    return entry ? [entry] : [];
  });
  const dirs = dropped.filter((entry) => entry.isDirectory) as FileSystemDirectoryEntry[];
  if (dropped.length !== 1 || dirs.length !== 1)
    throw new Error('Drop one folder: the project’s, with its mix.exs.');
  const files = new Map<string, File>();
  const ignores = new Ignores();
  // Skipped directories are not read at all (deps and _build are large).
  const walk = async (dir: FileSystemDirectoryEntry, prefix: string) => {
    const all = await entries(dir);
    // The directory's own .gitignore first: it says what of the rest stays.
    const own = all.find((entry) => entry.isFile && entry.name === GITIGNORE);
    if (own)
      ignores.add(prefix.slice(0, -1), await (await fileOf(own as FileSystemFileEntry)).text());
    for (const entry of all) {
      const path = prefix + entry.name;
      if (HIDDEN.includes(entry.name) || ignores.ignored(path, entry.isDirectory)) continue;
      if (entry.isDirectory) await walk(entry as FileSystemDirectoryEntry, `${path}/`);
      else if (entry.isFile) {
        const file = await fileOf(entry as FileSystemFileEntry);
        files.set(path, file);
        if (files.size > MOST_LISTED) throw new Error(FAR_TOO_LARGE);
      }
    }
  };
  await walk(dirs[0], '');
  return { name: dirs[0].name, files };
}

// A folder chosen with <input type="file" webkitdirectory>: its files,
// each with its path from the folder's parent (all of them, the skipped
// ones too).
export async function chosenFolder(list: FileList): Promise<Folder> {
  const all = new Map<string, File>();
  let name = '';
  for (const file of list) {
    const [top, ...rest] = file.webkitRelativePath.split('/');
    name = top;
    const path = rest.join('/');
    if (path && !path.split('/').some((part) => HIDDEN.includes(part))) all.set(path, file);
  }
  const ignores = new Ignores();
  for (const [path, file] of all)
    if (path === GITIGNORE || path.endsWith(`/${GITIGNORE}`))
      ignores.add(path.slice(0, -GITIGNORE.length - 1), await file.text());
  // A path is ignored if a directory above it is (asked once each, from
  // the top, as a walk would).
  const dirs = new Map<string, boolean>();
  const dirIgnored = (dir: string): boolean => {
    if (!dir) return false;
    let ignored = dirs.get(dir);
    if (ignored === undefined) {
      const at = dir.lastIndexOf('/');
      ignored = dirIgnored(at < 0 ? '' : dir.slice(0, at)) || ignores.ignored(dir, true);
      dirs.set(dir, ignored);
    }
    return ignored;
  };
  const files = new Map<string, File>();
  for (const [path, file] of all) {
    const at = path.lastIndexOf('/');
    if (!dirIgnored(at < 0 ? '' : path.slice(0, at)) && !ignores.ignored(path, false))
      files.set(path, file);
  }
  if (files.size > MOST_LISTED) throw new Error(FAR_TOO_LARGE);
  return { name, files };
}

// WebKit (Safari, and every browser on iOS) hands over no files or
// directories whose names start with a dot, and no symlinks: the folder
// comes without its .gitignore, .formatter.exs and the like.
export const losesDotfiles = () =>
  /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent);

export const isMixProject = (folder: Folder) => folder.files.has('mix.exs');

// The folder's directories, for choosing what to leave out: each with the
// files below it, and their bytes; the files of a directory itself, as one.
export interface Tree {
  name: string;
  path: string;
  count: number;
  bytes: number;
  // Files directly in it.
  own: number;
  ownBytes: number;
  dirs: Tree[];
}

export function folderTree(folder: Folder): Tree {
  const root: Tree = {
    name: folder.name,
    path: '',
    count: 0,
    bytes: 0,
    own: 0,
    ownBytes: 0,
    dirs: [],
  };
  const byPath = new Map<string, Tree>([['', root]]);
  const dirOf = (path: string): Tree => {
    let dir = byPath.get(path);
    if (!dir) {
      const at = path.lastIndexOf('/');
      const parent = dirOf(at < 0 ? '' : path.slice(0, at));
      dir = { name: path.slice(at + 1), path, count: 0, bytes: 0, own: 0, ownBytes: 0, dirs: [] };
      parent.dirs.push(dir);
      byPath.set(path, dir);
    }
    return dir;
  };
  for (const [path, file] of folder.files) {
    const at = path.lastIndexOf('/');
    const dir = dirOf(at < 0 ? '' : path.slice(0, at));
    dir.own += 1;
    dir.ownBytes += file.size;
    for (let up: string | null = dir.path; up !== null;) {
      const above = byPath.get(up)!;
      above.count += 1;
      above.bytes += file.size;
      up = up ? (up.includes('/') ? up.slice(0, up.lastIndexOf('/')) : '') : null;
    }
  }
  // The largest first: by what they take of the limits, files or bytes.
  const share = (dir: Tree) => Math.max(dir.count / MOST_FILES, dir.bytes / MOST_BYTES);
  const sort = (dir: Tree) => {
    dir.dirs.sort((a, b) => share(b) - share(a) || a.name.localeCompare(b.name));
    dir.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

// What is left out at first: the tools' directories and files (LEFT_OUT),
// at any depth.
export function leftOutAtFirst(folder: Folder): Set<string> {
  const out = new Set<string>();
  for (const path of folder.files.keys()) {
    const parts = path.split('/');
    const at = parts.findIndex((part) => LEFT_OUT.includes(part));
    if (at >= 0) out.add(parts.slice(0, at + 1).join('/'));
  }
  return out;
}

// The folder without the paths left out (directories, with all below them,
// or files).
export function without(folder: Folder, out: Set<string>): Folder {
  if (!out.size) return folder;
  const files = new Map<string, File>();
  for (const [path, file] of folder.files) {
    let kept = !out.has(path);
    for (let at = path.indexOf('/'); kept && at >= 0; at = path.indexOf('/', at + 1))
      kept = !out.has(path.slice(0, at));
    if (kept) files.set(path, file);
  }
  return { name: folder.name, files };
}

// The folder as a seed: its files at /work, the project named after it.
export async function folderShared(folder: Folder): Promise<Shared> {
  const files: Shared['files'] = {};
  for (const [path, file] of folder.files)
    files[path] = fileEntry(new Uint8Array(await file.arrayBuffer()));
  return { v: 1, kind: 'empty', name: folder.name, site: '', files, removed: [] };
}
