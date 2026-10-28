import { Fragment, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HomePage } from '@/home/components/HomePage';
import { ImportPage } from '@/home/components/ImportPage';
import { RepositoryPage } from '@/home/components/RepositoryPage';
import { GuestPage } from '@/live/components/GuestPage';
import { NotFound } from '@/home/components/NotFound';
import { OpenElsewhere } from '@/project/components/OpenElsewhere';
import { ProjectPage } from '@/project/components/ProjectPage';
import { SettingsPage } from '@/settings/components/SettingsPage';
import { TailscalePage } from '@/tailscale/components/TailscalePage';
import { RelayPage } from '@/relay/components/RelayPage';
import { endSession } from '@/live/lib/host';
import { BackToProject } from '@/project/components/BackToProject';
import { LeaveDialog } from '@/project/components/LeaveDialog';
import { mayLeave, stopActive, useActive } from '@/project/lib/active';
import { shutdown } from '@/project/lib/playground';
import { useStore } from '@/project/lib/store';
import { dropFramesOnLeave } from '@/shared/lib/leave';
import { moveFormerStores } from '@/shared/lib/migrate';
import { claimProject, onProjectRelease, takeOverProject } from '@/shared/lib/lock';
import { routeWith } from '@/shared/lib/navigate';
import { createProject, getProject, isId, openedProject, type Kind } from '@/shared/lib/projects';
import { isRepositoryPath, repositoryOfPath, repositoryPath } from '@/shared/lib/repository';
import {
  loadSite,
  movedTo,
  previewSite,
  projectUrl,
  strayOrigin,
} from '@elixir-playground/runtime/lib/site';
import '@/styles.css';

// The tab goes from page to page in place (navigate.ts): links to these
// routes, back and forward render the next page here, so what lives as long
// as the tab (the Tailscale node's connection) stays. A project keeps
// running while the tab shows the projects, settings or Tailscale
// (BackToProject goes back to it), and stops when the tab goes to another
// project, its unsaved edits saved or discarded first (active.ts); a live
// session's guest's page is left by a load. One page runs a project at a
// time (lock.ts).
//
//   /           the projects, and new ones
//   /ID/        a project
//   /phoenix    a new Phoenix project; /empty, a new empty one
//   /iex        a temporary IEx, kept nowhere
//   /import#…   a shared project's link
//   /github/OWNER/REPO[/tree/REF]  a public repository, to clone into a
//               new project (/gitlab/…, /codeberg/… too: repository.ts)
//   /tailscale  this browser's Tailscale node (docs/tailscale.md)
//   /relay      what the site's TCP relay is (docs/relay.md)
//   /settings   the user's settings for every project (settings.ts)
//   /live/ID#…  a live session's link, to join it
//
// All of them on the apex (site.ts). A project's former origin (p-ID) and
// a guest's (l-ID) go to the apex's address; a preview origin opened by
// itself, and any other name, is not found.
const SHORTCUTS: Record<string, Kind> = { phoenix: 'phoenix', empty: 'empty' };

// Whether leaving the page now shown takes a load (a guest's page).
let leaving: 'load' | null = null;

// The project a path opens (its id, 'iex', 'new' for a new one, 'live' for
// a live session's), or null for another page.
function projectOf(pathname: string): string | null {
  const name = pathname.split('/').filter(Boolean)[0] ?? '';
  if (name === 'iex' || name === 'live') return name;
  if (SHORTCUTS[name]) return 'new';
  return isId(name) ? name : null;
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
  if (isRepositoryPath(name)) {
    const repository = repositoryOfPath(path);
    if (!repository) return <NotFound />;
    // The site's own form of the address.
    if (path !== repositoryPath(repository))
      history.replaceState(null, '', repositoryPath(repository));
    return <RepositoryPage repository={repository} />;
  }
  if (name === 'tailscale') return <TailscalePage />;
  if (name === 'relay') return <RelayPage />;
  if (name === 'settings') return <SettingsPage />;
  if (name === 'live') {
    const session = path.split('/').filter(Boolean)[1] ?? '';
    if (!/^[\w-]{22}$/.test(session)) return <NotFound />;
    leaving = 'load';
    return <GuestPage session={session} />;
  }
  if (name === 'iex') {
    document.title = 'IEx · Elixir Playground';
    useActive.setState({ active: { key: 'iex', project: null, name: 'IEx', path: '/iex' } });
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
  // Back to the project this tab runs: as it was.
  const active = useActive.getState().active;
  if (active?.key === project.id) {
    useActive.setState({ active: { ...active, project, name: project.name } });
    return <ProjectPage project={project} />;
  }
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
    useActive.setState({
      active: { key: project.id, project, name: project.name, path: home },
    });
    return <ProjectPage project={project} />;
  };
  if (await claimProject(project.id)) return run();
  // Open in another tab: here once asked to (that tab lets go), or once
  // that tab lets it go by itself; another tab may take it first.
  let attempt = 0;
  const elsewhere = (): ReactNode => (
    <OpenElsewhere
      key={attempt++}
      project={project}
      onOpenHere={() =>
        takeOverProject(project.id).then(() => {
          if (shown === here) render(run());
        })
      }
      onReleased={() =>
        claimProject(project.id).then((claimed) => {
          if (shown === here) render(claimed ? run() : elsewhere());
        })
      }
    />
  );
  return elsewhere();
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
    ['import', 'tailscale', 'relay', 'settings', 'live', 'iex', ...Object.keys(SHORTCUTS)].includes(
      name,
    ) ||
    isRepositoryPath(name) ||
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
      <BackToProject />
      <LeaveDialog />
    </StrictMode>,
  );

// One page after another: the last one's teardown, then the next.
let path: string | null = null;
async function show(url: URL): Promise<void> {
  // The page shown already (a link to it, a change of its #…).
  if (url.pathname === path) return;
  // Another project than the one this tab runs: that one stops, once its
  // unsaved edits are saved or discarded. Staying keeps the page shown.
  const active = useActive.getState().active;
  const target = projectOf(url.pathname);
  const switching = active !== null && target !== null && target !== active.key;
  if (switching && !(await mayLeave())) {
    history.pushState(null, '', path ?? '/');
    return;
  }
  path = url.pathname;
  if (leaving === 'load') return location.assign(url);
  shown++;
  if (switching) {
    render(null);
    await stopActive();
  }
  const content = await page(url.pathname);
  // Where it went (a project's /ID/, after a shortcut).
  path = location.pathname;
  useActive.setState({ here: path });
  if (content) render(content);
}

let showing = Promise.resolve();
const go = (url: URL) => {
  showing = showing.then(() => show(url)).catch((error: unknown) => console.error(error));
};
routeWith(isRoute, go);
go(new URL(location.href));
