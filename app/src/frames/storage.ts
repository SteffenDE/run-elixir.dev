// storage.html, on a project's own origin: deletes what the project keeps
// there, for the projects' list on the apex (registry.ts).
import { serve } from '@/shared/lib/frames';
import { deleteOwnStores } from '@/shared/lib/registry';
import { apexOrigin, loadSite, projectOrigin } from '@/shared/lib/site';

await loadSite();
const id = projectOrigin();

serve((origin) => id !== null && origin === apexOrigin(), {
  delete: () => deleteOwnStores(id!),
});
