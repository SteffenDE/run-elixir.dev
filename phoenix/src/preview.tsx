// The preview in its own window (preview.html): what the IDE's preview
// panel shows, while the IDE gives the editor its space. The IDE tells it
// when to reload; closing it brings the panel back.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PreviewFrame } from './components/PreviewFrame';
import { previewChannel, send, type PreviewMessage } from './previewChannel';
import './styles.css';

function PreviewWindow() {
  const [path, setPath] = useState(() => new URLSearchParams(location.search).get('path') ?? '/');
  const [navigation, setNavigation] = useState(0);
  const [reload, setReload] = useState(0);
  const [css, setCss] = useState(0);

  useEffect(() => {
    send({ type: 'opened' });
    const listen = ({ data }: MessageEvent<PreviewMessage>) => {
      if (data.type === 'reload') setReload((n) => n + 1);
      else if (data.type === 'css') setCss((n) => n + 1);
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
        running
        path={path}
        navigation={navigation}
        reload={reload}
        css={css}
        onNavigate={(next) => {
          setPath(next);
          setNavigation((n) => n + 1);
        }}
        onReload={() => setReload((n) => n + 1)}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreviewWindow />
  </StrictMode>,
);
