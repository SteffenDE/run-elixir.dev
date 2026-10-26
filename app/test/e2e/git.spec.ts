// The remotes (github.com/tailwindlabs/heroicons, github.com/chrismccord/
// todo_trek) are bare repositories of this test's process, which answer the
// site's git proxy (../fake-github.ts): nothing goes to GitHub.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { routeRepository, sh } from '../fake-github';
import { expect, test } from './fixtures';
import { exists, newProject, prompted, readText, run, writeText } from './helpers';

const HEROICONS =
  '{:heroicons, github: "tailwindlabs/heroicons", tag: "v2.2.0", sparse: "optimized", app: false, compile: false, depth: 1}';

let dir = '';
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'git-'));
});
test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A new repository at `dir`/`name` with `files`, committed; its path.
function seed(name: string, files: Record<string, string>): string {
  const repo = join(dir, name);
  sh(dir, ['init', '-q', '-b', 'main', repo]);
  commit(repo, files, 'First');
  return repo;
}

function commit(repo: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  sh(repo, ['add', '.']);
  sh(repo, ['commit', '-q', '-m', message]);
}

// github.com/`repo` for the page: a bare clone of `from`, which also
// answers a want of any commit (as GitHub does: Mix fetches a lock's).
async function serve(page: Page, repo: string, from: string): Promise<void> {
  const bare = `${from}.git`;
  sh(dir, ['clone', '-q', '--bare', from, bare]);
  sh(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  await routeRepository(page.context(), repo, bare);
}

// heroicons: its icons in optimized/ and their sources in src/, tagged
// v2.2.0, with a commit after the tag.
async function heroicons(page: Page): Promise<void> {
  const repo = seed('heroicons', {
    'optimized/24/outline/academic-cap.svg': '<svg/>\n',
    'src/24/outline/academic-cap.svg': '<svg></svg>\n',
  });
  sh(repo, ['tag', '-a', 'v2.2.0', '-m', 'v2.2.0']);
  commit(repo, { 'README.md': 'Heroicons\n' }, 'After the tag');
  await serve(page, 'tailwindlabs/heroicons', repo);
}

// todo_trek: a Mix project whose main is a merge; the commit before it
// (its first parent).
async function todoTrek(page: Page): Promise<string> {
  const repo = seed('todo_trek', {
    'mix.exs': 'defmodule TodoTrek.MixProject do\n  # app: :todo_trek\nend\n',
  });
  sh(repo, ['switch', '-q', '-c', 'side']);
  commit(repo, { 'side.txt': 'side\n' }, 'Side');
  sh(repo, ['switch', '-q', 'main']);
  commit(repo, { 'main.txt': 'main\n' }, 'Main');
  const behind = sh(repo, ['rev-parse', 'HEAD']);
  sh(repo, ['merge', '-q', '--no-ff', '-m', 'Merge side', 'side']);
  await serve(page, 'chrismccord/todo_trek', repo);
  return behind;
}

test('mix deps.get fetches a git dependency, sparse, and again from the lock', async ({ page }) => {
  test.setTimeout(900_000);
  await heroicons(page);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mix new demo');
  const mix = await readText(page, '/work/demo/mix.exs');
  await writeText(
    page,
    '/work/demo/mix.exs',
    mix.replace(/defp deps do\n\s*\[/, `defp deps do\n    [${HEROICONS},`),
  );
  await run(page, 'cd demo');
  const icon = '/work/demo/deps/heroicons/optimized/24/outline/academic-cap.svg';

  const fetched = await run(page, 'mix deps.get');
  expect(fetched).toContain('heroicons');
  expect(fetched).not.toMatch(/error|failed/i);
  expect(await readText(page, icon)).toBe('<svg/>\n');
  // Sparse: only the optimized icons.
  expect(await exists(page, '/work/demo/deps/heroicons/src')).toBe(false);
  const lock = await readText(page, '/work/demo/mix.lock');
  expect(lock).toMatch(
    /"heroicons": \{:git, "https:\/\/github.com\/tailwindlabs\/heroicons.git", "[0-9a-f]{40}"/,
  );

  // Mix checks the checkout against the lock (rev-parse, config).
  const status = await run(page, 'mix deps');
  expect(status).toMatch(/locked at [0-9a-f]{7} \(tag: v2\.2\.0\)/);
  expect(status).not.toMatch(/lock mismatch|lock outdated|different/i);

  // From the lock's revision this time.
  await run(page, 'rm -r deps');
  expect(await run(page, 'mix deps.get')).not.toMatch(/error|failed/i);
  expect(await exists(page, icon)).toBe(true);
});

test('git clones a repository into the shell and pulls it forward', async ({ page }) => {
  test.setTimeout(300_000);
  const behind = await todoTrek(page);
  await newProject(page, 'empty');
  await prompted(page, 1);
  // Into the empty project itself.
  const cloned = await run(page, 'git clone git@github.com:chrismccord/todo_trek.git .');
  expect(cloned).toContain("Cloning into '.'...");
  expect(cloned).toMatch(/Receiving objects: 100% \(\d+\/\d+\),.* done\./);
  expect(await readText(page, '/work/mix.exs')).toContain('app: :todo_trek');
  const head = (await run(page, 'git rev-parse HEAD')).match(/[0-9a-f]{40}/)![0];
  expect(await run(page, 'git pull')).toContain('Already up to date.');

  // A branch behind its upstream (by its first parent) fast-forwards.
  await writeText(page, '/work/.git/refs/heads/main', `${behind}\n`);
  const pulled = await run(page, 'git pull');
  expect(pulled).toContain(`Updating ${behind.slice(0, 7)}..${head.slice(0, 7)}`);
  expect(pulled).toContain('Fast-forward');
  expect(await run(page, 'git rev-parse HEAD')).toContain(head);

  // Not empty any more; a host the proxy does not serve.
  expect(await run(page, 'git clone https://github.com/chrismccord/todo_trek.git .')).toContain(
    "fatal: destination path '.' already exists and is not an empty directory.",
  );
  expect(await run(page, 'git clone https://example.com/a/b.git')).toContain(
    'the playground fetches only from github.com, gitlab.com, codeberg.org',
  );
});

// git itself (git.wasm, tools/git/build.py) at the shell: what it does in its own
// process.
test("the shell's git is git's own: commits, diffs, branches and a rebase", async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mkdir repo && cd repo');
  expect(await run(page, 'git --version')).toContain('git version 2.56.0');
  await run(page, 'git init -q -b main');
  await run(page, 'git config user.name Ada && git config user.email ada@example.com');
  await writeText(page, '/work/repo/a.txt', 'one\n');
  await run(page, 'git add a.txt');
  await run(page, 'git commit -qm first');
  await writeText(page, '/work/repo/a.txt', 'one\ntwo\n');
  expect(await run(page, 'git status --porcelain')).toContain(' M a.txt');
  expect(await run(page, 'git diff')).toContain('+two');
  await run(page, 'git commit -qam second');
  await run(page, 'git switch -qc feature HEAD~1');
  await writeText(page, '/work/repo/b.txt', 'b\n');
  await run(page, 'git add b.txt && git commit -qm feature');
  await run(page, 'git rebase -q main');
  expect(await run(page, 'git log --format=%s')).toMatch(/feature\s+second\s+first/);
  expect(await readText(page, '/work/repo/a.txt')).toBe('one\ntwo\n');
  expect(await run(page, 'git status --short --branch')).toContain('## feature');

  // What git runs as processes of its own (processes.ts): a merge's
  // autostash, a worktree's branch, gc's pack-refs and pack-objects.
  await run(page, 'git switch -q main');
  await writeText(page, '/work/repo/a.txt', 'one\ntwo\nlocal\n');
  const merged = await run(page, 'git merge --autostash --no-edit feature');
  expect(merged).toContain('Applied autostash.');
  expect(await readText(page, '/work/repo/a.txt')).toBe('one\ntwo\nlocal\n');
  await run(page, 'git worktree add -q ../wt');
  expect(await run(page, 'git worktree list')).toMatch(/\/work\/wt\s+\w+ \[wt\]/);
  const gc = await run(page, 'git gc -q; git count-objects -v');
  expect(gc).toContain('count: 0');
  expect(gc).not.toMatch(/cannot run|error/);
  expect(await run(page, 'git log --format=%s | head -n 1')).toMatch(/^feature$/m);
});

// What git starts besides itself: its transport (the remote helper,
// git-remote.ts, through the site's proxy), an alias's `!` (sh -c) and a
// hook (a #!/bin/sh script), each a process.
test("git's remotes, aliases and hooks run as processes", async ({ page }) => {
  test.setTimeout(300_000);
  await todoTrek(page);
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(
    await run(page, 'git ls-remote https://github.com/chrismccord/todo_trek.git main'),
  ).toMatch(/^[0-9a-f]{40}\s+refs\/heads\/main$/m);
  await run(page, 'mkdir repo && cd repo && git init -q -b main');
  await run(page, 'git config user.name Ada && git config user.email ada@example.com');
  await run(page, 'git remote add origin git@github.com:chrismccord/todo_trek.git');
  const fetched = await run(
    page,
    'git fetch -q --depth 1 origin main && git log --oneline FETCH_HEAD',
  );
  expect(fetched).toMatch(/^[0-9a-f]{7,} /m);
  expect(fetched).not.toMatch(/fatal|error/);
  expect(await run(page, 'git push origin FETCH_HEAD:refs/heads/playground')).toContain(
    'push from the Changes panel',
  );

  await run(page, `git config alias.hi '!echo "hi from $(basename "$PWD")"'`);
  expect(await run(page, 'git hi')).toContain('hi from repo');
  // (No templates: no hooks directory.)
  await run(page, 'mkdir -p .git/hooks');
  await writeText(
    page,
    '/work/repo/.git/hooks/pre-commit',
    '#!/bin/sh\necho "hook saw $(git diff --cached --name-only)"\n',
  );
  await writeText(page, '/work/repo/a.txt', 'a\n');
  expect(await run(page, 'git add a.txt && git commit -qm hooked')).toContain('hook saw a.txt');
  await writeText(page, '/work/repo/.git/hooks/pre-commit', '#!/bin/sh\necho refused; exit 1\n');
  const refused = await run(page, 'git commit -q --allow-empty -m nope; echo "status $?"');
  expect(refused).toContain('refused');
  expect(refused).toContain('status 1');
  await run(page, 'rm .git/hooks/pre-commit');

  // A clone over file:// (--no-local): git-upload-pack, git.wasm as that
  // name, through sh -c.
  await run(
    page,
    'git init -q -b main /work/lib && git -C /work/lib -c user.name=Ada -c user.email=ada@example.com commit -q --allow-empty -m lib',
  );
  const cloned = await run(
    page,
    'git clone -q --no-local /work/lib /work/copy && git -C /work/copy log --format=%s',
  );
  expect(cloned).toMatch(/^lib$/m);
  expect(cloned).not.toMatch(/fatal|error/);

  // git submodule, a script of git's from /usr/libexec/git-core, and the
  // sed it runs (tools/sed/build.py); a local repository is file:// to it.
  await run(page, 'git commit -q --allow-empty -m base');
  const added = await run(
    page,
    'git -c protocol.file.allow=always submodule add -q /work/lib lib; echo "status $?"',
  );
  expect(added).toContain('status 0');
  expect(added).not.toMatch(/fatal|error|not found/);
  expect(await readText(page, '/work/repo/.gitmodules')).toBe(
    '[submodule "lib"]\n\tpath = lib\n\turl = /work/lib\n',
  );
  expect(await run(page, 'git submodule status')).toMatch(/^ [0-9a-f]{40} lib \(heads\/main\)$/m);
  await run(page, 'git commit -qm submodule');
  expect(
    await run(page, 'git -c protocol.file.allow=always submodule foreach git log --format=%s'),
  ).toMatch(/Entering 'lib'\s+lib/);
});
