// registry.html, on the apex: the projects' list for a project's page on
// its own origin (registry.ts). A caller is a project by its origin, and
// asks only about itself.
import { serve } from '@/shared/lib/frames';
import * as projects from '@/shared/lib/projects';
import { apexPartitioned, loadSite, projectOf } from '@/shared/lib/site';
import { projectLock } from '@/shared/lib/storage';
import type { Template } from '@/shared/lib/templates';

await loadSite();
const id = (origin: string) => projectOf(origin)!;

serve((origin) => projectOf(origin) !== null, {
  get: (origin) => projects.getProject(id(origin)),
  partitioned: () => apexPartitioned(),
  opened: (origin) => projects.openedProject(id(origin)),
  rename: (origin, name: string) => {
    if (typeof name !== 'string' || !name.trim()) throw new Error('no name');
    return projects.renameProject(id(origin), name.trim().slice(0, 200));
  },
  templateSeen: (origin, template: Template) => projects.templateSeen(id(origin), template),
  takeSeed: (origin) => projects.takeSeed(id(origin)),
  seedTaken: (origin) => projects.seedTaken(id(origin)),
  // Held while the project's page (this frame's parent) lives: the
  // projects' list sees it open, as it sees a project's page without a
  // project domain.
  hold: (origin) => {
    void navigator.locks.request(projectLock(id(origin)), () => new Promise<void>(() => {}));
  },
});
