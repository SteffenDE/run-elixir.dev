import { useSyncExternalStore } from 'react';

// Phones and narrow windows: one pane at a time.
const query = matchMedia('(max-width: 720px)');

export function useNarrow(): boolean {
  return useSyncExternalStore(
    (changed) => {
      query.addEventListener('change', changed);
      return () => query.removeEventListener('change', changed);
    },
    () => query.matches,
  );
}
