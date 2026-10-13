import { RiExternalLinkLine, RiRefreshLine } from '@remixicon/react';
import { useEffect, useRef, useState } from 'react';
import { built } from '../programs/tailwind';
import { useStore } from '../store';

// The app in the node, through the service worker (runtime/sw.js).
export function Preview() {
  const path = useStore((state) => state.previewPath);
  const key = useStore((state) => state.previewKey);
  const running = useStore((state) => state.serverRunning);
  const navigate = useStore((state) => state.navigate);
  const reload = useStore((state) => state.reloadPreview);
  const [typed, setTyped] = useState(path);
  const frame = useRef<HTMLIFrameElement>(null);

  // The preview reloads where it is (its own navigation kept) whenever
  // `key` changes.
  // oxlint-disable-next-line react/exhaustive-deps -- `key` is the reload signal.
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe || !running) return;
    let at = path;
    try {
      const location = iframe.contentWindow?.location;
      if (location && location.href !== 'about:blank') at = location.pathname + location.search;
    } catch {
      // Not loaded yet.
    }
    iframe.src = at;
    setTyped(at);
  }, [key, path, running]);

  // New CSS from the tailwind watcher: the page's stylesheets reload in
  // place, as Phoenix's live reload does.
  useEffect(() => {
    const refresh = () => {
      try {
        const document = frame.current?.contentDocument;
        for (const link of document?.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]') ??
          []) {
          const url = new URL(link.href);
          url.searchParams.set('vsn', String(Date.now()));
          link.href = url.href;
        }
      } catch {
        // Not loaded.
      }
    };
    built.add(refresh);
    return () => {
      built.delete(refresh);
    };
  }, []);

  return (
    <div className="preview">
      <form
        className="preview-bar"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(typed.startsWith('/') ? typed : `/${typed}`);
        }}
      >
        <button type="button" className="icon-button" onClick={reload} title="Reload">
          <RiRefreshLine size={16} />
        </button>
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          aria-label="Path"
          spellCheck={false}
        />
        <button
          type="button"
          className="icon-button"
          title="Open in a new tab (while this one runs)"
          onClick={() => window.open(typed, '_blank')}
        >
          <RiExternalLinkLine size={16} />
        </button>
      </form>
      {running ? (
        // oxlint-disable-next-line react/iframe-missing-sandbox -- the app is same-origin by design: the service worker serves it.
        <iframe
          ref={frame}
          title="Your Phoenix app"
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
        <div className="preview-waiting">Waiting for the Phoenix server…</div>
      )}
    </div>
  );
}
