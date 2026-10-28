import {
  RiArrowLeftLine,
  RiCheckLine,
  RiFileCopyLine,
  RiLinkM,
  RiLiveLine,
  RiShareLine,
} from '@remixicon/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { HostPanel } from '@/live/components/HostPanel';
import { People } from '@/live/components/People';
import type { HostProject } from '@/live/lib/host';
import { useLive } from '@/live/lib/store';
import { shareable } from '@/project/lib/playground';
import { encodeShared } from '@elixir-playground/runtime/lib/share';
import { apexUrl } from '@elixir-playground/runtime/lib/site';

interface Link {
  url: string;
  files: number;
  removed: number;
}

// Where a link of this length stops working (measured: Chromium opens
// 2 MB links, Firefox 1 MB; the rest are the services' message limits).
function sizeNote(length: number): string | null {
  if (length > 2_000_000) return 'Too long for any browser to open (over 2 MB).';
  if (length > 1_000_000) return 'Too long for Firefox to open (over 1 MB); Chrome opens it.';
  if (length > 40_000)
    return 'Longer than a Slack message; send it some other way, such as by email.';
  if (length > 2_000) return 'Longer than a Discord message.';
  return null;
}

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;

type View = 'choose' | 'link' | 'live';

// Share, in a popover under the button: a link to this project's changes
// over its template (its sources: no builds, dependencies or database),
// or a live session of it (src/live). While a session runs, the button
// shows who is in and opens on it.
export function ShareButton({ project }: { project: HostProject }) {
  const [view, setView] = useState<View | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const hosting = useLive((state) => state.role === 'host');
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = view !== null;
  // A temporary IEx is kept nowhere: no link to it, only a live session.
  const linkable = project.id !== null;

  const makeLink = async () => {
    setView('link');
    setCopied(false);
    setLink(null);
    try {
      const shared = await shareable(project.name, project.template);
      const url = new URL(apexUrl(`/import#${await encodeShared(shared)}`), location.href).href;
      setLink({ url, files: Object.keys(shared.files).length, removed: shared.removed.length });
      setError(null);
      await navigator.clipboard.writeText(url).then(
        () => setCopied(true),
        () => {},
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  // Placed again when the view (and its size) changes.
  // oxlint-disable-next-line react/exhaustive-deps -- `view` is the signal.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !open) return;
    if (!element.matches(':popover-open')) element.showPopover();
    const anchor = button.current!.getBoundingClientRect();
    const width = element.getBoundingClientRect().width;
    element.style.top = `${anchor.bottom + 6}px`;
    element.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
  }, [open, view]);

  const close = () => {
    setView(null);
    setLink(null);
    setError(null);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={hosting ? 'button live' : 'button'}
        title={hosting ? 'The live session' : 'Share this project'}
        onClick={() => (open ? close() : setView(hosting ? 'live' : linkable ? 'choose' : 'live'))}
      >
        {hosting ? <RiLiveLine size={16} /> : <RiShareLine size={16} />}
        <span className="button-label">{hosting ? 'Live' : 'Share'}</span>
        {hosting && <People />}
      </button>
      {open && (
        <div
          ref={panel}
          className="share-panel"
          popover="auto"
          onToggle={(event) => {
            if (event.newState === 'closed') close();
          }}
        >
          {view === 'choose' && (
            <div className="share-choices">
              <button type="button" className="share-choice" onClick={() => void makeLink()}>
                <RiLinkM size={20} />
                <span>
                  <strong>Link</strong>
                  <span className="muted">
                    A copy of this project's files. Opening it makes a new project.
                  </span>
                </span>
              </button>
              <button type="button" className="share-choice" onClick={() => setView('live')}>
                <RiLiveLine size={20} />
                <span>
                  <strong>Live session</strong>
                  <span className="muted">
                    Others join this project as it runs here, and edit it if you let them.
                  </span>
                </span>
              </button>
            </div>
          )}
          {view !== 'choose' && linkable && !hosting && (
            <button type="button" className="share-back" onClick={() => setView('choose')}>
              <RiArrowLeftLine size={14} /> Share
            </button>
          )}
          {view === 'live' && <HostPanel project={project} />}
          {view === 'link' && error && <p className="project-error">{error}</p>}
          {view === 'link' && !error && !link && <p className="muted">Making the link…</p>}
          {view === 'link' && link && (
            <>
              <p className="share-summary">
                {link.files} {link.files === 1 ? 'file' : 'files'}
                {link.removed ? `, ${link.removed} removed` : ''} · {size(link.url.length)}
              </p>
              <div className="share-row">
                <input
                  className="share-url"
                  readOnly
                  value={link.url}
                  aria-label="Link to this project"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(link.url).then(() => setCopied(true))
                  }
                >
                  {copied ? <RiCheckLine size={16} /> : <RiFileCopyLine size={16} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              {sizeNote(link.url.length) && (
                <p className="share-warning">{sizeNote(link.url.length)}</p>
              )}
              <p className="muted share-note">
                The link contains the project's file changes. Build outputs, dependencies and
                database contents are excluded. Opening the link creates a new project.
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}
