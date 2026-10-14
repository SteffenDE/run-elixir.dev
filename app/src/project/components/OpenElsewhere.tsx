import { useState } from 'react';
import type { Project } from '@/shared/lib/projects';
import { apexUrl } from '@/shared/lib/site';

// The project runs in another tab: open it here instead (that tab keeps
// its changes and stops), or go back. `moved`: this tab ran it until
// another took it over.
export function OpenElsewhere({
  project,
  moved = false,
  onOpenHere = () => location.reload(),
}: {
  project: Project;
  moved?: boolean;
  onOpenHere?: () => unknown;
}) {
  const [opening, setOpening] = useState(false);
  return (
    <div className="home">
      <main className="home-main">
        <h1 className="home-title">{project.name}</h1>
        <p>
          {moved
            ? 'This project is open in another tab now; it stopped here.'
            : 'This project is open in another tab.'}
        </p>
        <p className="elsewhere-actions">
          <button
            type="button"
            className="button"
            disabled={opening}
            onClick={() => {
              setOpening(true);
              onOpenHere();
            }}
          >
            {opening ? 'Opening…' : 'Open it here'}
          </button>
          <a href={apexUrl('/')}>All projects</a>
        </p>
      </main>
    </div>
  );
}
