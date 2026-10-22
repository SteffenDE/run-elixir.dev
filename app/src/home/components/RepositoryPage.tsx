import { RiGitRepositoryLine } from '@remixicon/react';
import { useEffect, useState } from 'react';
import { navigate } from '@/shared/lib/navigate';
import { cloneProject } from '@/shared/lib/projects';
import { repositoryLabel, webUrl, type Repository } from '@/shared/lib/repository';
import { apexUrl, projectUrl } from '@/shared/lib/site';

interface About {
  description: string | null;
  // Not there, or not public (the proxy clones public ones only).
  missing: boolean;
}

// What the host's API says of it (each sends CORS headers; without a
// token, GitHub's allows 60 requests an hour per address): null if it
// could not be asked.
async function about(repository: Repository): Promise<About | null> {
  const { host, owner, name } = repository;
  const url =
    host === 'github.com'
      ? `https://api.github.com/repos/${owner}/${name}`
      : host === 'gitlab.com'
        ? `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${owner}/${name}`)}`
        : `https://codeberg.org/api/v1/repos/${owner}/${name}`;
  const response = await fetch(url, { credentials: 'omit' }).catch(() => null);
  if (!response) return null;
  if (response.status === 404) return { description: null, missing: true };
  if (!response.ok) return null;
  const body = (await response.json().catch(() => ({}))) as {
    description?: string | null;
    private?: boolean;
  };
  return { description: body.description || null, missing: body.private === true };
}

// /github/OWNER/REPO[/tree/REF] (and /gitlab/…, /codeberg/…): a public
// repository, and a new project cloned from it.
export function RepositoryPage({ repository }: { repository: Repository }) {
  const [known, setKnown] = useState<About | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${repository.owner}/${repository.name} · Elixir Playground`;
    void about(repository).then(setKnown);
  }, [repository]);

  return (
    <div className="home">
      <main className="home-main">
        <h1 className="home-title">
          Elixir <span>Playground</span>
        </h1>
        <h2>Repository</h2>
        <p className="import-title">
          <RiGitRepositoryLine size={16} />
          <strong>{repositoryLabel(repository)}</strong>{' '}
          <a className="chip" href={webUrl(repository)} target="_blank" rel="noreferrer">
            {repository.host}
          </a>
        </p>
        {known?.description && <p>{known.description}</p>}
        {known?.missing && (
          <p className="project-error">
            {repository.host} has no public repository by that name. The playground clones public
            repositories only.
          </p>
        )}
        <p className="muted">
          A new project gets its files (the latest commit, without the history before it) and runs
          its code in this tab. It asks before it takes your settings.
        </p>
        {error && <p className="project-error">{error}</p>}
        <p className="elsewhere-actions">
          <button
            type="button"
            className="button primary"
            disabled={opening || known?.missing}
            onClick={() => {
              setOpening(true);
              cloneProject(repository).then(
                (project) => navigate(projectUrl(project.id)),
                (failure: Error) => {
                  setOpening(false);
                  setError(failure.message);
                },
              );
            }}
          >
            {opening ? 'Opening…' : 'Open as a new project'}
          </button>
          <a href={apexUrl('/')}>All projects</a>
        </p>
      </main>
    </div>
  );
}
