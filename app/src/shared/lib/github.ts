// The user's GitHub token, for pushing a project's commits (docs/git.md#push):
// a fine-grained personal access token, kept on the apex with the user's
// settings but never among them. No project's code gets it: not in a
// node's environment or files, not in the frame that runs the project.
// Only this page's own requests to GitHub's REST API carry it (push.ts).
import { database } from './projects';

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
}

export interface GitHubToken {
  token: string;
  user: GitHubUser;
}

const KEY = 'github';
const API = 'https://api.github.com';

export class GitHubError extends Error {
  declare status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// A request to GitHub's REST API with the token: its JSON answer, or a
// GitHubError with GitHub's own message.
export async function github<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      credentials: 'omit',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new GitHubError(0, `GitHub could not be reached (${(error as Error).message})`);
  }
  const answer = (await response.json().catch(() => null)) as { message?: string } | null;
  if (!response.ok)
    throw new GitHubError(response.status, answer?.message ?? `GitHub answered ${response.status}`);
  return answer as T;
}

export async function loadGitHub(): Promise<GitHubToken | null> {
  const record = await database.settings.get(KEY).catch(() => undefined);
  return (record?.value as GitHubToken | undefined) ?? null;
}

// The token, once GitHub says whose it is.
export async function saveGitHub(token: string): Promise<GitHubToken> {
  const trimmed = token.trim();
  const user = await github<GitHubUser>(trimmed, 'GET', '/user').catch((error: GitHubError) => {
    throw new Error(error.status === 401 ? 'GitHub does not take this token.' : error.message);
  });
  const saved = { token: trimmed, user: { login: user.login, id: user.id, name: user.name } };
  await database.settings.put({ key: KEY, value: saved });
  return saved;
}

export async function forgetGitHub(): Promise<void> {
  await database.settings.delete(KEY);
}

// Who commits made for the user are by (when git has no identity of its
// own): their name, and GitHub's private address for them.
export const identity = ({ user }: GitHubToken) => ({
  name: user.name || user.login,
  email: `${user.id}+${user.login}@users.noreply.github.com`,
});
