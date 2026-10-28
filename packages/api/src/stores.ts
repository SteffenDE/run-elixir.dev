// The names a project's state is kept under, all named after its id
// (storage.ts deletes them): the API's sandbox and its plugins keep it
// under these names too.

// The project's files: what it changed over its template (files.js).
export const filesStore = (id: string) => `playground-files-${id}`;
// /shared's files, the user's for every project that has it (settings.ts).
export const SHARED_STORE = 'playground-shared';
// Its PGlite: `idb://NAME` keeps it in the IndexedDB database /pglite/NAME.
export const pgliteName = (id: string) => `playground-pg-${id}`;
export const pgliteDataDir = (id: string) => `idb://${pgliteName(id)}`;
// Held by the one page running the project (Web Locks).
export const projectLock = (id: string) => `playground-project:${id}`;
