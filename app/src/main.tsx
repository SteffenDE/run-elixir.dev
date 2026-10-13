import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HomePage } from '@/home/components/HomePage';
import { NotFound } from '@/home/components/NotFound';
import { ProjectPage } from '@/project/components/ProjectPage';
import { createProject, getProject, isId, openedProject, type Kind } from '@/shared/lib/projects';
import '@/styles.css';

// Pages are whole page loads: a project's page owns its workers, and
// leaving it ends them.
//
//   /           the projects, and new ones
//   /ID/        a project
//   /phoenix    a new Phoenix project; /empty, a new empty one
//   /iex        a temporary IEx, kept nowhere
const SHORTCUTS: Record<string, Kind> = { phoenix: 'phoenix', empty: 'empty' };

async function page(path: string): Promise<ReactNode> {
  const name = path.split('/').filter(Boolean)[0] ?? '';
  if (!name) return <HomePage />;
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
  void openedProject(project.id);
  return <ProjectPage project={project} />;
}

const root = createRoot(document.getElementById('root')!);
void page(location.pathname).then((content) => {
  if (content) root.render(<StrictMode>{content}</StrictMode>);
});
