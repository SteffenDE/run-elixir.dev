// The project as a repository (docs/git.md): its baseline commit, which the
// changes view diffs against, made with the IDE's own git (runtime/git.ts).
import type { GitOptions, GitOutput } from '@elixir-playground/runtime/host/git';
import { WORK } from '@/project/lib/store';
import { cloneUrl, type Repository } from '@/shared/lib/repository';

export type Run = (args: string[], options?: GitOptions) => Promise<GitOutput>;

// The commit a project started from: "All changes" are since it.
export const BASELINE = 'refs/playground/baseline';

// Who made the baseline: git commits nothing without a name.
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Playground',
  GIT_AUTHOR_EMAIL: 'playground@run-elixir.dev',
  GIT_COMMITTER_NAME: 'Playground',
  GIT_COMMITTER_EMAIL: 'playground@run-elixir.dev',
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function must(git: Run, args: string[], options?: GitOptions): Promise<string> {
  const { code, stdout, stderr } = await git(args, { cwd: WORK, ...options });
  if (code !== 0) throw new Error(`git ${args[0]}: ${text(stderr).trim() || `exit ${code}`}`);
  return text(stdout);
}

// A repository for a project that has files and none yet (a template's, a
// folder's, a project from before there was git): its files as they are,
// the first commit. An empty project stays as it is: `git clone URL .`
// takes an empty directory only, so it is git init's (or the changes
// view's) to start one.
export async function baseline(
  git: Run,
  stat: (path: string) => Promise<'file' | 'dir' | null>,
  list: (path: string) => Promise<unknown[]>,
): Promise<boolean> {
  if (await stat(`${WORK}/.git`)) return false;
  if (!(await list(WORK)).length) return false;
  await initialize(git);
  return true;
}

// git init, and the files there are as its first commit (the baseline),
// if there are any.
export async function initialize(git: Run): Promise<void> {
  await must(git, ['init', '-q', '-b', 'main']);
  await must(git, ['add', '-A']);
  const staged = await git(['diff', '--cached', '--quiet'], { cwd: WORK });
  if (staged.code === 0) return;
  await must(git, ['commit', '-q', '--no-verify', '-m', 'Baseline'], { env: IDENTITY });
  await must(git, ['update-ref', BASELINE, 'HEAD']);
}

// A repository's clone into the empty /work (a project made from it):
// shallow, as a look at a project wants (`git fetch --unshallow` brings the
// rest), its branch or tag if it names one. --depth implies one branch;
// the remote then tracks them all, as a full clone's does, so `git fetch
// origin BRANCH` and `git switch BRANCH` work (fetching only what is asked).
export async function clone(git: Run, repository: Repository): Promise<void> {
  const ref = repository.ref ? ['--branch', repository.ref] : [];
  await must(git, ['clone', '-q', '--depth', '1', ...ref, cloneUrl(repository), '.']);
  await must(git, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  await must(git, ['update-ref', BASELINE, 'HEAD']);
}
