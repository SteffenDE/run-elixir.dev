import { useEffect, useState } from 'react';
import { KindChip } from '@/shared/components/KindChip';
import { importProject } from '@/shared/lib/projects';
import { decodeShared, type Shared } from '@/shared/lib/share';

// A shared project's link (/import#DATA): what it holds, and a new project
// made from it.
export function ImportPage() {
  const [shared, setShared] = useState<Shared | null>(null);
  const [error, setError] = useState<string | null>(() =>
    location.hash.length > 1 ? null : 'This link holds no project.',
  );
  const [version, setVersion] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    document.title = 'Shared project · Elixir Playground';
    const data = location.hash.slice(1);
    if (!data) return;
    decodeShared(data).then(setShared, (failure: Error) =>
      setError(failure.message.startsWith('This link') ? failure.message : 'This link is damaged.'),
    );
    void fetch('/fs/version')
      .then((response) => response.text())
      .then((text) => setVersion(text.trim()));
  }, []);

  const paths = shared ? Object.keys(shared.files).sort() : [];
  return (
    <div className="home">
      <main className="home-main">
        <h1 className="home-title">
          Elixir <span>Playground</span>
        </h1>
        <h2>Shared project</h2>
        {error && <p className="project-error">{error}</p>}
        {shared && (
          <>
            <p className="import-title">
              <strong>{shared.name}</strong> <KindChip kind={shared.kind} />
            </p>
            <p className="muted">
              {paths.length} {paths.length === 1 ? 'file' : 'files'}
              {shared.removed.length ? `, ${shared.removed.length} removed` : ''}
              {shared.kind === 'phoenix' ? ' over the Phoenix template' : ''}.
              {version && version !== shared.site
                ? ' It was shared from another version of this site; its files apply all the same.'
                : ''}
            </p>
            <ul className="import-files">
              {paths.slice(0, 30).map((path) => (
                <li key={path}>{path}</li>
              ))}
              {paths.length > 30 && <li className="muted">and {paths.length - 30} more</li>}
            </ul>
            <p className="elsewhere-actions">
              <button
                type="button"
                className="button"
                disabled={opening}
                onClick={() => {
                  setOpening(true);
                  void importProject(shared).then((project) => location.assign(`/${project.id}/`));
                }}
              >
                {opening ? 'Opening…' : 'Open as a new project'}
              </button>
              <a href="/">All projects</a>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
