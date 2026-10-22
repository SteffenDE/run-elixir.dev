import { RiGithubLine } from '@remixicon/react';
import { useEffect, useState } from 'react';
import { forgetGitHub, loadGitHub, saveGitHub, type GitHubToken } from '@/shared/lib/github';

const NEW_TOKEN =
  'https://github.com/settings/personal-access-tokens/new?name=Elixir+Playground&description=Pushing+from+the+Elixir+Playground&contents=write';

// The token pushes go to GitHub with (github.ts): kept apart from the
// environment, so no project's code ever sees it.
export function GitHubSettings() {
  const [saved, setSaved] = useState<GitHubToken | null | undefined>(undefined);
  const [token, setToken] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void loadGitHub().then(setSaved), []);
  if (saved === undefined) return null;
  return (
    <>
      <h2>GitHub</h2>
      <p className="muted">
        Projects push their commits to GitHub with this token, from the Changes panel. It stays in
        this page: projects&rsquo; code and shells never see it, and <code>git push</code> in a
        shell does not use it.
      </p>
      {saved ? (
        <div className="settings-save">
          <RiGithubLine size={16} />
          <span>
            Pushing as <strong>{saved.user.login}</strong>
          </span>
          <button
            type="button"
            className="button"
            onClick={() => void forgetGitHub().then(() => setSaved(null))}
          >
            Remove token
          </button>
        </div>
      ) : (
        <form
          className="github-token"
          onSubmit={(event) => {
            event.preventDefault();
            setChecking(true);
            setError(null);
            saveGitHub(token).then(
              (kept) => {
                setChecking(false);
                setToken('');
                setSaved(kept);
              },
              (failure: Error) => {
                setChecking(false);
                setError(failure.message);
              },
            );
          }}
        >
          <p className="muted">
            Make a{' '}
            <a href={NEW_TOKEN} target="_blank" rel="noreferrer">
              fine-grained personal access token
            </a>{' '}
            for the repositories to push to, with <em>Contents</em> read and write access.
          </p>
          <div className="repository-import-row">
            <input
              className="text-field"
              type="password"
              aria-label="GitHub token"
              placeholder="github_pat_…"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <button type="submit" className="button" disabled={!token.trim() || checking}>
              {checking ? 'Checking…' : 'Add token'}
            </button>
          </div>
          {error && (
            <p className="project-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </>
  );
}
