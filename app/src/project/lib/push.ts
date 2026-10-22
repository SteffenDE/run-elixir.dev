// Pushing a project's commits to GitHub (docs/git.md#push): not over git's
// protocol (the site's proxy would see the token), but with GitHub's REST
// API from this page, which holds the token (github.ts). The IDE's git
// (in the frame that runs the project) reads the commits; each one is made
// again on GitHub from the same blobs, trees and headers, so it gets the
// same id there, and the branch moves to the last one, fast-forward only.
import { github, GitHubError, identity, type GitHubToken } from '@/shared/lib/github';
import { parseRepository } from '@/shared/lib/repository';
import type { GitOptions } from '@/runtime/host/git';
import { WORK } from './store';
import type { Run } from './git';

const decoder = new TextDecoder();

class Git {
  declare run: Run;

  constructor(run: Run) {
    this.run = run;
  }

  async bytes(args: string[], options?: GitOptions): Promise<Uint8Array> {
    const { code, stdout, stderr } = await this.run(args, { cwd: WORK, ...options });
    if (code !== 0)
      throw new Error(`git ${args[0]}: ${decoder.decode(stderr).trim() || `exit ${code}`}`);
    return stdout;
  }

  async text(args: string[], options?: GitOptions): Promise<string> {
    return decoder.decode(await this.bytes(args, options));
  }

  // Its output's first line, or null when git says no (exit 1, a missing
  // key or ref).
  async maybe(args: string[]): Promise<string | null> {
    const { code, stdout } = await this.run(args, { cwd: WORK });
    return code === 0 ? decoder.decode(stdout).trim() : null;
  }

  async ok(args: string[]): Promise<boolean> {
    return (await this.run(args, { cwd: WORK })).code === 0;
  }
}

// Where the branch goes: the repository on GitHub its remote names.
export interface Target {
  branch: string;
  remote: string;
  // The branch there.
  merge: string;
  owner: string;
  name: string;
  // Files changed since the last commit (they are committed first).
  uncommitted: number;
  // Commits past the remote's branch as this project last heard of it
  // (null: it never has).
  ahead: number | null;
}

// What a push would do now, or why there is none.
export async function pushTarget(run: Run): Promise<Target> {
  const git = new Git(run);
  const branch = await git.maybe(['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!branch) throw new Error('No branch is checked out (a detached HEAD): git switch to one.');
  const remote = (await git.maybe(['config', `branch.${branch}.remote`])) ?? 'origin';
  // As written (get-url would apply the playground's insteadOf).
  const url = await git.maybe(['config', `remote.${remote}.url`]);
  if (!url)
    throw new Error(
      `The repository has no remote "${remote}". Add the GitHub repository to push to: git remote add ${remote} https://github.com/OWNER/REPO`,
    );
  const repository = parseRepository(url);
  if (!repository || repository.host !== 'github.com')
    throw new Error(`The remote "${remote}" is ${url}: only GitHub repositories can be pushed to.`);
  const merge = (await git.maybe(['config', `branch.${branch}.merge`]))?.replace(
    /^refs\/heads\//,
    '',
  );
  const status = await git.text(['status', '--porcelain', '-z']);
  // Renames come with their former path as a second entry.
  const entries = status.split('\0').filter(Boolean);
  let uncommitted = 0;
  for (let i = 0; i < entries.length; i++) {
    uncommitted++;
    if (/^R|^.R/.test(entries[i])) i++;
  }
  const target = merge ?? branch;
  const ahead = await git.maybe(['rev-list', '--count', `refs/remotes/${remote}/${target}..HEAD`]);
  return {
    branch,
    remote,
    merge: target,
    owner: repository.owner,
    name: repository.name,
    uncommitted,
    ahead: ahead === null ? null : Number(ahead),
  };
}

interface Header {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

// A commit object's headers and message.
function parseCommit(text: string): Header {
  const end = text.indexOf('\n\n');
  const head = end < 0 ? text : text.slice(0, end);
  const header: Header = { tree: '', parents: [], author: '', committer: '', message: '' };
  for (const line of head.split('\n')) {
    // A continued header (a signature's lines) starts with a space.
    if (line.startsWith(' ')) continue;
    const space = line.indexOf(' ');
    const [key, value] = [line.slice(0, space), line.slice(space + 1)];
    if (key === 'tree') header.tree = value;
    else if (key === 'parent') header.parents.push(value);
    else if (key === 'author') header.author = value;
    else if (key === 'committer') header.committer = value;
  }
  header.message = end < 0 ? '' : text.slice(end + 2);
  return header;
}

// "Name <email> SECONDS +HHMM" as GitHub's API takes a person, the date in
// the same time zone (so the commit it makes is the same object).
export function person(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-])(\d\d)(\d\d)$/.exec(line);
  if (!match) throw new Error(`a commit's person git cannot read: ${line}`);
  const [, name, email, seconds, sign, hours, minutes] = match;
  const offset = (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
  const local = new Date((Number(seconds) + offset * 60) * 1000).toISOString().slice(0, 19);
  return { name, email, date: `${local}${sign}${hours}:${minutes}` };
}

const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'commit';
  sha: string | null;
}

// A commit GitHub made, as its API answers.
interface MadeCommit {
  sha: string;
  message: string;
  tree: { sha: string };
  parents: { sha: string }[];
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
}

// A person and date of GitHub's as git writes them: "Name <email> SECONDS
// +HHMM" (GitHub's ISO date, in its own time zone or UTC).
export function personLine({ name, email, date }: MadeCommit['author']): string {
  const match = /([+-])(\d\d):(\d\d)$/.exec(date);
  const zone = match ? `${match[1]}${match[2]}${match[3]}` : '+0000';
  return `${name} <${email}> ${Math.floor(Date.parse(date) / 1000)} ${zone}`;
}

// GitHub's commit, written here too (its id checked): what this branch
// then points to, without fetching it (a private repository's cannot be).
async function keep(git: Git, made: MadeCommit): Promise<void> {
  const text = [
    `tree ${made.tree.sha}`,
    ...made.parents.map((parent) => `parent ${parent.sha}`),
    `author ${personLine(made.author)}`,
    `committer ${personLine(made.committer)}`,
    '',
    made.message,
  ].join('\n');
  const sha = (
    await git.text(['hash-object', '-t', 'commit', '-w', '--stdin'], {
      stdin: new TextEncoder().encode(text),
    })
  ).trim();
  if (sha !== made.sha)
    throw new Error(
      `GitHub made commit ${made.sha.slice(0, 7)}, which this project could not write as its own.`,
    );
}

export interface Pushed {
  commits: number;
  head: string;
  // GitHub made other commits than this project's (a signed one, say):
  // the branch here moved to them if they could be fetched.
  rewritten: boolean;
  url: string;
}

export type Progress = (text: string) => void;

// Commit what changed (with `message`), then push the branch.
export async function push(
  run: Run,
  token: GitHubToken,
  message: string | null,
  progress: Progress,
): Promise<Pushed> {
  const git = new Git(run);
  const target = await pushTarget(run);
  const { owner, name, remote, merge, branch } = target;
  const repo = `/repos/${owner}/${name}`;

  if (target.uncommitted && message !== null) {
    progress('Committing…');
    // git's own identity if it has one; else the GitHub user's.
    const known = await git.maybe(['config', 'user.email']);
    const { name: who, email } = identity(token);
    const env: Record<string, string> = known
      ? {}
      : {
          GIT_AUTHOR_NAME: who,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: who,
          GIT_COMMITTER_EMAIL: email,
        };
    await git.bytes(['add', '-A']);
    await git.bytes(['commit', '-q', '--no-verify', '-F', '-'], {
      env,
      stdin: new TextEncoder().encode(message),
    });
  }

  progress(`Asking GitHub about ${owner}/${name}…`);
  const about = await github<{ permissions?: { push?: boolean } }>(token.token, 'GET', repo).catch(
    (error: GitHubError) => {
      throw new Error(
        error.status === 404
          ? `GitHub has no repository ${owner}/${name} that your token can see.`
          : error.message,
      );
    },
  );
  if (about.permissions && !about.permissions.push)
    throw new Error(`Your token may not push to ${owner}/${name}.`);

  // The branch there: its commit, none (a new branch), or an empty repository.
  let tip: string | null = null;
  let empty = false;
  try {
    tip = (
      await github<{ object: { sha: string } }>(
        token.token,
        'GET',
        `${repo}/git/ref/heads/${merge}`,
      )
    ).object.sha;
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    if (error.status === 409) empty = true;
    else if (error.status !== 404) throw error;
  }

  const head = await git.text(['rev-parse', 'HEAD']).then((text) => text.trim());
  if (tip) {
    const known = async () => git.ok(['cat-file', '-e', `${tip}^{commit}`]);
    if (!(await known())) {
      progress(`Fetching ${merge}…`);
      await git.run(['fetch', '-q', remote, merge], { cwd: WORK });
      if (!(await known()))
        throw new Error(
          `${merge} on GitHub has commits this project does not have, and they could not be fetched. Pull them first: git pull ${remote} ${merge}`,
        );
    }
    if (!(await git.ok(['merge-base', '--is-ancestor', tip, 'HEAD'])))
      throw new Error(
        `${merge} on GitHub has commits this project does not have. Pull them first (git pull ${remote} ${merge}), then push.`,
      );
  }

  // What GitHub lacks, oldest first.
  const exclude = tip ? [`^${tip}`] : empty ? [] : ['--not', `--remotes=${remote}`];
  const list = (await git.text(['rev-list', '--reverse', '--topo-order', 'HEAD', ...exclude]))
    .split('\n')
    .filter(Boolean);
  if (!list.length && tip === head) {
    await git.run(['update-ref', `refs/remotes/${remote}/${merge}`, head], { cwd: WORK });
    return {
      commits: 0,
      head,
      rewritten: false,
      url: `https://github.com/${owner}/${name}/tree/${merge}`,
    };
  }

  // An empty repository takes no blobs or trees (409) until it has a
  // commit: one placeholder file, which the branch then leaves behind.
  if (empty) {
    progress('Starting the empty repository…');
    await github(token.token, 'PUT', `${repo}/contents/.playground`, {
      message: 'Start the repository',
      content: btoa('\n'),
      branch: merge,
    });
  }

  // Each commit's id here → GitHub's (the same, unless GitHub made it
  // otherwise).
  const made = new Map<string, string>();
  const uploaded = new Set<string>();
  for (const [index, commit] of list.entries()) {
    progress(`Pushing commit ${index + 1} of ${list.length}…`);
    const header = parseCommit(await git.text(['cat-file', 'commit', commit]));
    for (const parent of header.parents)
      if (!made.has(parent) && !(await git.ok(['cat-file', '-e', `${parent}^{commit}`])))
        throw new Error(
          `This project has only the latest commits of its history (a shallow clone), and GitHub needs the rest: git fetch --unshallow ${remote}, then push.`,
        );
    const parents = header.parents.map((parent) => made.get(parent) ?? parent);
    // What changed from its first parent (all of its files for a root commit).
    const entries: TreeEntry[] = [];
    if (header.parents.length) {
      const raw = (
        await git.text([
          'diff-tree',
          '-r',
          '-z',
          '--no-renames',
          '--no-commit-id',
          header.parents[0],
          commit,
        ])
      ).split('\0');
      for (let at = 0; at + 1 < raw.length; at += 2) {
        const [, mode, sha, status] = /^:\d+ (\d+) \w+ (\w+) (\w)/.exec(raw[at]) ?? [];
        if (!status) continue;
        const path = raw[at + 1];
        if (status === 'D') entries.push({ path, mode: '100644', type: 'blob', sha: null });
        else entries.push({ path, mode, type: mode === '160000' ? 'commit' : 'blob', sha });
      }
    } else {
      for (const line of (await git.text(['ls-tree', '-r', '-z', '--full-tree', commit])).split(
        '\0',
      )) {
        const [, mode, type, sha, path] = /^(\d+) (\w+) (\w+)\t(.*)$/s.exec(line) ?? [];
        if (path) entries.push({ path, mode, type: type === 'commit' ? 'commit' : 'blob', sha });
      }
    }
    for (const entry of entries) {
      if (entry.type !== 'blob' || !entry.sha || uploaded.has(entry.sha)) continue;
      const content = base64(await git.bytes(['cat-file', 'blob', entry.sha]));
      const blob = await github<{ sha: string }>(token.token, 'POST', `${repo}/git/blobs`, {
        content,
        encoding: 'base64',
      });
      if (blob.sha !== entry.sha) throw new Error(`GitHub stored ${entry.path} as another blob.`);
      uploaded.add(entry.sha);
    }
    // No change from its first parent (a merge's, an empty commit): the same tree.
    if (entries.length) {
      const base = header.parents.length
        ? (await git.text(['rev-parse', `${header.parents[0]}^{tree}`])).trim()
        : undefined;
      const tree = await github<{ sha: string }>(token.token, 'POST', `${repo}/git/trees`, {
        ...(base ? { base_tree: base } : {}),
        tree: entries,
      });
      if (tree.sha !== header.tree)
        throw new Error(`GitHub made another tree than commit ${commit.slice(0, 7)}'s.`);
    }
    const created = await github<MadeCommit>(token.token, 'POST', `${repo}/git/commits`, {
      message: header.message,
      tree: header.tree,
      parents,
      author: person(header.author),
      committer: person(header.committer),
    });
    // Another commit than this one (GitHub wrote its date or message
    // otherwise): the same here, so the branch can move to it.
    if (created.sha !== commit) await keep(git, created);
    made.set(commit, created.sha);
  }

  const pushed = made.get(head) ?? head;
  progress(`Moving ${merge}…`);
  const ref = `${repo}/git/refs/heads/${merge}`;
  if (tip) await github(token.token, 'PATCH', ref, { sha: pushed, force: false });
  else if (empty)
    // Past the placeholder's commit, which is not this branch's history (if
    // GitHub put it on its default branch instead, the branch is new).
    await github(token.token, 'PATCH', ref, { sha: pushed, force: true }).catch(() =>
      github(token.token, 'POST', `${repo}/git/refs`, { ref: `refs/heads/${merge}`, sha: pushed }),
    );
  else
    await github(token.token, 'POST', `${repo}/git/refs`, {
      ref: `refs/heads/${merge}`,
      sha: pushed,
    });

  // GitHub's commits instead of this branch's own, if it made others: the
  // same files, so only the branch moves.
  let rewritten = false;
  if (pushed !== head) {
    rewritten = true;
    const tree = (commit: string) => git.maybe(['rev-parse', `${commit}^{tree}`]);
    if ((await tree(pushed)) !== null && (await tree(pushed)) === (await tree(head)))
      await git.run(
        ['update-ref', '-m', 'push: GitHub’s commits', `refs/heads/${branch}`, pushed, head],
        { cwd: WORK },
      );
  }
  if (await git.ok(['cat-file', '-e', `${pushed}^{commit}`]))
    await git.run(['update-ref', `refs/remotes/${remote}/${merge}`, pushed], { cwd: WORK });
  // The branch follows GitHub's from now on (git status says how far).
  if (!(await git.maybe(['config', `branch.${branch}.remote`]))) {
    await git.run(['config', `branch.${branch}.remote`, remote], { cwd: WORK });
    await git.run(['config', `branch.${branch}.merge`, `refs/heads/${merge}`], { cwd: WORK });
  }
  return {
    commits: list.length,
    head: pushed,
    rewritten,
    url: `https://github.com/${owner}/${name}/commits/${merge}`,
  };
}
