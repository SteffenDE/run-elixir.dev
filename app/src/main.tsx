import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HomePage } from '@/home/components/HomePage';
import { ImportPage } from '@/home/components/ImportPage';
import { GuestPage } from '@/live/components/GuestPage';
import { NotFound } from '@/home/components/NotFound';
import { OpenElsewhere } from '@/project/components/OpenElsewhere';
import { ProjectPage } from '@/project/components/ProjectPage';
import { endSession } from '@/live/lib/host';
import { shutdown } from '@/project/lib/playground';
import { useStore } from '@/project/lib/store';
import { dropFramesOnLeave } from '@/shared/lib/leave';
import { claimProject, onProjectRelease, takeOverProject } from '@/shared/lib/lock';
import { createProject, getProject, isId, openedProject, type Kind } from '@/shared/lib/projects';
import { loadSite, movedTo, previewSite, projectUrl, strayOrigin } from '@/shared/lib/site';
import '@/styles.css';

// Pages are whole page loads: a project's page owns its workers, and
// leaving it ends them. One page runs a project at a time (lock.ts).
//
//   /           the projects, and new ones
//   /ID/        a project
//   /phoenix    a new Phoenix project; /empty, a new empty one
//   /iex        a temporary IEx, kept nowhere
//   /import#…   a shared project's link
//   /live/ID#…  a live session's link, to join it
//
// All of them on the apex (site.ts). A project's former origin (p-ID) and
// a guest's (l-ID) go to the apex's address; a preview origin opened by
// itself, and any other name, is not found.
const SHORTCUTS: Record<string, Kind> = { phoenix: 'phoenix', empty: 'empty' };

async function page(path: string): Promise<ReactNode> {
  await loadSite();
  const moved = movedTo();
  if (moved) {
    location.replace(moved + location.hash);
    return null;
  }
  // A preview origin (v-ID-PORT) opened by itself: the app is shown in the IDE.
  if (strayOrigin() || previewSite()) return <NotFound />;
  const name = path.split('/').filter(Boolean)[0] ?? '';
  if (!name) return <HomePage />;
  if (name === 'import') return <ImportPage />;
  if (name === 'live') {
    const session = path.split('/').filter(Boolean)[1] ?? '';
    if (!/^[\w-]{22}$/.test(session)) return <NotFound />;
    return <GuestPage session={session} />;
  }
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
  return projectPage(name, path);
}

// Project `id`'s page, at /ID/.
async function projectPage(id: string, path: string): Promise<ReactNode> {
  const project = await getProject(id);
  if (!project) return <NotFound project />;
  const home = `/${project.id}/`;
  if (path !== home) history.replaceState(null, '', home);
  document.title = `${project.name} · Elixir Playground`;
  // Asked to let go: stop here first. Taken (after not answering): stop.
  onProjectRelease(
    () => endSession().then(shutdown),
    () => {
      void endSession();
      void shutdown();
      useStore.getState().setElsewhere(true);
    },
  );
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

// The installed app (Add to Home Screen) does not zoom, as an app would not.
// In a tab, iOS zooms in on a field whose text is under 16 px when it takes
// focus (the editor, a terminal, the address bar) and stays zoomed in; a
// maximum scale stops that, and Safari's tabs still pinch-zoom (they ignore
// the limit for pinching; the installed app does not). Android's tabs would
// stop pinching, and do not zoom on focus: only iOS's (-webkit-touch-callout
// is iOS's).
const viewport = document.querySelector<HTMLMetaElement>('meta[name=viewport]')!;
if (matchMedia('(display-mode: standalone)').matches)
  viewport.content += ', maximum-scale=1, user-scalable=no';
else if (CSS.supports('-webkit-touch-callout', 'none')) viewport.content += ', maximum-scale=1';

dropFramesOnLeave();
const root = createRoot(document.getElementById('root')!);
void page(location.pathname).then((content) => {
  if (content) root.render(<StrictMode>{content}</StrictMode>);
});
