import { RiExternalLinkLine, RiRefreshLine } from '@remixicon/react';
import { useEffect, useRef, useState } from 'react';
import { shownAddress, typedPath } from '@/project/lib/address';

// Stylesheets reload in place (as Phoenix's live reload does).
export function refreshStylesheets(iframe: HTMLIFrameElement | null): void {
  try {
    for (const link of iframe?.contentDocument?.querySelectorAll<HTMLLinkElement>(
      'link[rel=stylesheet]',
    ) ?? []) {
      const url = new URL(link.href);
      url.searchParams.set('vsn', String(Date.now()));
      link.href = url.href;
    }
  } catch {
    // Not loaded.
  }
}

interface Props {
  running: boolean;
  // The app's port the preview shows (null: not known yet).
  port: number | null;
  // Go to `path` whenever `navigation` changes; reload in place whenever
  // `reload` changes; refresh stylesheets whenever `css` changes.
  path: string;
  navigation: number;
  reload: number;
  css: number;
  onNavigate(path: string): void;
  onReload(): void;
  onPopOut?: () => void;
}

// The app in the node, in an iframe the service worker serves
// (src/runtime/sw.js), with a path bar.
export function PreviewFrame({
  running,
  port,
  path,
  navigation,
  reload,
  css,
  onNavigate,
  onReload,
  onPopOut,
}: Props) {
  const [typed, setTyped] = useState(shownAddress(port, path));
  // Where the preview is, for the path bar when the port changes.
  const [at, setAt] = useState(path);
  useEffect(() => setTyped(shownAddress(port, at)), [port, at]);
  const frame = useRef<HTMLIFrameElement>(null);
  // Where a reload goes when the preview has not loaded anything yet.
  const fallback = useRef(path);
  fallback.current = path;

  useEffect(() => {
    if (!frame.current || !running) return;
    frame.current.src = path;
    if (!path.startsWith('/__playground/')) setAt(path);
  }, [navigation, path, running]);

  // oxlint-disable-next-line react/exhaustive-deps -- `reload` is the signal.
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe || !running || reload === 0) return;
    try {
      const location = iframe.contentWindow?.location;
      if (location && location.href !== 'about:blank') {
        iframe.src = location.pathname + location.search;
        return;
      }
    } catch {
      // Not loaded yet.
    }
    iframe.src = fallback.current;
  }, [reload, running]);

  useEffect(() => {
    if (css) refreshStylesheets(frame.current);
  }, [css]);

  return (
    <div className="preview">
      <form
        className="bar preview-bar"
        onSubmit={(event) => {
          event.preventDefault();
          onNavigate(typedPath(typed, port));
        }}
      >
        <button type="button" className="icon-button" onClick={onReload} title="Reload">
          <RiRefreshLine size={16} />
        </button>
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          aria-label="Address"
          spellCheck={false}
        />
        {onPopOut && (
          <button
            type="button"
            className="icon-button"
            title="Pop out into its own window"
            onClick={onPopOut}
          >
            <RiExternalLinkLine size={16} />
          </button>
        )}
      </form>
      {running ? (
        // oxlint-disable-next-line react/iframe-missing-sandbox -- the app is same-origin by design: the service worker serves it.
        <iframe
          ref={frame}
          title="Your app"
          onLoad={() => {
            try {
              const location = frame.current?.contentWindow?.location;
              if (location) setAt(location.pathname + location.search);
            } catch {
              // Cross-origin: leave it.
            }
          }}
        />
      ) : (
        <div className="preview-waiting">Waiting for the server…</div>
      )}
    </div>
  );
}
