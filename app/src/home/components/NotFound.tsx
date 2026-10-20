import { RiArrowRightLine } from '@remixicon/react';
import { useEffect } from 'react';
import { apexUrl } from '@/shared/lib/site';

// A project this browser does not have (`project`), or an address that is
// no project's (a path, or a name under either domain, site.ts): the way
// back to the projects.
export function NotFound({ project = false }: { project?: boolean }) {
  useEffect(() => {
    document.title = 'Not found · Elixir Playground';
  }, []);

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
      </main>
    </div>
  );
}
