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
import { createProject, getProject, isId, openedProject, type Kind } from '@/shared/lib/projects';
import '@/styles.css';

// Pages are whole page loads: a project's page owns its workers, and
// leaving it ends them. One page runs a project at a time (lock.ts).
//
//   /           the projects, and new ones
//   /ID/        a project
//   /phoenix    a new Phoenix project; /empty, a new empty one
//   /iex        a temporary IEx, kept nowhere
//   /import#…   a shared project's link
const SHORTCUTS: Record<string, Kind> = { phoenix: 'phoenix', empty: 'empty' };

async function page(path: string): Promise<ReactNode> {
  const name = path.split('/').filter(Boolean)[0] ?? '';
  if (!name) return <HomePage />;
  if (name === 'import') return <ImportPage />;
  if (name === 'iex') {
    document.title = 'IEx · Elixir Playground';
    return <ProjectPage project={null} />;
  }
  if (SHORTCUTS[name]) {
    const project = await createProject(SHORTCUTS[name]);
    location.replace(`/${project.id}/`);
    return null;
  }
  const project = isId(name) ? await getProject(name) : undefined;
  if (!project) return <NotFound />;
  if (path !== `/${project.id}/`) history.replaceState(null, '', `/${project.id}/`);
  document.title = `${project.name} · Elixir Playground`;
  // Asked to let go: stop here first. Taken (after not answering): stop.
  onProjectRelease(shutdown, () => {
    void shutdown();
    useStore.getState().setElsewhere(true);
  });
  const run = () => {
    void openedProject(project.id);
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
