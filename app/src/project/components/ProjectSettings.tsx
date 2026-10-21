import { RiArrowRightUpLine, RiSettings3Line } from '@remixicon/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { refreshSettings } from '@/project/lib/playground';
import { EnvEditor } from '@/shared/components/EnvEditor';
import { getProject, updateProject, type Project } from '@/shared/lib/projects';
import { apexUrl } from '@/shared/lib/site';

// The top bar's settings for this project, in a popover: what its first
// shell runs at each start, its environment over the user's, and (one from
// a link or a fork) whether it takes the user's settings.
export function ProjectSettings({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<Project | null>(null);
  const [saved, setSaved] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !open || !current) return;
    if (!element.matches(':popover-open')) element.showPopover();
    const anchor = button.current!.getBoundingClientRect();
    const width = element.getBoundingClientRect().width;
    element.style.top = `${anchor.bottom + 6}px`;
    element.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
  }, [open, current]);
  const toggle = async () => {
    if (open) return setOpen(false);
    setCurrent((await getProject(project.id)) ?? project);
    setSaved(false);
    setOpen(true);
  };
  const change = (changes: Partial<Project>) => {
    setCurrent({ ...current!, ...changes });
    setSaved(false);
  };
  const save = async () => {
    const { startup, env, trust } = current!;
    await updateProject(project.id, { startup, env, trust });
    await refreshSettings();
    setSaved(true);
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className="icon-button settings-button"
        title="Project settings"
        aria-label="Project settings"
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        <RiSettings3Line size={18} />
      </button>
      {open && current && (
        <div
          ref={panel}
          className="share-panel tailscale-menu project-settings"
          popover="auto"
          onToggle={(event) => {
            if (event.newState === 'closed') setOpen(false);
          }}
        >
          <h3>At each start</h3>
          <p className="muted">Run these commands in the project's first shell on startup.</p>
          <textarea
            className="settings-script"
            aria-label="Startup lines"
            spellCheck={false}
            rows={3}
            placeholder="Start an empty shell"
            value={current.startup}
            onChange={(event) => change({ startup: event.target.value })}
          />
          <h3>Environment</h3>
          <p className="muted">
            These variables override your global environment variables in new shells for this
            project.
          </p>
          <EnvEditor
            label="Project environment"
            env={current.env ?? {}}
            onChange={(env) => change({ env })}
          />
          {current.origin && (
            <label className="live-check">
              <input
                type="checkbox"
                checked={current.trust === true}
                onChange={(event) => change({ trust: event.target.checked })}
              />
              Use my settings in this project (it came from{' '}
              {current.origin === 'link' ? 'a link' : 'a live session'})
            </label>
          )}
          <div className="settings-save">
            <button type="button" className="button primary" onClick={() => void save()}>
              Save
            </button>
            {saved && (
              <span className="muted">
                Saved. Environment changes apply to new shells. Startup commands apply at the next
                start or restart. Permission changes apply when the project restarts.
              </span>
            )}
          </div>
          <a
            className="tailscale-settings"
            href={apexUrl('/settings')}
            target="_blank"
            rel="noopener"
          >
            <RiArrowRightUpLine size={14} /> Your settings for every project
          </a>
        </div>
      )}
    </>
  );
}
