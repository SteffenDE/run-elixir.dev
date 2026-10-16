import { RiCloseLine } from '@remixicon/react';
import { useLive } from '@/live/lib/store';
import { Kbd } from '@/shared/components/Kbd';

// Over the editor while following is detached (this page typing in their
// file): how to follow again. Closing it keeps the editor's focus.
export function FollowNotice() {
  const shown = useLive((state) => state.detached === 'notice' && state.following !== null);
  const name = useLive(
    (state) => state.people.find((person) => person.id === state.following)?.name,
  );
  if (!shown || !name) return null;
  return (
    <div className="follow-notice" role="status">
      <span>
        Detached · Press <Kbd>Esc</Kbd> to follow {name} again
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Close"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => useLive.getState().set({ detached: 'quiet' })}
      >
        <RiCloseLine size={14} />
      </button>
    </div>
  );
}
