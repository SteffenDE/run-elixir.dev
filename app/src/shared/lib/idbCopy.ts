// An IndexedDB database as a value (its version, stores, indexes and
// records), and back: how a project's stores move from its former origin
// (p-ID) to the apex (migrate.ts, frames/storage.ts). The records are
// structured clones, so bytes and dates go as they are.
export interface DatabaseCopy {
  name: string;
  version: number;
  stores: {
    name: string;
    keyPath: string | string[] | null;
    autoIncrement: boolean;
    indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
    records: [IDBValidKey, unknown][];
  }[];
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// Database `name`, or null when this origin has none.
export async function copyDatabase(name: string): Promise<DatabaseCopy | null> {
  if (indexedDB.databases) {
    const known = await indexedDB.databases();
    if (!known.some((database) => database.name === name)) return null;
  }
  let created = false;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(name);
    // None (where databases() is missing): opening made it; it goes again.
    opening.onupgradeneeded = () => (created = true);
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  if (created) {
    db.close();
    await request(indexedDB.deleteDatabase(name));
    return null;
  }
  const copy: DatabaseCopy = { name, version: db.version, stores: [] };
  for (const storeName of db.objectStoreNames) {
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    const [keys, values] = await Promise.all([
      request(store.getAllKeys()),
      request(store.getAll()),
    ]);
    copy.stores.push({
      name: storeName,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: [...store.indexNames].map((indexName) => {
        const index = store.index(indexName);
        return {
          name: indexName,
          keyPath: index.keyPath,
          unique: index.unique,
          multiEntry: index.multiEntry,
        };
      }),
      records: keys.map((key, i) => [key, values[i]]),
    });
  }
  db.close();
  return copy;
}

// `copy` as this origin's database of its name, replacing any.
export async function restoreDatabase(copy: DatabaseCopy): Promise<void> {
  await request(indexedDB.deleteDatabase(copy.name));
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open(copy.name, copy.version);
    opening.onupgradeneeded = () => {
      for (const store of copy.stores) {
        const made = opening.result.createObjectStore(store.name, {
          keyPath: store.keyPath ?? undefined,
          autoIncrement: store.autoIncrement,
        });
        for (const index of store.indexes)
          made.createIndex(index.name, index.keyPath, {
            unique: index.unique,
            multiEntry: index.multiEntry,
          });
      }
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => reject(opening.error);
  });
  if (copy.stores.length) {
    const transaction = db.transaction(
      copy.stores.map((store) => store.name),
      'readwrite',
    );
    for (const store of copy.stores) {
      const target = transaction.objectStore(store.name);
      for (const [key, value] of store.records)
        if (store.keyPath === null) target.put(value, key);
        else target.put(value);
    }
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('aborted'));
    });
  }
  db.close();
}

export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(name);
    deleting.onsuccess = () => resolve();
    deleting.onerror = () => reject(deleting.error);
    deleting.onblocked = () => resolve();
  });
}
