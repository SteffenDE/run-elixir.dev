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
  useLive.getState().set({ following: id, detached: null });
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

// Their caret, in the middle of the view: scrolled to where it is drawn,
// else (outside what the editor rendered) to its line, then to the caret
// once drawn there. A move along its line scrolls nothing.
// Once the editor has drawn the carets anew (it hears of a moved caret as
// this does): until then the caret is where it was. Never by focusing the
// editor: that moves this page's caret, which the editor then keeps in
// view on every edit of theirs. While this page types in the editor, its
// own caret is the one in view, until Escape (resumeFollowing).
function keepInView(id: string, line: number) {
  setTimeout(() => {
    if (!editorFocused()) showCaret(id, line);
  }, 0);
}

// The shadow root the active tab's editor draws in.
function editorRoot(): ShadowRoot | null {
  const panel = document.querySelector('.tab-panel:not([hidden])');
  for (const element of panel?.querySelectorAll('*') ?? [])
    if (element.shadowRoot?.querySelector('[data-line]')) return element.shadowRoot;
  return null;
}

function editorFocused(): boolean {
  return !!document.activeElement?.closest('.tab-panel:not([hidden])');
}

function showCaret(id: string, line: number, again = true) {
  const root = editorRoot();
  const caret = root?.querySelector(`[data-person="${CSS.escape(id)}"]`);
  if (caret) caret.scrollIntoView({ block: 'center', inline: 'nearest' });
  else if (root && again && !root.querySelector(`[data-line="${line}"]`)) {
    showLine(root, line);
    requestAnimationFrame(() => showCaret(id, line, false));
  }
  // A drawn line without their caret: it is not known here yet (their
  // edit is on its way); the next move shows it.
}

// `line` in the middle of the editor, from where a drawn line is (lines
// are as high as each other, as the editor reckons too).
function showLine(root: ShadowRoot, line: number) {
  const drawn = root.querySelector<HTMLElement>('[data-line]');
  const scroller = document.querySelector('.tab-panel:not([hidden]) .editor-scroll');
  if (!drawn || !scroller) return;
  const at = drawn.getBoundingClientRect();
  const top = at.top + (line - Number(drawn.dataset.line)) * at.height;
  const view = scroller.getBoundingClientRect();
  scroller.scrollBy(0, top - view.top - view.height / 2);
}

// The file of the one followed, open here: it goes to their caret
// (Editor.tsx), not focused.
export function followed(path: string): boolean {
  const { following, active } = useLive.getState();
  return !!following && active[following] === path;
}

// Once the editor has drawn their caret (it draws them on attaching).
export function showFollowed(line: number): void {
  const id = useLive.getState().following;
  requestAnimationFrame(() => {
    if (id) showCaret(id, line);
  });
}

// Escape in their file after typing in it (Editor.tsx): the editor lets
// go of focus, and their caret is in view again.
export function resumeFollowing(): void {
  const { following, cursors } = useLive.getState();
  const cursor = following ? cursors[following] : undefined;
  if (following && cursor && cursor.path === useStore.getState().active)
    keepInView(following, cursor.line);
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
