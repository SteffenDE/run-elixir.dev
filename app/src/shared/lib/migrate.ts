// A project's stores from the former layout, where it ran on an origin of
// its own (p-ID.DOMAIN: its files' changes, its Postgres), kept on the
// apex instead (docs/frames.md), through that origin's storage frame
// (frames/storage.ts): copied here where the apex has none of its own,
// then deleted there. Once per project; a browser that never had that
// layout finds nothing there.
import { close, call } from './frames';
import { restoreDatabase, type DatabaseCopy } from './idbCopy';
import { formerStorage } from '@elixir-playground/runtime/lib/site';

const MOVED = 'playground-moved';

function moved(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(MOVED) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function markMoved(id: string): void {
  try {
    localStorage.setItem(MOVED, JSON.stringify([...moved(), id]));
  } catch {
    // Asked again next time: it finds nothing left.
  }
}

async function has(name: string): Promise<boolean> {
  if (!indexedDB.databases) return false;
  return (await indexedDB.databases()).some((database) => database.name === name);
}

// Every listed project's (the home page's, in the background), one at a
// time.
export async function moveAllFormerStores(ids: string[]): Promise<void> {
  for (const id of ids) await moveFormerStores(id);
}

// Project `id`'s former stores, on the apex now. Never throws: a project
// opens with what the apex has.
export async function moveFormerStores(id: string): Promise<void> {
  const url = formerStorage(id);
  if (!url || moved().has(id)) return;
  try {
    // A site that no longer serves the former names answers late, if at
    // all: the project does not wait for it long.
    const copies = await Promise.race([
      call<DatabaseCopy[]>(url, 'copy'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no answer')), 5000)),
    ]);
    for (const copy of copies) if (!(await has(copy.name))) await restoreDatabase(copy);
    await call(url, 'delete');
    markMoved(id);
  } catch {
    // Not reached (no former origin served, or no answer): left there for
    // the next time.
  } finally {
    close(url);
  }
}
