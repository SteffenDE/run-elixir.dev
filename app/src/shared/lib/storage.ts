// Where a project keeps its state, all named after its id, and the lock
// its page holds while it runs it.
import { removeProject } from './projects';

// The project's files: what it changed over its template (files.js).
export const filesStore = (id: string) => `playground-files-${id}`;
// Its PGlite: `idb://NAME` keeps it in the IndexedDB database /pglite/NAME.
export const pgliteName = (id: string) => `playground-pg-${id}`;
export const pgliteDataDir = (id: string) => `idb://${pgliteName(id)}`;
// Held by the one page running the project (Web Locks).
export const projectLock = (id: string) => `playground-project:${id}`;

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`${name}: not deleted`));
    // Something still has it open: the delete finishes once it closes.
    request.onblocked = () => resolve();
  });
}

// The ids of projects a page runs now, in this browser.
export async function openProjects(): Promise<Set<string>> {
  const { held = [] } = await navigator.locks.query();
  const prefix = projectLock('');
  return new Set(
    held.flatMap(({ name }) => (name?.startsWith(prefix) ? [name.slice(prefix.length)] : [])),
  );
}

const OPEN = 'The project is open in another tab. Close it first.';

// Delete what a project keeps on this origin: its files and its database,
// and on a project's own origin (site.ts) all of the origin's caches and
// its service worker too. A project open in a tab is not deleted: the
// lock is taken for the time it takes.
export async function deleteStores(id: string): Promise<void> {
  await navigator.locks.request(projectLock(id), { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error(OPEN);
    await Promise.all([
      deleteDatabase(filesStore(id)),
      deleteDatabase(`/pglite/${pgliteName(id)}`),
    ]);
  });
}

// Delete a project and everything it keeps, where it all is on this origin.
export async function deleteProject(id: string): Promise<void> {
  await deleteStores(id);
  await removeProject(id);
}
