import { RiGitForkLine, RiLogoutBoxRLine } from '@remixicon/react';
import { useState } from 'react';
import { follow } from '@/live/lib/follow';
import { fork, leaveSession } from '@/live/lib/guest';
import { useLive } from '@/live/lib/store';
import { importProject } from '@/shared/lib/projects';
import type { Shared } from '@elixir-playground/runtime/lib/share';
import { apexUrl, projectUrl } from '@elixir-playground/runtime/lib/site';
import { People } from './People';

// A fork becomes a project of this browser's, in the apex's list (the
// guest's page is the apex's too).
async function keep(shared: Shared): Promise<string> {
  return projectUrl((await importProject(shared, 'fork')).id);
}

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
  const people = useLive((state) => state.people);
  const following = useLive((state) => state.following);
  const followed = people.find((person) => person.id === following) ?? null;
  const host = people.find((person) => person.host);
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
      {status === 'live' &&
        (followed ? (
          <button
            type="button"
            className="button following-button"
            title={`${followed.name}'s file opens here, and their caret stays in view`}
            onClick={() => follow(null)}
          >
            Following {followed.name} · Stop
          </button>
        ) : (
          host && (
            <button
              type="button"
              className="button"
              title={`Open the file ${host.name} has open, and keep their caret in view`}
              onClick={() => follow(host.id)}
            >
              Follow {host.name}
            </button>
          )
        ))}
      <People followable />
      {mine.fork && (
        <button
          type="button"
          className="button"
          disabled={forking}
          title="Create your own copy of the project in its current state"
          onClick={() => {
            setForking(true);
            setError(null);
            fork()
              .then(keep)
              .then((url) => window.open(url, '_blank'))
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
