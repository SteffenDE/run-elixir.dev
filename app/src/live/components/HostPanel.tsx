import { RiCheckLine, RiCloseLine, RiFileCopyLine } from '@remixicon/react';
import { useState } from 'react';
import { follow } from '@/live/lib/follow';
import {
  admit,
  endSession,
  kick,
  setAdmission,
  setEveryone,
  setGuest,
  startSession,
  type HostProject,
} from '@/live/lib/host';
import { saveName, savedName, useLive, type Permissions } from '@/live/lib/store';
import { Avatar } from './People';

const SWITCHES: [keyof Permissions, string, string][] = [
  ['edit', 'Edit', 'Edit, add, rename and remove files, and save'],
  [
    'terminal',
    'Terminals',
    'Type into terminals, open them and restart the server: full control of the project',
  ],
  ['fork', 'Fork', 'Make a project of their own from this one'],
];

// The host's side of a live session, in the Share popover: starting one,
// then its link, who is in and what they may do, and ending it.
export function HostPanel({ project }: { project: HostProject }) {
  const role = useLive((state) => state.role);
  const status = useLive((state) => state.status);
  const reason = useLive((state) => state.reason);
  if (role !== 'host')
    return <StartForm project={project} ended={status === 'ended' ? reason : null} />;
  return <Running />;
}

function StartForm({ project, ended }: { project: HostProject; ended: string | null }) {
  const [name, setName] = useState(savedName);
  const [ask, setAsk] = useState(false);
  const [starting, setStarting] = useState(false);
  return (
    <form
      className="live-form"
      onSubmit={(event) => {
        event.preventDefault();
        const as = name.trim() || 'Host';
        saveName(as);
        setStarting(true);
        void startSession(project, { name: as, admit: ask }).finally(() => setStarting(false));
      }}
    >
      {ended && <p className="muted">{ended}</p>}
      <p className="muted share-note">
        Others join this project as it runs here. They watch; you choose who may edit, use the
        terminals or fork it. The relay passes on what you share encrypted: it cannot read it.
      </p>
      <label className="live-field">
        Your name
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={40} />
      </label>
      <label className="live-check">
        <input type="checkbox" checked={ask} onChange={(event) => setAsk(event.target.checked)} />
        Ask me before letting each person in
      </label>
      <button type="submit" className="button primary" disabled={starting}>
        {starting ? 'Starting…' : 'Start live session'}
      </button>
    </form>
  );
}

function Running() {
  const link = useLive((state) => state.link);
  const status = useLive((state) => state.status);
  const people = useLive((state) => state.people);
  const everyone = useLive((state) => state.everyone);
  const perGuest = useLive((state) => state.perGuest);
  const asking = useLive((state) => state.admit);
  const me = useLive((state) => state.me);
  const following = useLive((state) => state.following);
  const [copied, setCopied] = useState(false);
  const guests = people.filter((person) => person.id !== me && !person.waiting);
  const waiting = people.filter((person) => person.waiting);

  return (
    <div className="live-panel">
      <p className="share-summary">
        {status === 'live' ? 'Live' : 'Connecting…'} · {guests.length}{' '}
        {guests.length === 1 ? 'guest' : 'guests'}
      </p>
      <div className="share-row">
        <input
          className="share-url"
          readOnly
          value={link ?? ''}
          aria-label="Link to this live session"
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="button"
          onClick={() => void navigator.clipboard.writeText(link ?? '').then(() => setCopied(true))}
        >
          {copied ? <RiCheckLine size={16} /> : <RiFileCopyLine size={16} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="muted share-note">Anyone with this link can join and see the project.</p>

      {waiting.length > 0 && (
        <ul className="live-people">
          {waiting.map((person) => (
            <li key={person.id}>
              <span className="live-person">
                <Avatar person={person} />
                {person.name || 'Someone'} <span className="muted">wants to join</span>
              </span>
              <span className="live-actions">
                <button
                  type="button"
                  className="button primary"
                  onClick={() => void admit(person.id)}
                >
                  Let in
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title="Turn away"
                  onClick={() => void kick(person.id)}
                >
                  <RiCloseLine size={16} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="live-switches">
        <span className="muted">Everyone may</span>
        {SWITCHES.map(([key, label, title]) => (
          <label key={key} className="live-check" title={title}>
            <input
              type="checkbox"
              checked={everyone[key]}
              onChange={(event) => setEveryone({ ...everyone, [key]: event.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>

      {guests.length > 0 && (
        <ul className="live-people">
          {guests.map((person) => {
            const perms = { ...everyone, ...perGuest[person.id] };
            return (
              <li key={person.id}>
                <span className="live-person">
                  <Avatar person={person} />
                  {person.name}
                  <button
                    type="button"
                    className="link-button"
                    aria-pressed={following === person.id}
                    title={`Open the file ${person.name} has open, and keep their caret in view`}
                    onClick={() => follow(following === person.id ? null : person.id)}
                  >
                    {following === person.id ? 'Following' : 'Follow'}
                  </button>
                </span>
                <span className="live-actions">
                  {SWITCHES.map(([key, label, title]) => (
                    <label key={key} className="live-check" title={title}>
                      <input
                        type="checkbox"
                        checked={perms[key]}
                        aria-label={`${person.name}: ${label}`}
                        onChange={(event) => setGuest(person.id, { [key]: event.target.checked })}
                      />
                      {label}
                    </label>
                  ))}
                  <button
                    type="button"
                    className="icon-button"
                    title={`Remove ${person.name}`}
                    onClick={() => void kick(person.id)}
                  >
                    <RiCloseLine size={16} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <label className="live-check">
        <input
          type="checkbox"
          checked={asking}
          onChange={(event) => setAdmission(event.target.checked)}
        />
        Ask me before letting each person in
      </label>
      <button type="button" className="button danger" onClick={() => void endSession()}>
        End live session
      </button>
    </div>
  );
}
