import { follow } from '@/live/lib/follow';
import { useLive, type Person } from '@/live/lib/store';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('') || '?';

export function Avatar({ person }: { person: Person }) {
  return (
    <span
      className="avatar"
      style={{ background: person.color }}
      title={person.host ? `${person.name} (host)` : person.name}
    >
      {initials(person.name)}
    </span>
  );
}

// Who is in the live session, as a row of initials (the waiting left out).
// `followable`: clicking another's follows them, or stops following.
export function People({ followable = false }: { followable?: boolean }) {
  const people = useLive((state) => state.people);
  const me = useLive((state) => state.me);
  const following = useLive((state) => state.following);
  const shown = people.filter((person) => !person.waiting);
  if (!shown.length) return null;
  return (
    <span className="people" aria-label={`${shown.length} in the session`}>
      {shown.slice(0, 5).map((person) =>
        followable && person.id !== me ? (
          <button
            key={person.id}
            type="button"
            className={person.id === following ? 'avatar-button following' : 'avatar-button'}
            title={
              person.id === following ? `Stop following ${person.name}` : `Follow ${person.name}`
            }
            aria-pressed={person.id === following}
            onClick={() => follow(person.id === following ? null : person.id)}
          >
            <Avatar person={person} />
          </button>
        ) : (
          <Avatar key={person.id} person={person} />
        ),
      )}
      {shown.length > 5 && <span className="avatar more">+{shown.length - 5}</span>}
    </span>
  );
}
