import { RiExternalLinkLine, RiRefreshLine } from '@remixicon/react';
import { useEffect, useRef, useState } from 'react';

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
// (runtime/sw.js), with a path bar.
export function PreviewFrame({
  running,
  path,
  navigation,
  reload,
  css,
  onNavigate,
  onReload,
  onPopOut,
}: Props) {
  const [typed, setTyped] = useState(path);
  const frame = useRef<HTMLIFrameElement>(null);
  // Where a reload goes when the preview has not loaded anything yet.
  const fallback = useRef(path);
  fallback.current = path;

  useEffect(() => {
    if (!frame.current || !running) return;
    frame.current.src = path;
    setTyped(path);
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
          onNavigate(typed.startsWith('/') ? typed : `/${typed}`);
        }}
      >
        <button type="button" className="icon-button" onClick={onReload} title="Reload">
          <RiRefreshLine size={16} />
        </button>
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          aria-label="Path"
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
              if (location) setTyped(location.pathname + location.search);
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
