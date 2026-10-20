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

// What files.js keeps a project's changes in: a database of this origin's
// (`local`), or, in the frame that runs a project for the apex
// (docs/frames.md), the apex's, through a port (`remote`; the apex answers
// with serveStore).
export interface Store {
  load(): Promise<{ records: KeptRecord[]; version: string | null }>;
  save(records: KeptRecord[], cleared: string[], version: string | null): Promise<void>;
  drop(prefix: string): Promise<void>;
}

export async function local(name: string): Promise<Store> {
  const db = await open(name);
  return {
    load: () => load(db),
    save: (records, cleared, version) => save(db, records, cleared, version),
    drop: (prefix) => drop(db, prefix),
  };
}

type StoreCall =
  | { id: number; op: 'load' }
  | { id: number; op: 'save'; records: KeptRecord[]; cleared: string[]; version: string | null }
  | { id: number; op: 'drop'; prefix: string };
type StoreReply = { id: number; value?: unknown; error?: string };
type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never;

export function remote(port: MessagePort): Store {
  let next = 1;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  port.onmessage = ({ data }: MessageEvent<StoreReply>) => {
    const call = waiting.get(data.id);
    waiting.delete(data.id);
    if (data.error !== undefined) call?.reject(new Error(data.error));
    else call?.resolve(data.value);
  };
  const ask = <T>(message: Unsent<StoreCall>, transfer: Transferable[] = []) =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      port.postMessage({ ...message, id }, transfer);
    });
  return {
    load: () => ask({ op: 'load' }),
    save: (records, cleared, version) =>
      ask({ op: 'save', records, cleared, version }, [
        ...new Set(
          records.flatMap((record) => (record.kind === 'file' ? [record.data.buffer] : [])),
        ),
      ]),
    drop: (prefix) => ask({ op: 'drop', prefix }),
  };
}

// The apex's side of remote(): database `name`'s records, for the port's
// other end. A frame that runs a project reaches only that project's.
export function serveStore(port: MessagePort, name: string): void {
  const db = open(name);
  port.onmessage = async ({ data }: MessageEvent<StoreCall>) => {
    try {
      const opened = await db;
      let value: unknown;
      const transfer = new Set<Transferable>();
      if (data.op === 'load') {
        const loaded = await load(opened);
        for (const record of loaded.records)
          if (record.kind === 'file') transfer.add(record.data.buffer);
        value = loaded;
      } else if (data.op === 'save') await save(opened, data.records, data.cleared, data.version);
      else if (data.op === 'drop') await drop(opened, data.prefix);
      port.postMessage({ id: data.id, value } satisfies StoreReply, [...transfer]);
    } catch (error) {
      port.postMessage({ id: data.id, error: (error as Error).message } satisfies StoreReply);
    }
  };
}
