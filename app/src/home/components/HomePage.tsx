import {
  RiDeleteBinLine,
  RiFireLine,
  RiFolderAddLine,
  RiSettings3Line,
  RiTerminalLine,
} from '@remixicon/react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { FolderImport } from '@/home/components/FolderImport';
import { KindChip } from '@/shared/components/KindChip';
import { moveAllFormerStores } from '@/shared/lib/migrate';
import { listProjects, type Project } from '@/shared/lib/projects';
import { projectUrl } from '@/shared/lib/site';
import { whenReleased } from '@/shared/lib/lock';
import { deleteProject, openProjects } from '@/shared/lib/storage';
import { TailscaleButton } from '@/tailscale/components/TailscaleButton';

function ago(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(time).toLocaleDateString();
}

function NewProject(props: { href: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <a className="new-project" href={props.href}>
      <span className="new-project-icon">{props.icon}</span>
      <span className="new-project-title">{props.title}</span>
      <span className="new-project-text">{props.children}</span>
    </a>
  );
}

function ProjectRow({
  project,
  open,
  onDeleted,
}: {
  project: Project;
  open: boolean;
  onDeleted(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="project-row">
      <a className="project-link" href={projectUrl(project.id)}>
        <span className="project-row-name">{project.name}</span>
        <KindChip kind={project.kind} />
        {open && <span className="chip">open in a tab</span>}
        <span className="muted project-row-time">{ago(project.openedAt)}</span>
      </a>
      {error && <span className="project-error">{error}</span>}
      {confirming ? (
        <span className="project-confirm">
          <button
            type="button"
            className="button danger"
            onClick={() =>
              deleteProject(project.id).then(onDeleted, (failed: Error) => {
                setConfirming(false);
                setError(failed.message);
              })
            }
          >
            Delete
          </button>
          <button type="button" className="button" onClick={() => setConfirming(false)}>
            Keep
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="icon-button"
          title={`Delete ${project.name}, its files and its database`}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          <RiDeleteBinLine size={16} />
        </button>
      )}
    </li>
  );
}

// The projects in this browser, and new ones.
export function HomePage() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    void Promise.all([listProjects(), openProjects()]).then(([list, held]) => {
      // What the former layout kept on the projects' own origins comes here.
      void moveAllFormerStores(list.filter((project) => !held.has(project.id)).map((p) => p.id));
      setProjects(list);
      setOpen(held);
    });
  }, []);

  useEffect(() => {
    document.title = 'Elixir Playground';
    load();
    // Back to this tab: a project may have opened in another meanwhile.
    const shown = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, [load]);

  // A project open in another tab: no longer marked once that tab lets it
  // go (leaves it, closes, crashes).
  useEffect(() => {
    const stop = new AbortController();
    for (const id of open)
      whenReleased(id, stop.signal).then(load, () => {
        // This page went on first.
      });
    return () => stop.abort();
  }, [open, load]);

  return (
    <div className="home">
      <div className="home-corner">
        <a className="icon-button" href="/settings" title="Settings" aria-label="Settings">
          <RiSettings3Line size={16} />
        </a>
        <TailscaleButton />
      </div>
      <main className="home-main">
        <h1 className="home-title">
          Elixir <span>Playground</span>
        </h1>
        <p className="muted home-lead">
          OTP and Elixir compiled to WebAssembly: everything runs in this tab. Projects are kept in
          this browser.
        </p>
        <h2>New</h2>
        <div className="new-projects">
          <NewProject href="/phoenix" icon={<RiFireLine size={20} />} title="Phoenix project">
            A <code>phx.new</code> app with its server running, LiveView, and PGlite as its
            Postgres.
          </NewProject>
          <NewProject href="/empty" icon={<RiFolderAddLine size={20} />} title="Empty project">
            An empty folder and a shell: <code>mix new</code>, <code>elixir</code>, <code>iex</code>
            .
          </NewProject>
          <NewProject href="/iex" icon={<RiTerminalLine size={20} />} title="Temporary IEx">
            An IEx shell in a project that is not kept.
          </NewProject>
        </div>
        <FolderImport />
        <h2>Projects</h2>
        {projects === null ? null : projects.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="project-list">
            {projects.map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                open={open.has(project.id)}
                onDeleted={load}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
