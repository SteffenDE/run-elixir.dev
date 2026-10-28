import { useEffect, useState } from 'react';
import { whenReleased } from '@/shared/lib/lock';
import type { Project } from '@/shared/lib/projects';
import { apexUrl } from '@elixir-playground/runtime/lib/site';

// The project runs in another tab: open it here instead (that tab keeps
// its changes and stops), or go back. `moved`: this tab ran it until
// another took it over. Once that tab lets it go (leaves it, closes,
// crashes), it opens here (`onReleased`).
export function OpenElsewhere({
  project,
  moved = false,
  onOpenHere = () => location.reload(),
  onReleased = onOpenHere,
}: {
  project: Project;
  moved?: boolean;
  onOpenHere?: () => unknown;
  onReleased?: () => unknown;
}) {
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    // Opening it here already (takes it over).
    if (opening) return;
    const stop = new AbortController();
    whenReleased(project.id, stop.signal).then(
      () => {
        setOpening(true);
        onReleased();
      },
      () => {
        // Gone from the page first.
      },
    );
    return () => stop.abort();
  }, [project.id, onReleased, opening]);
  return (
    <div className="home">
      <main className="home-main">
        <h1 className="home-title">{project.name}</h1>
        <p>
          {moved
            ? 'This project stopped here because it was opened in another tab.'
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
