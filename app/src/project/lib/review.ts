// The changes view's data while a project runs here: the project's changes
// (changes.ts) again whenever its files or its repository change (a save,
// a node's write, a commit or checkout at the shell), one refresh at a time.
import { changes, ours, seedSnapshots, type Run } from '@/project/lib/changes';
import { initialize } from '@/project/lib/git';
import { HIDDEN, WORK, useStore } from '@/project/lib/store';

// Builds and dependencies change often and are not the project's (.gitignore
// leaves them out); .git is (a commit, a checkout).
const BUILDS = HIDDEN.filter((name) => name !== '.git');
const relevant = (path: string) =>
  path.startsWith(`${WORK}/`) &&
  !ours(path) &&
  !path
    .slice(WORK.length + 1)
    .split('/')
    .some((part) => BUILDS.includes(part));

interface Watched {
  git: Run;
  stat: (path: string) => Promise<'file' | 'dir' | null>;
}

let watched: Watched | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let again = false;

async function refresh(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  const at = watched;
  if (!at) return;
  running = true;
  try {
    for (;;) {
      again = false;
      const { base, setChanges } = useStore.getState();
      try {
        const repository = (await at.stat(`${WORK}/.git`)) === 'dir';
        const found = repository ? await changes(at.git, base) : null;
        if (watched !== at) return;
        setChanges({ repository, changes: found, error: null });
      } catch (error) {
        if (watched !== at) return;
        setChanges({ repository: true, changes: null, error: (error as Error).message });
      }
      // Changed again meanwhile (`again` is set by a later call).
      if (!again || watched !== at) break;
    }
  } finally {
    running = false;
  }
}

function soon(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void refresh();
  }, 300);
}

// What changed, as files.js and the editor tell it.
export function filesChanged(paths: string[]): void {
  if (watched && paths.some(relevant)) soon();
}

// From now until the returned stop.
export function watchChanges(git: Run, stat: Watched['stat']): () => void {
  const mine: Watched = { git, stat };
  watched = mine;
  seedSnapshots();
  void refresh();
  const unsubscribe = useStore.subscribe((state, before) => {
    if (state.base !== before.base) void refresh();
  });
  return () => {
    unsubscribe();
    if (watched !== mine) return;
    watched = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

// An empty project's repository, from the changes view: git init, and its
// files (if any) as the baseline.
export async function initializeRepository(): Promise<void> {
  if (!watched) return;
  await initialize(watched.git);
  await refresh();
}
