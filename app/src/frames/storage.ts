// storage.html, on a project's former origin (p-ID.DOMAIN, site.ts), as a
// hidden frame of the apex: what the project kept there (its files'
// changes, its Postgres), for the apex to keep instead (migrate.ts), then
// deleted. The same site as the apex, so this frame's storage is the
// origin's own, not partitioned. Its name is the former layout's storage
// frame's: a browser with that layout's service worker on this origin
// lets the frame through to the network (its other frames' it answers).
import { copyDatabase, deleteDatabase } from '@/shared/lib/idbCopy';
import { serve } from '@/shared/lib/frames';
import { apexOrigin, formerProject, loadSite } from '@/shared/lib/site';
import { filesStore, pgliteName } from '@/shared/lib/storage';

await loadSite();
const id = formerProject();
const names = id ? [filesStore(id), `/pglite/${pgliteName(id)}`] : [];

serve((origin) => id !== null && origin === apexOrigin(), {
  // Its databases, those it has.
  copy: async () => (await Promise.all(names.map(copyDatabase))).filter((copy) => copy !== null),
  // Kept on the apex now: gone from here, and the former layout's service
  // worker and caches with them.
  async delete() {
    await Promise.all(names.map(deleteDatabase));
    await Promise.all((await caches.keys()).map((name) => caches.delete(name)));
    const workers = await navigator.serviceWorker?.getRegistrations();
    await Promise.all((workers ?? []).map((worker) => worker.unregister()));
  },
});
