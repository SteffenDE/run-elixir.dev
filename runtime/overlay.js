// What a project changed below /work, over what the site gave it (its
// template), kept in IndexedDB: one database per project (files.js's
// `store`), whose `files` hold a record per changed path:
//
//   { path, kind: 'file', data, mtime }   a file and its bytes
//   { path, kind: 'dir', opaque, mtime }  a directory; opaque when it
//                                         replaced one that was removed,
//                                         so the template's entries in it
//                                         stay gone
//   { path, kind: 'gone' }                removed (a whiteout)
//
// and `meta` the site version the records were made over. Records apply
// in path order, so a directory comes before what is in it.
const VERSION = 1;

function request(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('aborted'));
  });
}

export async function open(name) {
  const opening = indexedDB.open(name, VERSION);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('files', { keyPath: 'path' });
    opening.result.createObjectStore('meta');
  };
  return request(opening);
}

// Every record, in path order, and the site version they were made over.
export async function load(db) {
  const transaction = db.transaction(['files', 'meta'], 'readonly');
  const [records, version] = await Promise.all([
    request(transaction.objectStore('files').getAll()),
    request(transaction.objectStore('meta').get('version')),
  ]);
  return { records, version: version ?? null };
}

// Store `records` (each replaces its path's), drop the records below each
// of `cleared` (a directory replaced or gone takes its contents with it),
// and note the site version.
export async function save(db, records, cleared, version) {
  const transaction = db.transaction(['files', 'meta'], 'readwrite');
  const files = transaction.objectStore('files');
  for (const path of cleared) files.delete(IDBKeyRange.bound(`${path}/`, `${path}/￿`));
  for (const record of records) files.put(record);
  transaction.objectStore('meta').put(version, 'version');
  return done(transaction);
}

// Drop every record below `prefix` (a template's _build after the site
// changed).
export async function drop(db, prefix) {
  const transaction = db.transaction(['files'], 'readwrite');
  transaction.objectStore('files').delete(IDBKeyRange.bound(`${prefix}/`, `${prefix}/￿`));
  return done(transaction);
}
