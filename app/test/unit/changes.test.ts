import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changes, parseBatch, type Run } from '@/project/lib/changes';
import { BASELINE } from '@/project/lib/git';

// The host's git over a directory of its own, as the IDE's would over /work.
let dir = '';
const git: Run = async (args, { env = {}, stdin } = {}) => {
  const mapped = Object.fromEntries(
    Object.entries(env).map(([name, value]) => [name, value.replace(/^\/work/, dir)]),
  );
  const result = spawnSync('git', args, {
    cwd: dir,
    env: { ...process.env, ...mapped, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    input: stdin,
  });
  return {
    code: result.status ?? 1,
    stdout: new Uint8Array(result.stdout),
    stderr: new Uint8Array(result.stderr),
  };
};
const sh = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'changes-'));
  sh('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'lib'));
  writeFileSync(join(dir, 'lib/a.ex'), 'one\ntwo\nthree\n');
  writeFileSync(join(dir, 'old.txt'), 'moved along\nwith lines\nenough to match\n');
  writeFileSync(join(dir, 'gone.txt'), 'bye\n');
  writeFileSync(join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 0]));
  writeFileSync(join(dir, '.gitignore'), '/_build/\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'Baseline');
  sh('update-ref', BASELINE, 'HEAD');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('changes', () => {
  it('lists edits, new, deleted, renamed and binary files against the baseline', async () => {
    writeFileSync(join(dir, 'lib/a.ex'), 'one\n2\nthree\n');
    writeFileSync(join(dir, 'new.ex'), 'héllo\n');
    unlinkSync(join(dir, 'gone.txt'));
    renameSync(join(dir, 'old.txt'), join(dir, 'new.txt'));
    writeFileSync(join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3, 0]));
    mkdirSync(join(dir, '_build'));
    writeFileSync(join(dir, '_build/x'), 'ignored');

    const found = await changes(git, 'all');
    const byName = Object.fromEntries(found.diffs.map((diff) => [diff.name, diff]));
    expect(Object.keys(byName).sort()).toEqual(
      ['lib/a.ex', 'logo.bin', 'new.ex', 'new.txt'].concat('gone.txt').sort(),
    );
    expect(byName['lib/a.ex'].type).toBe('change');
    expect(byName['lib/a.ex'].hunks).toHaveLength(1);
    // Both files whole.
    expect(byName['lib/a.ex'].isPartial).toBe(false);
    expect(byName['lib/a.ex'].additionLines.join('')).toBe('one\n2\nthree\n');
    expect(byName['new.ex'].type).toBe('new');
    expect(byName['new.ex'].additionLines.join('')).toBe('héllo\n');
    expect(byName['gone.txt'].type).toBe('deleted');
    expect(byName['new.txt']).toMatchObject({ type: 'rename-pure', prevName: 'old.txt' });
    expect(byName['logo.bin'].hunks).toHaveLength(0);
    const stats = Object.fromEntries(found.changes.map((c) => [(c.after ?? c.before)!.path, c]));
    expect(stats['lib/a.ex']).toMatchObject({ added: 1, removed: 1, binary: false });
    expect(stats['logo.bin'].binary).toBe(true);

    // The user's index is theirs.
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir }).toString()).toBe(
      '',
    );
  });

  it('keeps an unchanged file the same object, and diffs uncommitted against HEAD', async () => {
    writeFileSync(join(dir, 'lib/a.ex'), 'one\n2\nthree\n');
    const first = await changes(git, 'all');
    writeFileSync(join(dir, 'gone.txt'), 'still here\n');
    const second = await changes(git, 'all');
    const a = (list: typeof first) => list.diffs.find((diff) => diff.name === 'lib/a.ex');
    expect(a(second)).toBe(a(first));

    sh('commit', '-qam', 'Two');
    expect((await changes(git, 'uncommitted')).diffs).toEqual([]);
    expect((await changes(git, 'all')).diffs.map((diff) => diff.name).sort()).toEqual([
      'gone.txt',
      'lib/a.ex',
    ]);
  });

  it('keeps a committed script executable where files have no executable bit', async () => {
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n');
    sh('update-index', '--add', '--chmod=+x', 'run.sh');
    sh('commit', '-q', '-m', 'Script');
    // As git.wasm sees the files (no mode bits), from an index of its own.
    sh('config', 'core.filemode', 'false');
    sh('update-index', '--chmod=-x', 'run.sh');
    sh('reset', '-q');
    const found = await changes(git, 'uncommitted');
    expect(found.changes).toEqual([]);
    // Moved on (another HEAD): the index starts from that one.
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho\n');
    sh('commit', '-q', '-am', 'More');
    expect((await changes(git, 'uncommitted')).changes).toEqual([]);
  });

  it('diffs a repository with no commit against the empty tree', async () => {
    rmSync(join(dir, '.git'), { recursive: true });
    sh('init', '-q');
    const found = await changes(git, 'all');
    expect(found.diffs.map((diff) => diff.type)).toEqual(['new', 'new', 'new', 'new', 'new']);
  });
});

describe('parseBatch', () => {
  it('reads objects by their byte sizes', () => {
    const bytes = new TextEncoder().encode('aa blob 3\nhé\n\nbb missing\ncc blob 0\n\n');
    const objects = parseBatch(bytes);
    expect(new TextDecoder().decode(objects.get('aa'))).toBe('hé');
    expect(objects.has('bb')).toBe(false);
    expect(objects.get('cc')?.length).toBe(0);
  });
});
