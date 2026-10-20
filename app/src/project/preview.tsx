// The preview in its own window (preview.html): what the IDE's preview
// panel shows, while the IDE gives the editor its space. The IDE tells it
// when to reload; closing it brings the panel back.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewFrame } from '@/project/components/PreviewFrame';
import { dropFramesOnLeave } from '@/shared/lib/leave';
import { loadSite } from '@/shared/lib/site';
import {
  previewChannel,
  previewOriginOf,
  send,
  type PreviewMessage,
} from '@/project/lib/previewChannel';
import '@/styles.css';

function PreviewWindow() {
  const [path, setPath] = useState(() => new URLSearchParams(location.search).get('path') ?? '/');
  const [navigation, setNavigation] = useState(0);
  const [reload, setReload] = useState(0);
  const [css, setCss] = useState(0);
  const [port, setPort] = useState<number | null>(null);

  useEffect(() => {
    send({ type: 'opened' });
    const listen = ({ data }: MessageEvent<PreviewMessage>) => {
      if (data.type === 'reload') setReload((n) => n + 1);
      else if (data.type === 'css') setCss((n) => n + 1);
      else if (data.type === 'port') setPort(data.port);
    };
    previewChannel.addEventListener('message', listen);
    const closed = () => send({ type: 'closed' });
    addEventListener('pagehide', closed);
    return () => {
      previewChannel.removeEventListener('message', listen);
      removeEventListener('pagehide', closed);
    };
  }, []);

  return (
    <div className="app preview-window">
      <PreviewFrame
        // The preview is a port's origin: none until the IDE says which.
        running={port !== null}
        port={port}
        path={path}
        navigation={navigation}
        reload={reload}
        css={css}
        onNavigate={(next) => {
          setPath(next);
          setNavigation((n) => n + 1);
        }}
        onReload={() => setReload((n) => n + 1)}
        originOf={previewOriginOf}
      />
    </div>
  );
}

// The window's preview is a port's origin on the usercontent domain, in
// this page as in the IDE's: the same site's frames, so that origin's
// service worker passes its requests to the relay in the IDE's page
// (previewOrigins.ts).
dropFramesOnLeave();
void loadSite().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PreviewWindow />
    </StrictMode>,
  ),
);
