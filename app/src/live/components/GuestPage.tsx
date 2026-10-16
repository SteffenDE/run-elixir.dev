import { useEffect, useState } from 'react';
import { parseFragment } from '@/live/lib/crypto';
import { joinSession, type GuestProject } from '@/live/lib/guest';
import { saveName, savedName, useLive } from '@/live/lib/store';
import { ProjectPage } from '@/project/components/ProjectPage';
import { apexUrl } from '@/shared/lib/site';

// A live session's link (/live/ID#k=…&h=…): a name, then the host's project
// in the IDE, once the host lets this guest in.
export function GuestPage({ session }: { session: string }) {
  const [secrets] = useState(() => parseFragment(location.hash));
  const [name, setName] = useState(savedName);
  const [joining, setJoining] = useState(false);
  const [project, setProject] = useState<GuestProject | null>(null);
  const status = useLive((state) => state.status);
  const reason = useLive((state) => state.reason);
  const generation = useLive((state) => state.generation);

  useEffect(() => {
    document.title = project
      ? `${project.name} (live) · Elixir Playground`
      : 'Live session · Elixir Playground';
  }, [project]);

  if (project && status !== 'refused')
    return (
      <>
        {status === 'ended' && (
          <div className="live-ended" role="status">
            {reason ?? 'The live session ended.'} What you see stays until you leave.
          </div>
        )}
        <ProjectPage key={generation} project={null} guest={project} />
      </>
    );

  const problem = !secrets
    ? 'This link is missing its key: copy the whole link.'
    : status === 'refused' || status === 'ended'
      ? reason
      : null;

  return (
    <div className="home">
      <main className="home-main">
        <h1 className="home-title">
          Elixir <span>Playground</span>
        </h1>
        <h2>Live session</h2>
        {problem ? (
          <p className="project-error">{problem}</p>
        ) : joining ? (
          <p className="muted">
            {status === 'waiting'
              ? 'Waiting for the host to let you in…'
              : status === 'reconnecting'
                ? 'The host is away; waiting for them to come back…'
                : 'Joining…'}
          </p>
        ) : (
          <form
            className="live-form"
            onSubmit={(event) => {
              event.preventDefault();
              const as = name.trim() || 'Guest';
              saveName(as);
              setJoining(true);
              void joinSession(session, secrets!, as, setProject);
            }}
          >
            <p className="muted">
              You are joining a project that runs in someone else's browser. They see your name and
              where your cursor is.
            </p>
            <label className="live-field">
              Your name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={40}
                autoFocus
              />
            </label>
            <button type="submit" className="button">
              Join
            </button>
          </form>
        )}
        <p>
          <a href={apexUrl('/')}>All projects</a>
        </p>
      </main>
    </div>
  );
}
