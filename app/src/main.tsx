import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HomePage } from '@/home/components/HomePage';
import { ImportPage } from '@/home/components/ImportPage';
import { NotFound } from '@/home/components/NotFound';
import { OpenElsewhere } from '@/project/components/OpenElsewhere';
import { ProjectPage } from '@/project/components/ProjectPage';
import { shutdown } from '@/project/lib/playground';
import { useStore } from '@/project/lib/store';
import { claimProject, onProjectRelease, takeOverProject } from '@/shared/lib/lock';
import { createProject, isId, type Kind } from '@/shared/lib/projects';
import { getProject, heldOpen, openedProject } from '@/shared/lib/registry';
import { loadSite, onDomain, projectOrigin, projectUrl, strayOrigin } from '@/shared/lib/site';
import '@/styles.css';

// Pages are whole page loads: a project's page owns its workers, and
// leaving it ends them. One page runs a project at a time (lock.ts).
//
//   /           the projects, and new ones
//   /ID/        a project
//   /phoenix    a new Phoenix project; /empty, a new empty one
//   /iex        a temporary IEx, kept nowhere
//   /import#…   a shared project's link
//
// With a project domain (site.ts), a project is its own origin's /, and
// the rest is the apex's; an old /ID/ link on the apex goes there. Any
// other name under the domain is reserved: not found.
const SHORTCUTS: Record<string, Kind> = { phoenix: 'phoenix', empty: 'empty' };

async function page(path: string): Promise<ReactNode> {
  await loadSite();
  if (strayOrigin()) return <NotFound />;
  const own = projectOrigin();
  if (own) return projectPage(own, path);
  const name = path.split('/').filter(Boolean)[0] ?? '';
  if (!name) return <HomePage />;
  if (name === 'import') return <ImportPage />;
  if (name === 'iex') {
    document.title = 'IEx · Elixir Playground';
    return <ProjectPage project={null} />;
  }
  if (SHORTCUTS[name]) {
    const project = await createProject(SHORTCUTS[name]);
    location.replace(projectUrl(project.id));
    return null;
  }
  if (!isId(name)) return <NotFound />;
  if (onDomain()) {
    location.replace(projectUrl(name));
    return null;
  }
  return projectPage(name, path);
}

// Project `id`'s page, at its path (/ID/, or its own origin's /).
async function projectPage(id: string, path: string): Promise<ReactNode> {
  const project = await getProject(id);
  if (!project) return <NotFound project />;
  const home = projectOrigin() ? '/' : `/${project.id}/`;
  if (path !== home) history.replaceState(null, '', home);
  document.title = `${project.name} · Elixir Playground`;
  // Asked to let go: stop here first. Taken (after not answering): stop.
  onProjectRelease(shutdown, () => {
    void shutdown();
    useStore.getState().setElsewhere(true);
  });
  const run = () => {
    void openedProject(project.id);
    void heldOpen();
    return <ProjectPage project={project} />;
  };
  if (await claimProject(project.id)) return run();
  return (
    <OpenElsewhere
      project={project}
      onOpenHere={() =>
        takeOverProject(project.id).then(() => root.render(<StrictMode>{run()}</StrictMode>))
      }
    />
  );
}

const root = createRoot(document.getElementById('root')!);
void page(location.pathname).then((content) => {
  if (content) root.render(<StrictMode>{content}</StrictMode>);
});
