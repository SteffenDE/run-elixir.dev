import { Fragment, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HomePage } from '@/home/components/HomePage';
import { ImportPage } from '@/home/components/ImportPage';
import { GuestPage } from '@/live/components/GuestPage';
import { NotFound } from '@/home/components/NotFound';
import { OpenElsewhere } from '@/project/components/OpenElsewhere';
import { ProjectPage } from '@/project/components/ProjectPage';
import { TailscalePage } from '@/tailscale/components/TailscalePage';
import { endSession, leaveSession } from '@/live/lib/host';
import { leave, shutdown } from '@/project/lib/playground';
import { useStore } from '@/project/lib/store';
import { dropFramesOnLeave } from '@/shared/lib/leave';
import { moveFormerStores } from '@/shared/lib/migrate';
import { claimProject, onProjectRelease, releaseProject, takeOverProject } from '@/shared/lib/lock';
import { routeWith } from '@/shared/lib/navigate';
import { createProject, getProject, isId, openedProject, type Kind } from '@/shared/lib/projects';
import { loadSite, movedTo, previewSite, projectUrl, strayOrigin } from '@/shared/lib/site';
import '@/styles.css';

// The tab goes from page to page in place (navigate.ts): links to these
// routes, back and forward render the next page here, so what lives as long
// as the tab (the Tailscale node's connection) stays. Leaving a project
// ends what it ran, as a load would (leaveProject); a live session's
// guest's page is left by a load. One page runs a project at a time
// (lock.ts).
//
//   /           the projects, and new ones
//   /ID/        a project
//   /phoenix    a new Phoenix project; /empty, a new empty one
//   /iex        a temporary IEx, kept nowhere
//   /import#…   a shared project's link
//   /tailscale  this browser's Tailscale node (docs/tailscale.md)
//   /live/ID#…  a live session's link, to join it
//
// All of them on the apex (site.ts). A project's former origin (p-ID) and
// a guest's (l-ID) go to the apex's address; a preview origin opened by
// itself, and any other name, is not found.
const SHORTCUTS: Record<string, Kind> = { phoenix: 'phoenix', empty: 'empty' };

// What leaving the page now shown takes: nothing, its teardown, or a load
// (a guest's page).
let leaving: (() => Promise<void>) | 'load' | null = null;

async function leaveProject(): Promise<void> {
  leaveSession();
  await leave();
  releaseProject();
}

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
  if (name === 'tailscale') return <TailscalePage />;
  if (name === 'live') {
    const session = path.split('/').filter(Boolean)[1] ?? '';
    if (!/^[\w-]{22}$/.test(session)) return <NotFound />;
    leaving = 'load';
    return <GuestPage session={session} />;
  }
  if (name === 'iex') {
    document.title = 'IEx · Elixir Playground';
    leaving = leaveProject;
    return <ProjectPage project={null} />;
  }
  if (SHORTCUTS[name]) {
    const project = await createProject(SHORTCUTS[name]);
    history.replaceState(null, '', projectUrl(project.id));
    return projectPage(project.id, location.pathname);
  }
  if (!isId(name)) return <NotFound />;
  return projectPage(name, path);
}

// Project `id`'s page, at /ID/.
async function projectPage(id: string, path: string): Promise<ReactNode> {
  const project = await getProject(id);
  if (!project) return <NotFound project />;
  // Its stores from the former layout (p-ID), if this browser has any.
  await moveFormerStores(project.id);
  const home = `/${project.id}/`;
  if (path !== home) history.replaceState(null, '', home);
  document.title = `${project.name} · Elixir Playground`;
  leaving = leaveProject;
  // Asked to let go: stop here first. Taken (after not answering): stop.
  onProjectRelease(
    () => endSession().then(shutdown),
    () => {
      void endSession();
      void shutdown();
      useStore.getState().setElsewhere(true);
    },
  );
  const here = shown;
  const run = () => {
    void openedProject(project.id);
    return <ProjectPage project={project} />;
  };
  if (await claimProject(project.id)) return run();
  return (
    <OpenElsewhere
      project={project}
      onOpenHere={() =>
        takeOverProject(project.id).then(() => {
          if (shown === here) render(run());
        })
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

// The app's routes (the rest, as /preview.html or a build's files, load).
const isRoute = ({ pathname }: URL) => {
  const name = pathname.split('/').filter(Boolean)[0] ?? '';
  return (
    !name ||
    ['import', 'tailscale', 'live', 'iex', ...Object.keys(SHORTCUTS)].includes(name) ||
    isId(name)
  );
};

dropFramesOnLeave();
const root = createRoot(document.getElementById('root')!);
// Which page shows (each a new one: its components start afresh).
let shown = 0;
const render = (content: ReactNode) =>
  root.render(
    <StrictMode>
      <Fragment key={shown}>{content}</Fragment>
    </StrictMode>,
  );

// One page after another: the last one's teardown, then the next.
let path: string | null = null;
async function show(url: URL): Promise<void> {
  // The page shown already (a link to it, a change of its #…).
  if (url.pathname === path) return;
  path = url.pathname;
  const before = leaving;
  if (before === 'load') return location.assign(url);
  leaving = null;
  shown++;
  if (before) {
    root.render(null);
    await before();
  }
  const content = await page(url.pathname);
  // Where it went (a project's /ID/, after a shortcut).
  path = location.pathname;
  if (content) render(content);
}

let showing = Promise.resolve();
const go = (url: URL) => {
  showing = showing.then(() => show(url)).catch((error: unknown) => console.error(error));
};
routeWith(isRoute, go);
go(new URL(location.href));
