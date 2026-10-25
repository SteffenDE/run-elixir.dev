// A stand-in for GitHub's REST API (the part push.ts uses), for the tests: a
// bare repository made with the host's git, whose blobs, trees, commits and
// refs the API's requests make, as GitHub's would.
import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from '@playwright/test';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'A',
  GIT_AUTHOR_EMAIL: 'a@example.com',
  GIT_COMMITTER_NAME: 'A',
  GIT_COMMITTER_EMAIL: 'a@example.com',
};

export const sh = (cwd: string, args: string[], input?: string | Buffer, env = {}) =>
  execFileSync('git', args, { cwd, input, env: { ...process.env, ...IDENTITY, ...env } })
    .toString()
    .trim();

// "2026-10-22T14:00:00+02:00" → seconds and +0200.
function when(date: string): [number, string] {
  const zone = /([+-])(\d\d):(\d\d)$/.exec(date);
  return [Date.parse(date) / 1000, zone ? `${zone[1]}${zone[2]}${zone[3]}` : '+0000'];
}

function iso(seconds: number, zone: string): string {
  if (zone === '+0000') return `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`;
  const offset =
    (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3)));
  const local = new Date((seconds + offset * 60) * 1000).toISOString().slice(0, 19);
  return `${local}${zone.slice(0, 3)}:${zone.slice(3)}`;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function readCommit(bare: string, sha: string) {
  const text = sh(bare, ['cat-file', 'commit', sha]);
  const [head, ...message] = text.split('\n\n');
  const field = (key: string) =>
    head
      .split('\n')
      .filter((line) => line.startsWith(`${key} `))
      .map((line) => line.slice(key.length + 1));
  const who = (line: string) => {
    const [, name, email, seconds, zone] = /^(.*) <(.*)> (\d+) (.*)$/.exec(line)!;
    return { name, email, date: iso(Number(seconds), zone) };
  };
  return {
    sha,
    tree: { sha: field('tree')[0] },
    parents: field('parent').map((parent) => ({ sha: parent })),
    author: who(field('author')[0]),
    committer: who(field('committer')[0]),
    message: `${message.join('\n\n')}\n`,
  };
}

// GitHub's REST API, as push.ts uses it, over the bare repository `bare`.
// `zones`: how it writes a commit's dates, as given or in UTC (which makes
// other commits than the ones asked for).
export const fakeGitHub =
  (bare: string, zones: () => 'kept' | 'utc' = () => 'kept') =>
  async (url: string, init: RequestInit = {}): Promise<Response> => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : null;
    const path = pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const has = (ref: string) =>
      spawnSync('git', ['rev-parse', '-q', '--verify', ref], { cwd: bare }).status === 0;
    const refs = sh(bare, ['for-each-ref', '--format=%(refname)']);
    if (method === 'GET' && pathname === '/user')
      return json(200, { login: 'octo', id: 7, name: 'Octo Cat' });
    if (method === 'GET' && path === '') return json(200, { permissions: { push: true } });
    if (method === 'GET' && path.startsWith('/git/ref/heads/')) {
      if (!refs) return json(409, { message: 'Git Repository is empty.' });
      const ref = `refs/heads/${path.slice('/git/ref/heads/'.length)}`;
      return has(ref)
        ? json(200, { object: { sha: sh(bare, ['rev-parse', ref]) } })
        : json(404, { message: 'Not Found' });
    }
    if (refs === '' && path.startsWith('/git/'))
      return json(409, { message: 'Git Repository is empty.' });
    if (method === 'PUT' && path.startsWith('/contents/')) {
      const blob = sh(bare, ['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64'));
      const tree = sh(
        bare,
        ['mktree'],
        `100644 blob ${blob}\t${path.slice('/contents/'.length)}\n`,
      );
      const commit = sh(bare, ['commit-tree', tree, '-m', body.message]);
      sh(bare, ['update-ref', 'refs/heads/main', commit]);
      return json(201, {});
    }
    if (method === 'POST' && path === '/git/blobs')
      return json(201, {
        sha: sh(bare, ['hash-object', '-w', '--stdin'], Buffer.from(body.content, 'base64')),
      });
    if (method === 'POST' && path === '/git/trees') {
      const index = join(bare, 'fake-index');
      rmSync(index, { force: true });
      const env = { GIT_INDEX_FILE: index };
      if (body.base_tree) sh(bare, ['read-tree', body.base_tree], undefined, env);
      // A removal is mode 0 (update-index --index-info).
      const lines = body.tree.map((entry: { mode: string; sha: string | null; path: string }) =>
        entry.sha === null
          ? `0 ${'0'.repeat(40)}\t${entry.path}\n`
          : `${entry.mode} ${entry.sha}\t${entry.path}\n`,
      );
      sh(bare, ['update-index', '--index-info'], lines.join(''), env);
      return json(201, { sha: sh(bare, ['write-tree'], undefined, env) });
    }
    if (method === 'POST' && path === '/git/commits') {
      const line = (who: { name: string; email: string; date: string }) => {
        const [seconds, zone] = when(who.date);
        return `${who.name} <${who.email}> ${seconds} ${zones() === 'utc' ? '+0000' : zone}`;
      };
      const text = [
        `tree ${body.tree}`,
        ...body.parents.map((parent: string) => `parent ${parent}`),
        `author ${line(body.author)}`,
        `committer ${line(body.committer)}`,
        '',
        body.message,
      ].join('\n');
      return json(
        201,
        readCommit(bare, sh(bare, ['hash-object', '-t', 'commit', '-w', '--stdin'], text)),
      );
    }
    if (path.startsWith('/git/refs')) {
      const ref = method === 'POST' ? body.ref : `refs/${path.slice('/git/refs/'.length)}`;
      if (method === 'POST' && has(ref)) return json(422, { message: 'Reference already exists' });
      if (method === 'PATCH' && !has(ref))
        return json(422, { message: 'Reference does not exist' });
      if (method === 'PATCH' && !body.force) {
        const ff = spawnSync('git', ['merge-base', '--is-ancestor', ref, body.sha], { cwd: bare });
        if (ff.status !== 0) return json(422, { message: 'Update is not a fast forward' });
      }
      sh(bare, ['update-ref', ref, body.sha]);
      return json(200, {});
    }
    return json(404, { message: `no ${method} ${path}` });
  };

// git's smart HTTP (protocol v2) for the bare repository `bare`, as the
// site's proxy passes it on (/git/HOST/OWNER/REPO/…: git-remote.ts): `git
// upload-pack` answers, so a clone or fetch through it is git's own.
export function gitHttp(
  bare: string,
  url: string,
  method: string,
  body: Buffer | null,
): { status: number; contentType: string; body: Buffer } {
  const { pathname, searchParams } = new URL(url);
  const env = { ...process.env, GIT_PROTOCOL: 'version=2' };
  if (method === 'GET' && pathname.endsWith('/info/refs')) {
    const service = searchParams.get('service');
    if (service !== 'git-upload-pack')
      return { status: 403, contentType: 'text/plain', body: Buffer.from('fetching only') };
    const refs = execFileSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', bare], {
      env,
    });
    const header = '# service=git-upload-pack\n';
    const packet = `${(header.length + 4).toString(16).padStart(4, '0')}${header}0000`;
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: Buffer.concat([Buffer.from(packet), refs]),
    };
  }
  if (method === 'POST' && pathname.endsWith('/git-upload-pack'))
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: execFileSync('git', ['upload-pack', '--stateless-rpc', bare], {
        env,
        input: body ?? Buffer.alloc(0),
      }),
    };
  return { status: 404, contentType: 'text/plain', body: Buffer.from('not found') };
}

// github.com/`repo` (OWNER/REPO) for every page of `context`: the site's git
// proxy (/git/github.com/…, from the exec frame's workers) answered from
// `bare`, so nothing goes to GitHub.
export async function routeRepository(
  context: BrowserContext,
  repo: string,
  bare: string,
): Promise<void> {
  const path = repo.replace(/[.]/g, '\\.');
  await context.route(new RegExp(`/git/github\\.com/${path}(\\.git)?/`), async (route) => {
    const request = route.request();
    const answer = gitHttp(bare, request.url(), request.method(), request.postDataBuffer());
    await route.fulfill({
      status: answer.status,
      headers: { 'content-type': answer.contentType },
      body: answer.body,
    });
  });
}
