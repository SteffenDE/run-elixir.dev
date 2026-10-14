import { RiArrowRightLine } from '@remixicon/react';
import { useEffect, useState } from 'react';
import { deleteOwnStores } from '@/shared/lib/registry';
import { apexUrl, projectOrigin } from '@/shared/lib/site';
import { filesStore, pgliteName } from '@/shared/lib/storage';

// A project this browser does not have (`project`), or an address that is
// no project's (a path, or a name under the project domain, site.ts): the
// way back to the projects. On a project's own origin, what a project left
// there (its list entry gone) can be deleted.
export function NotFound({ project = false }: { project?: boolean }) {
  const id = projectOrigin();
  const [leftovers, setLeftovers] = useState<'none' | 'kept' | 'deleted'>('none');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'Not found · Elixir Playground';
    if (!id || !indexedDB.databases) return;
    const names = [filesStore(id), `/pglite/${pgliteName(id)}`];
    void indexedDB
      .databases()
      .then((databases) => databases.some((database) => names.includes(database.name ?? '')))
      .then((kept) => kept && setLeftovers('kept'));
  }, [id]);

  return (
    <div className="home">
      <main className="home-main not-found">
        <h1 className="home-title">
          Elixir <span>Playground</span>
        </h1>
        <p>
          {project
            ? 'There is no such project in this browser. Projects are kept where they were made.'
            : 'There is nothing at this address.'}
        </p>
        <a className="button primary big" href={apexUrl('/')}>
          Go to your projects <RiArrowRightLine size={18} />
        </a>
        {leftovers !== 'none' && id && (
          <div className="not-found-leftovers">
            {leftovers === 'kept' ? (
              <>
                <p className="muted">
                  A project&apos;s files or database are still kept at this address, though your
                  projects no longer list it.
                </p>
                <button
                  type="button"
                  className="button danger"
                  onClick={() =>
                    deleteOwnStores(id).then(
                      () => setLeftovers('deleted'),
                      (failed: Error) => setError(failed.message),
                    )
                  }
                >
                  Delete what is left here
                </button>
                {error && <span className="project-error">{error}</span>}
              </>
            ) : (
              <p className="muted">Deleted.</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
