// push.ts against a stand-in for GitHub's REST API (../fake-github.ts).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { person, personLine, push, pushTarget } from '@/project/lib/push';
import type { Run } from '@/project/lib/git';
import { fakeGitHub, sh } from '../fake-github';

// The store's and the templates' modules need a page (the build's <meta>).
const WORK = '/work';
vi.mock('@/project/lib/store', () => ({ WORK: '/work' }));
vi.mock('@/shared/lib/templates', () => ({ siteTemplate: async () => null }));

const TOKEN = { token: 't', user: { login: 'octo', id: 7, name: 'Octo Cat' } };
let dir: string;
let bare: string;
let work: string;
// How GitHub writes a commit's dates: as given, or in UTC (another commit).
let zones: 'kept' | 'utc';

const run: Run = async (args, options = {}) => {
  const cwd = (options.cwd ?? WORK).replace(WORK, work);
  const result = spawnSync('git', args, {
    cwd,
    input: options.stdin ?? undefined,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, ...options.env },
  });
  return {
    code: result.status ?? 1,
    stdout: new Uint8Array(result.stdout),
    stderr: new Uint8Array(result.stderr),
  };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'push-'));
  bare = join(dir, 'remote.git');
  work = join(dir, 'work');
  zones = 'kept';
  sh(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  vi.stubGlobal('fetch', vi.fn(fakeGitHub(bare, () => zones)));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

// The remote as a clone has it (GitHub's address, fetched from the bare one).
function cloned() {
  const seed = join(dir, 'seed');
  sh(dir, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'mix.exs'), 'defmodule A.MixProject do\nend\n');
  writeFileSync(join(seed, 'gone.txt'), 'bye\n');
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-q', '-m', 'First']);
  sh(seed, ['push', '-q', bare, 'main']);
  sh(dir, ['clone', '-q', bare, work]);
  sh(work, ['remote', 'set-url', 'origin', 'https://github.com/me/repo']);
  sh(work, ['config', `url.${bare}.insteadOf`, 'https://github.com/me/repo']);
}

const change = () => {
  writeFileSync(join(work, 'mix.exs'), 'defmodule A.MixProject do\n  # more\nend\n');
  writeFileSync(join(work, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  rmSync(join(work, 'gone.txt'));
  sh(work, ['add', '-A']);
  sh(work, ['commit', '-q', '-m', 'Second\n\nWith a body.'], undefined, {
    GIT_AUTHOR_DATE: '1761134400 +0200',
    GIT_COMMITTER_DATE: '1761134460 -0530',
  });
};

describe('push', () => {
  it('makes the same commits on GitHub', async () => {
    cloned();
    change();
    expect((await pushTarget(run)).ahead).toBe(1);
    const pushed = await push(run, TOKEN, null, () => {});
    const head = sh(work, ['rev-parse', 'HEAD']);
    expect(pushed).toMatchObject({ commits: 1, head, rewritten: false });
    expect(sh(bare, ['rev-parse', 'main'])).toBe(head);
    expect((await pushTarget(run)).ahead).toBe(0);
    // Again: nothing to push.
    expect((await push(run, TOKEN, null, () => {})).commits).toBe(0);
  });

  it('commits what changed first, as the GitHub user', async () => {
    cloned();
    writeFileSync(join(work, 'new.ex'), 'IO.puts(1)\n');
    expect((await pushTarget(run)).uncommitted).toBe(1);
    await push(run, TOKEN, 'Add new.ex', () => {});
    expect(sh(bare, ['log', '-1', '--format=%an <%ae> %s', 'main'])).toBe(
      'Octo Cat <7+octo@users.noreply.github.com> Add new.ex',
    );
    expect(sh(bare, ['rev-parse', 'main'])).toBe(sh(work, ['rev-parse', 'HEAD']));
  });

  it('refuses when GitHub has commits the project lacks', async () => {
    cloned();
    const other = join(dir, 'other');
    sh(dir, ['clone', '-q', bare, other]);
    writeFileSync(join(other, 'x'), 'x\n');
    sh(other, ['add', '-A']);
    sh(other, ['commit', '-q', '-m', 'Theirs']);
    sh(other, ['push', '-q', 'origin', 'main']);
    change();
    await expect(push(run, TOKEN, null, () => {})).rejects.toThrow(/Pull them first/);
  });

  it('fills an empty repository and a new branch', async () => {
    sh(dir, ['init', '-q', '-b', 'main', work]);
    writeFileSync(join(work, 'a.txt'), 'a\n');
    sh(work, ['add', '-A']);
    sh(work, ['commit', '-q', '-m', 'Baseline']);
    sh(work, ['remote', 'add', 'origin', 'https://github.com/me/repo']);
    await push(run, TOKEN, null, () => {});
    expect(sh(bare, ['rev-parse', 'main'])).toBe(sh(work, ['rev-parse', 'HEAD']));
    expect(sh(work, ['config', 'branch.main.merge'])).toBe('refs/heads/main');
    sh(work, ['switch', '-q', '-c', 'topic']);
    writeFileSync(join(work, 'b.txt'), 'b\n');
    sh(work, ['add', '-A']);
    sh(work, ['commit', '-q', '-m', 'Topic']);
    const pushed = await push(run, TOKEN, null, () => {});
    expect(pushed.commits).toBe(1);
    expect(sh(bare, ['rev-parse', 'topic'])).toBe(sh(work, ['rev-parse', 'HEAD']));
  });

  it('takes GitHub’s commits when it makes others', async () => {
    cloned();
    change();
    zones = 'utc';
    const before = sh(work, ['rev-parse', 'HEAD']);
    const pushed = await push(run, TOKEN, null, () => {});
    expect(pushed.rewritten).toBe(true);
    expect(pushed.head).not.toBe(before);
    expect(sh(work, ['rev-parse', 'HEAD'])).toBe(pushed.head);
    expect(sh(work, ['rev-parse', 'HEAD^{tree}'])).toBe(
      sh(work, [`rev-parse`, `${before}^{tree}`]),
    );
    expect((await pushTarget(run)).ahead).toBe(0);
  });

  it('asks for the history a shallow clone lacks', async () => {
    cloned();
    change();
    sh(work, ['push', '-q', 'origin', 'main']);
    rmSync(work, { recursive: true });
    sh(dir, ['clone', '-q', '--depth', '1', `file://${bare}`, work]);
    sh(work, ['remote', 'set-url', 'origin', 'https://github.com/me/repo']);
    writeFileSync(join(work, 'c.txt'), 'c\n');
    sh(work, ['add', '-A']);
    sh(work, ['commit', '-q', '-m', 'Third']);
    // GitHub's branch is gone (a new repository): its history goes too.
    sh(bare, ['update-ref', '-d', 'refs/heads/main']);
    await expect(push(run, TOKEN, null, () => {})).rejects.toThrow(/shallow clone/);
  });
});

describe('people and dates', () => {
  it('keeps the time zone both ways', () => {
    const line = 'A B <a@b.c> 1761134400 -0530';
    expect(person(line)).toEqual({
      name: 'A B',
      email: 'a@b.c',
      date: '2025-10-22T06:30:00-05:30',
    });
    expect(personLine(person(line))).toBe(line);
    expect(personLine({ name: 'A', email: 'a', date: '2025-10-22T12:00:00Z' })).toBe(
      'A <a> 1761134400 +0000',
    );
  });
});
