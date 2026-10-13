import { RiCheckLine, RiFileCopyLine, RiShareLine } from '@remixicon/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { shareable } from '@/project/lib/playground';
import { encodeShared } from '@/shared/lib/share';

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

// A link to this project's changes over its template (its sources: no
// builds, dependencies or database), copied, in a popover under the
// button.
export function ShareButton({ name }: { name: string }) {
  const [link, setLink] = useState<Link | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = link !== null || error !== null;

  const share = async () => {
    setCopied(false);
    try {
      const shared = await shareable(name);
      const url = `${location.origin}/import#${await encodeShared(shared)}`;
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

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !open) return;
    element.showPopover();
    const anchor = button.current!.getBoundingClientRect();
    const width = element.getBoundingClientRect().width;
    element.style.top = `${anchor.bottom + 6}px`;
    element.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
    return () => {
      if (element.matches(':popover-open')) element.hidePopover();
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="button"
        title="Share this project as a link"
        onClick={() => (open ? (setLink(null), setError(null)) : void share())}
      >
        <RiShareLine size={16} />
        <span className="button-label">Share</span>
      </button>
      {open && (
        <div
          ref={panel}
          className="share-panel"
          popover="auto"
          onToggle={(event) => {
            if (event.newState === 'closed') {
              setLink(null);
              setError(null);
            }
          }}
        >
          {error ? (
            <p className="project-error">{error}</p>
          ) : (
            <>
              <p className="share-summary">
                {link!.files} {link!.files === 1 ? 'file' : 'files'}
                {link!.removed ? `, ${link!.removed} removed` : ''} · {size(link!.url.length)}
              </p>
              <div className="share-row">
                <input
                  className="share-url"
                  readOnly
                  value={link!.url}
                  aria-label="Link to this project"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(link!.url).then(() => setCopied(true))
                  }
                >
                  {copied ? <RiCheckLine size={16} /> : <RiFileCopyLine size={16} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              {sizeNote(link!.url.length) && (
                <p className="share-warning">{sizeNote(link!.url.length)}</p>
              )}
              <p className="muted share-note">
                The link holds what this project changed: its files, not its builds, dependencies or
                database. Opening it makes a new project.
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}
