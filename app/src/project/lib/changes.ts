// The project's changes (docs/git.md, the changes view): the files as they
// are, snapshot as a tree with an index of the IDE's own (the user's
// .git/index stays theirs, and untracked files are new files), against a
// base, with both sides' contents whole, so a diff shows any of its file.
import { processFile, type ChangeTypes, type FileDiffMetadata } from '@pierre/diffs';
import type { GitOptions, GitOutput } from '@/runtime/host/git';
import { BASELINE } from '@/project/lib/git';
import { WORK } from '@/project/lib/store';

export type Run = (args: string[], options?: GitOptions) => Promise<GitOutput>;

// Since the baseline, or since the last commit; the same until one.
export type Base = 'all' | 'uncommitted';

// A file as one side has it.
export interface Entry {
  path: string;
  mode: string;
  id: string;
}

// One file's change, as git lists it.
export interface Change {
  type: ChangeTypes;
  before: Entry | null;
  after: Entry | null;
  added: number;
  removed: number;
  binary: boolean;
}

export interface Changes {
  base: string;
  tree: string;
  changes: Change[];
  diffs: FileDiffMetadata[];
}

// The IDE's index (GIT_INDEX_FILE): its stat cache makes a snapshot hash
// only what changed since the last.
export const INDEX = `${WORK}/.git/playground-index`;

// What the IDE's own snapshot writes, which is no change of the user's.
export const ours = (path: string) =>
  path.startsWith(INDEX) || path.startsWith(`${WORK}/.git/objects/`);

// Contents past this many bytes are not shown (as git's own diff would
// not be read).
const LARGEST = 1 << 20;

const NULL_MODE = '000000';
const SUBMODULE = '160000';

const decoder = new TextDecoder();
const text = (bytes: Uint8Array) => decoder.decode(bytes);

async function must(git: Run, args: string[], options?: GitOptions): Promise<GitOutput> {
  const output = await git(args, { cwd: WORK, ...options });
  if (output.code !== 0)
    throw new Error(`git ${args[0]}: ${text(output.stderr).trim() || `exit ${output.code}`}`);
  return output;
}

// The commit `base` names, else the empty tree (a repository with no
// commit yet).
async function resolveBase(git: Run, base: Base): Promise<string> {
  for (const ref of base === 'all' ? [BASELINE, 'HEAD'] : ['HEAD']) {
    const { code, stdout } = await git(['rev-parse', '--verify', '-q', `${ref}^{commit}`], {
      cwd: WORK,
    });
    if (code === 0) return text(stdout).trim();
  }
  const empty = await must(git, ['hash-object', '-t', 'tree', '--stdin'], { stdin: '' });
  return text(empty.stdout).trim();
}

// The commit the IDE's index last started from (seedSnapshots forgets it).
let seeded: string | null = null;

// A project's first snapshot seeds the index again (another project's may
// have had the same HEAD).
export function seedSnapshots(): void {
  seeded = null;
}

// The files as they are, as a tree (what .gitignore leaves out is not in it).
// git.wasm has no executable bit (core.filemode is false), so a file new to
// an index takes the mode of the entry it replaces, or 100644: the index
// starts from HEAD's entries whenever HEAD moves, so a script stays 100755.
// --reset, as its entries may be stale against the files (after a checkout);
// the stat cache of those that still match is kept.
async function snapshot(git: Run): Promise<string> {
  const env = { GIT_INDEX_FILE: INDEX };
  const head = await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: WORK });
  const id = head.code === 0 ? text(head.stdout).trim() : null;
  if (id && id !== seeded) {
    await must(git, ['read-tree', '--reset', id], { env });
    seeded = id;
  }
  await must(git, ['add', '-A'], { env });
  return text((await must(git, ['write-tree'], { env })).stdout).trim();
}

// `git diff --raw --numstat --patch -z`: the raw records, the numstat
// records (one each, in the same order), both NUL-separated, then the
// patch:
//
//     :<mode> <mode> <id> <id> <status>\0<path>\0
//     :<mode> <mode> <id> <id> R<score>\0<from>\0<to>\0
//     <added>\t<removed>\t<path>\0
//     <added>\t<removed>\t\0<from>\0<to>\0
//     diff --git a/<path> b/<path>
//
// A binary file's counts are "-". Read token by token, as a path may look
// like anything.
export function parseRaw(output: string): { changes: Change[]; patch: string } {
  const listed: Change[] = [];
  let at = 0;
  const token = () => {
    const end = output.indexOf('\0', at);
    const value = output.slice(at, end === -1 ? output.length : end);
    at = end === -1 ? output.length : end + 1;
    return value;
  };
  while (output[at] === ':') {
    const [fromMode, toMode, fromId, toId, status] = token().slice(1).split(' ');
    const from = status.startsWith('R') || status.startsWith('C') ? token() : undefined;
    const path = token();
    const renamed = status.startsWith('R');
    listed.push({
      type: renamed
        ? fromId === toId
          ? 'rename-pure'
          : 'rename-changed'
        : fromMode === NULL_MODE
          ? 'new'
          : toMode === NULL_MODE
            ? 'deleted'
            : 'change',
      before: fromMode === NULL_MODE ? null : { path: from ?? path, mode: fromMode, id: fromId },
      after: toMode === NULL_MODE ? null : { path, mode: toMode, id: toId },
      added: 0,
      removed: 0,
      binary: false,
    });
  }
  for (const change of listed) {
    const [added, removed, path] = token().split('\t');
    if (path === '') {
      token();
      token();
    }
    change.binary = added === '-';
    change.added = change.binary ? 0 : Number(added);
    change.removed = change.binary ? 0 : Number(removed);
  }
  // An extra NUL between the records and the patch.
  if (output[at] === '\0') at++;
  return { changes: listed, patch: output.slice(at) };
}

// The patch per file, by the ids it compares (its `index` line). Every
// line of a hunk starts with a space, + or -, so a line that starts
// `diff --git ` is a file's header (not so with --binary, unused).
export function splitPatch(patch: string): Map<string, string> {
  const BREAK = '\ndiff --git ';
  const INDEX_LINE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m;
  const present = (id: string) => (/[^0]/.test(id) ? id : '');
  const patches = new Map<string, string>();
  let at = 0;
  while (at < patch.length) {
    const next = patch.indexOf(BREAK, at);
    const end = next === -1 ? patch.length : next + 1;
    const one = patch.slice(at, end);
    const match = INDEX_LINE.exec(one);
    if (match) patches.set(`${present(match[1])}:${present(match[2])}`, one);
    at = end;
  }
  return patches;
}

// `git cat-file --batch`: `<id> blob <size>\n<bytes>\n` each, by their
// byte sizes; a missing object's `<id> missing\n`.
export function parseBatch(output: Uint8Array): Map<string, Uint8Array> {
  const objects = new Map<string, Uint8Array>();
  let at = 0;
  while (at < output.length) {
    const end = output.indexOf(10, at);
    if (end === -1) break;
    const [id, type, size] = text(output.subarray(at, end)).split(' ');
    at = end + 1;
    if (type === 'missing' || size === undefined) continue;
    objects.set(id, output.subarray(at, at + Number(size)));
    at += Number(size) + 1;
  }
  return objects;
}

const cacheKey = (entry: Entry | null) => `${entry?.id ?? ''}:${entry?.path ?? '/dev/null'}`;

// What the view shows for a change: its hunks over both files whole, or
// none (a binary file, a pure rename, a mode change, a file too large).
function diffOf(change: Change, patch: string | undefined, contents: Map<string, string>) {
  const name = (change.after ?? change.before)!.path;
  const metadata = {
    name,
    prevName: change.type.startsWith('rename') ? change.before?.path : undefined,
    type: change.type,
    prevObjectId: change.before?.id,
    newObjectId: change.after?.id,
    mode: change.after?.mode ?? change.before?.mode,
    prevMode:
      change.before && change.after && change.before.mode !== change.after.mode
        ? change.before.mode
        : undefined,
  };
  const side = (entry: Entry | null) =>
    entry === null
      ? ''
      : entry.mode === SUBMODULE
        ? `Subproject commit ${entry.id}\n`
        : contents.get(entry.id);
  const before = side(change.before);
  const after = side(change.after);
  if (patch && before !== undefined && after !== undefined) {
    const diff = processFile(patch, {
      oldFile: {
        name: change.before?.path ?? '/dev/null',
        contents: before,
        cacheKey: cacheKey(change.before),
      },
      newFile: {
        name: change.after?.path ?? '/dev/null',
        contents: after,
        cacheKey: cacheKey(change.after),
      },
      cacheKey: `${cacheKey(change.before)}|${cacheKey(change.after)}`,
    });
    if (diff) return Object.assign(diff, metadata);
  }
  const empty: FileDiffMetadata = {
    ...metadata,
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    // Nothing shown, which is not to say the file is empty.
    isPartial: true,
    additionLines: [],
    deletionLines: [],
    additionCharacterCount: 0,
    deletionCharacterCount: 0,
  };
  return empty;
}

// Diffs by what they compare, and contents by object: a file unchanged
// since the last time is the same object again, so the view keeps it as
// it was rendered.
const diffs = new Map<string, FileDiffMetadata>();
const contents = new Map<string, string>();
const remember = <T>(map: Map<string, T>, key: string, value: T, limit: number) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
};

// The changes since `base` (its commit, or the empty tree).
export async function changes(git: Run, base: Base): Promise<Changes> {
  const from = await resolveBase(git, base);
  const tree = await snapshot(git);
  const listed = await must(git, [
    'diff',
    from,
    tree,
    '--raw',
    '--numstat',
    '--patch',
    '-z',
    '--full-index',
    '--no-abbrev',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--no-relative',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    '--find-renames',
  ]);
  const { changes: found, patch } = parseRaw(text(listed.stdout));
  const patches = splitPatch(patch);
  const key = (change: Change) =>
    [
      change.type,
      change.before?.mode,
      change.after?.mode,
      cacheKey(change.before),
      cacheKey(change.after),
    ].join('|');
  // The objects of the changes not already diffed, but not a binary's.
  const wanted = new Set<string>();
  for (const change of found)
    if (!change.binary && !diffs.has(key(change)))
      for (const entry of [change.before, change.after])
        if (entry && entry.mode !== SUBMODULE && !contents.has(entry.id)) wanted.add(entry.id);
  if (wanted.size) {
    const batch = await must(git, ['cat-file', '--batch'], {
      stdin: `${[...wanted].join('\n')}\n`,
    });
    for (const [id, bytes] of parseBatch(batch.stdout))
      if (bytes.length <= LARGEST) remember(contents, id, text(bytes), 400);
  }
  const shown = found.map((change) => {
    const known = diffs.get(key(change));
    if (known) return known;
    const ids = (entry: Entry | null) => (entry ? entry.id.replace(/^0+$/, '') : '');
    const diff = change.binary
      ? diffOf(change, undefined, contents)
      : diffOf(change, patches.get(`${ids(change.before)}:${ids(change.after)}`), contents);
    remember(diffs, key(change), diff, 200);
    return diff;
  });
  return { base: from, tree, changes: found, diffs: shown };
}
