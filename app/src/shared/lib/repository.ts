// A public repository a new project is cloned from (docs/git.md#opening-a-repository):
// its address as the user pastes it (https://github.com/OWNER/REPO, a
// /tree/REF of it, OWNER/REPO for GitHub's), and the site's own link to it,
// /github/OWNER/REPO[/tree/REF] (as a README's badge would have it).
// Only the hosts the site's proxy serves (git-remote.ts's PROXIED).

export interface Repository {
  host: 'github.com' | 'gitlab.com' | 'codeberg.org';
  owner: string;
  name: string;
  // A branch or tag; none: the default branch.
  ref?: string;
}

// The site's paths for each host.
const PATHS: Record<Repository['host'], string> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'codeberg.org': 'codeberg',
};

const NAME = /^[\w.-]+$/;

// OWNER, REPO and the rest of a path: a repository, if they name one.
function fromParts(host: Repository['host'], parts: string[]): Repository | null {
  const [owner, repo, ...rest] = parts.map((part) => decodeURIComponent(part));
  const name = repo?.replace(/\.git$/, '');
  if (!owner || !name || !NAME.test(owner) || !NAME.test(name) || name === '.' || name === '..')
    return null;
  // GitLab's /-/tree/REF, GitHub's and Codeberg's /tree/REF (Codeberg's
  // /src/branch/REF too); a ref may hold slashes.
  const at = rest[0] === '-' ? 1 : 0;
  let ref: string | undefined;
  if (rest[at] === 'tree' && rest.length > at + 1) ref = rest.slice(at + 1).join('/');
  else if (rest[at] === 'src' && ['branch', 'tag'].includes(rest[at + 1]) && rest.length > at + 2)
    ref = rest.slice(at + 2).join('/');
  else if (rest.length && !(rest.length === 1 && rest[0] === '')) return null;
  return ref ? { host, owner, name, ref } : { host, owner, name };
}

// What the user typed or pasted: a repository's address on one of the
// hosts, git's own forms of it, or OWNER/REPO (GitHub's).
export function parseRepository(text: string): Repository | null {
  const input = text.trim();
  const shorthand = /^([\w.-]+)\/([\w.-]+)$/.exec(input);
  if (shorthand) return fromParts('github.com', [shorthand[1], shorthand[2]]);
  const ssh = /^git@([\w.-]+):(.+)$/.exec(input);
  let url: URL;
  try {
    url = new URL(
      ssh ? `https://${ssh[1]}/${ssh[2]}` : /^\w+:/.test(input) ? input : `https://${input}`,
    );
  } catch {
    return null;
  }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.search || url.hash) return null;
  const host = url.hostname.replace(/^www\./, '') as Repository['host'];
  if (!(host in PATHS)) return null;
  return fromParts(host, url.pathname.split('/').filter(Boolean));
}

// The site's link to it: /github/OWNER/REPO[/tree/REF].
export function repositoryPath(repository: Repository): string {
  const ref = repository.ref
    ? `/tree/${repository.ref.split('/').map(encodeURIComponent).join('/')}`
    : '';
  return `/${PATHS[repository.host]}/${repository.owner}/${repository.name}${ref}`;
}

// A path of the site's (/github/…): the repository it opens, if any.
export function repositoryOfPath(pathname: string): Repository | null {
  const [top, ...parts] = pathname.split('/').filter(Boolean);
  const host = (Object.keys(PATHS) as Repository['host'][]).find((key) => PATHS[key] === top);
  return host ? fromParts(host, parts) : null;
}

export const isRepositoryPath = (name: string) => Object.values(PATHS).includes(name);

// What git clones (through the site's proxy: git-remote.ts).
export const cloneUrl = (repository: Repository) =>
  `https://${repository.host}/${repository.owner}/${repository.name}.git`;

// Where people look at it.
export function webUrl(repository: Repository): string {
  const base = `https://${repository.host}/${repository.owner}/${repository.name}`;
  if (!repository.ref) return base;
  if (repository.host === 'gitlab.com') return `${base}/-/tree/${repository.ref}`;
  if (repository.host === 'codeberg.org') return `${base}/src/branch/${repository.ref}`;
  return `${base}/tree/${repository.ref}`;
}

export const repositoryLabel = (repository: Repository) =>
  `${repository.owner}/${repository.name}${repository.ref ? ` (${repository.ref})` : ''}`;
