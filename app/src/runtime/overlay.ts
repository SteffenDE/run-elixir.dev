// What a project changed below /work, over what the site gave it (its
// template), kept in IndexedDB: one database per project (files.js's
// `store`), whose `files` hold a record per changed path:
//
//   { path, kind: 'file', data, mtime }   a file and its bytes
//   { path, kind: 'dir', opaque, mtime }  a directory; opaque when it
//                                         replaced one that was removed,
//                                         so the template's entries in it
//                                         stay gone
//   { path, kind: 'link', target, mtime } a symbolic link
//   { path, kind: 'gone' }                removed (a whiteout)
//
// and `meta` the site version the records were made over. Records apply
// in path order, so a directory comes before what is in it.
const VERSION = 1;

// A record; mtimes are nanoseconds, as decimal strings.
export type KeptRecord =
  | { path: string; kind: 'file'; data: Uint8Array; mtime: string }
  | { path: string; kind: 'dir'; opaque: boolean; mtime: string }
  | { path: string; kind: 'link'; target: string; mtime: string }
  | { path: string; kind: 'gone' };

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('aborted'));
  });
}

export async function open(name: string): Promise<IDBDatabase> {
  const opening = indexedDB.open(name, VERSION);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('files', { keyPath: 'path' });
    opening.result.createObjectStore('meta');
  };
  return request(opening);
}

// Every record, in path order, and the site version they were made over.
export async function load(
  db: IDBDatabase,
): Promise<{ records: KeptRecord[]; version: string | null }> {
  const transaction = db.transaction(['files', 'meta'], 'readonly');
  const [records, version] = await Promise.all([
    request(transaction.objectStore('files').getAll() as IDBRequest<KeptRecord[]>),
    request(transaction.objectStore('meta').get('version') as IDBRequest<string | undefined>),
  ]);
  return { records, version: version ?? null };
}

// Store `records` (each replaces its path's), drop the records below each
// of `cleared` (a directory replaced or gone takes its contents with it),
// and note the site version.
export async function save(
  db: IDBDatabase,
  records: KeptRecord[],
  cleared: Iterable<string>,
  version: string | null,
): Promise<void> {
  const transaction = db.transaction(['files', 'meta'], 'readwrite');
  const files = transaction.objectStore('files');
  for (const path of cleared) files.delete(IDBKeyRange.bound(`${path}/`, `${path}/￿`));
  for (const record of records) files.put(record);
  transaction.objectStore('meta').put(version, 'version');
  return done(transaction);
}

// Drop every record below `prefix` (a template's _build after the site
// changed).
export async function drop(db: IDBDatabase, prefix: string): Promise<void> {
  const transaction = db.transaction(['files'], 'readwrite');
  transaction.objectStore('files').delete(IDBKeyRange.bound(`${prefix}/`, `${prefix}/￿`));
  return done(transaction);
}
