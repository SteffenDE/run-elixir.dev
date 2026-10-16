import { RiGitForkLine, RiLogoutBoxRLine } from '@remixicon/react';
import { useState } from 'react';
import { fork, leaveSession } from '@/live/lib/guest';
import { useLive } from '@/live/lib/store';
import { importProject } from '@/shared/lib/projects';
import { apexUrl, projectUrl } from '@/shared/lib/site';
import { People } from './People';

const STATUS: Record<string, string> = {
  connecting: 'Joining…',
  waiting: 'Waiting for the host',
  reconnecting: 'The host is away…',
};

// A guest's top bar: who is in, what this guest may do, a fork if allowed,
// and leaving.
export function GuestBar() {
  const status = useLive((state) => state.status);
  const mine = useLive((state) => state.mine);
  const [forking, setForking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const may = [mine.edit && 'edit', mine.terminal && 'use the terminals'].filter(Boolean);

  return (
    <>
      <span className="muted guest-status" title={error ?? undefined}>
        {error ??
          STATUS[status] ??
          (may.length ? `You may ${may.join(' and ')}` : 'You are watching')}
      </span>
      <People />
      {mine.fork && (
        <button
          type="button"
          className="button"
          disabled={forking}
          title="Make a project of your own from this one, as it is now"
          onClick={() => {
            setForking(true);
            setError(null);
            fork()
              .then(importProject)
              .then((project) => window.open(projectUrl(project.id), '_blank'))
              .catch((failure: Error) => setError(failure.message))
              .finally(() => setForking(false));
          }}
        >
          <RiGitForkLine size={16} />
          <span className="button-label">{forking ? 'Forking…' : 'Fork'}</span>
        </button>
      )}
      <button
        type="button"
        className="button"
        title="Leave the live session"
        onClick={() => {
          leaveSession();
          location.assign(apexUrl('/'));
        }}
      >
        <RiLogoutBoxRLine size={16} />
        <span className="button-label">Leave</span>
      </button>
    </>
  );
}
