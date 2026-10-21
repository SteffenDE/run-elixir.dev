import { RiExternalLinkLine, RiRefreshLine } from '@remixicon/react';
import { useEffect, useRef, useState } from 'react';
import { shownAddress, typedPath } from '@/project/lib/address';

interface Props {
  running: boolean;
  // The app's port the preview shows (null: not known yet).
  port: number | null;
  // Go to `path` whenever `navigation` changes; reload in place whenever
  // `reload` changes.
  path: string;
  navigation: number;
  reload: number;
  onNavigate(path: string): void;
  onReload(): void;
  onPopOut?: () => void;
  // Where the preview shows a port, on the usercontent domain (site.ts
  // previewOrigin); without, the preview is this page's origin.
  originOf?: (port: number) => string | null;
  // Before a port's origin loads: its relay (previewOrigins.ts).
  prepare?: (port: number) => Promise<void>;
  // The preview went to another of the app's ports (a link, a redirect).
  onPort?: (port: number) => void;
}

const SWITCH = /^\/__playground\/port\/(\d+)(\/.*)?$/;

// The app in the node, in an iframe the service worker serves
// (src/runtime/sw.js), with a path bar.
export function PreviewFrame({
  running,
  port,
  path,
  navigation,
  reload,
  onNavigate,
  onReload,
  onPopOut,
  originOf,
  prepare,
  onPort,
}: Props) {
  const [typed, setTyped] = useState(shownAddress(port, path));
  // Where the preview is, for the path bar when the port changes.
  const [at, setAt] = useState(path);
  useEffect(() => setTyped(shownAddress(port, at)), [port, at]);
  const frame = useRef<HTMLIFrameElement>(null);
  // Where a reload goes when the preview has not loaded anything yet.
  const fallback = useRef(path);
  fallback.current = path;
  // With preview origins: the port the frame shows, the one it was sent to
  // and has not said it is at yet, and where it is.
  const shown = useRef<number | null>(null);
  const pending = useRef<number | null>(null);
  // The port last asked for.
  const asked = useRef<number | null>(null);
  const where = useRef(path);
  where.current = at;
  const wanted = useRef(port);
  wanted.current = port;

  // Go to `rest` on `to`'s origin, once its relay is ready; `switched`: the
  // path bar or a link asked for that port (else the IDE's port, unless it
  // changed meanwhile).
  const go = (to: number, rest: string, origin: string, switched: boolean) => {
    let cancelled = false;
    asked.current = to;
    void (prepare?.(to) ?? Promise.resolve()).then(() => {
      if (cancelled || !frame.current) return;
      if (!switched && to !== wanted.current) return;
      shown.current = to;
      pending.current = to;
      frame.current.src = origin + rest;
      setAt(rest);
      if (switched && to !== wanted.current) onPort?.(to);
    });
    return () => {
      cancelled = true;
    };
  };

  useEffect(() => {
    if (!frame.current || !running) return;
    const switched = path.match(SWITCH);
    const to = switched ? Number(switched[1]) : port;
    const origin = to === null ? null : (originOf?.(to) ?? null);
    if (origin === null || to === null) {
      frame.current.src = path;
      if (!path.startsWith('/__playground/')) setAt(path);
      return;
    }
    return go(to, switched ? (switched[2] ?? '/') : path, origin, !!switched);
    // oxlint-disable-next-line react/exhaustive-deps -- `navigation` is the signal.
  }, [navigation, path, running]);

  // The app's port changed (another server, the lowest port): the frame
  // goes there, on its origin.
  useEffect(() => {
    if (!frame.current || !running || port === null || asked.current === null) return;
    const origin = originOf?.(port) ?? null;
    if (origin === null || asked.current === port) return;
    return go(port, '/', origin, false);
    // oxlint-disable-next-line react/exhaustive-deps -- the port is the signal.
  }, [port, running]);

  // Where the preview's first frame is, as it says (on another origin, its
  // location cannot be read here).
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.kind !== 'playground-location') return;
      const on = Number(event.data.port);
      if (!originOf?.(on)) {
        setAt(String(event.data.path));
        return;
      }
      // What the page it left still said, before the one it was sent to.
      if (pending.current !== null && on !== pending.current) return;
      pending.current = null;
      setAt(String(event.data.path));
      // It went to another port by itself (a link, a redirect).
      if (on !== shown.current) {
        shown.current = on;
        asked.current = on;
        if (on !== wanted.current) onPort?.(on);
      }
    };
    addEventListener('message', listen);
    return () => removeEventListener('message', listen);
  }, [originOf, onPort]);

  // oxlint-disable-next-line react/exhaustive-deps -- `reload` is the signal.
  useEffect(() => {
    const iframe = frame.current;
    if (!iframe || !running || reload === 0) return;
    const origin = shown.current === null ? null : (originOf?.(shown.current) ?? null);
    if (origin !== null) {
      iframe.src = origin + where.current;
      return;
    }
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
  }, [reload, running, originOf]);

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
