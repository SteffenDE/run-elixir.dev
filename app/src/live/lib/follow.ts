// Following someone in a live session (docs/collaboration.md#following):
// the file in front of them opens here, at their caret's line, and their
// caret stays in view as it moves. This page's own choice of another file
// (the tree, a tab, a terminal's link) stops it; following again opens
// theirs.
import { useStore } from '@/project/lib/store';
import { workspace } from '@/project/lib/workspace';
import { publishActive } from './presence';
import { useLive } from './store';

let started = false;
// The file being opened for the one followed (not this page's choice).
let opening: string | null = null;

// Their file opens at once (the subscription below sees the change).
export function follow(id: string | null): void {
  useLive.getState().set({ following: id });
}

// The followed person's file, at their caret's line.
async function showFile(id: string) {
  const { active, cursors } = useLive.getState();
  const path = active[id];
  if (!path) return;
  const cursor = cursors[id];
  const line = cursor?.path === path ? cursor.line : 1;
  if (useStore.getState().active === path) {
    keepInView(id, line);
    return;
  }
  opening = path;
  try {
    await workspace().openFile(path, line);
  } catch {
    // Gone meanwhile: the next change tries again.
  } finally {
    if (opening === path) opening = null;
  }
}

// Their caret, in view: scrolled to where it is drawn, else (outside what
// the editor rendered) the editor goes to its line.
function keepInView(id: string, line: number) {
  const panel = document.querySelector('.tab-panel:not([hidden])');
  for (const element of panel?.querySelectorAll('*') ?? []) {
    const caret = element.shadowRoot?.querySelector(`[data-person="${CSS.escape(id)}"]`);
    if (caret) {
      caret.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
  }
  const path = useStore.getState().active;
  if (path) useStore.getState().open(path, '', line);
}

// Watches both stores, once a session starts (host.ts, guest.ts).
export function startFollowing(): void {
  publishActive(useStore.getState().active);
  if (started) return;
  started = true;
  useStore.subscribe((state, before) => {
    if (state.active === before.active) return;
    publishActive(state.active);
    // Another file than theirs, chosen here: no longer following.
    const { following, active } = useLive.getState();
    if (following && state.active !== opening && state.active !== active[following])
      useLive.getState().set({ following: null });
  });
  useLive.subscribe((state, before) => {
    const id = state.following;
    if (!id) return;
    if (state.active[id] !== before.active[id] || id !== before.following) void showFile(id);
    else if (state.cursors[id] !== before.cursors[id]) {
      const cursor = state.cursors[id];
      if (cursor && cursor.path === useStore.getState().active) keepInView(id, cursor.line);
    }
  });
}
