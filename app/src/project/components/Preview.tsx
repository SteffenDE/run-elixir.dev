import { useEffect, useState } from 'react';
import { built } from '@/project/lib/programs/tailwind';
import { openPopup, previewKey, previewOriginOf, send } from '@/project/lib/previewChannel';
import { useStore } from '@/project/lib/store';
import { previewReady, previewShows } from '@/project/lib/previewHost';
import { PreviewFrame } from './PreviewFrame';

// The preview docked in the IDE.
export function Preview() {
  const path = useStore((state) => state.previewPath);
  const navigation = useStore((state) => state.previewNavigation);
  const reload = useStore((state) => state.previewKey);
  const port = useStore((state) => state.previewPort);
  const running = port !== null;
  const navigate = useStore((state) => state.navigate);
  const reloadPreview = useStore((state) => state.reloadPreview);
  const popOut = useStore((state) => state.popOut);
  const [css, setCss] = useState(0);

  useEffect(() => {
    const refresh = () => setCss((n) => n + 1);
    built.add(refresh);
    return () => {
      built.delete(refresh);
    };
  }, []);

  return (
    <PreviewFrame
      running={running}
      port={port}
      path={path}
      navigation={navigation}
      reload={reload}
      css={css}
      onNavigate={navigate}
      onReload={reloadPreview}
      originOf={previewOriginOf}
      prepare={previewReady}
      onPort={previewShows}
      onPopOut={() => {
        const at = document.querySelector<HTMLIFrameElement>('.preview iframe');
        let current = path;
        try {
          current = at?.contentWindow?.location.pathname ?? path;
        } catch {
          // Keep the path asked for.
        }
        const url = new URL('/preview.html', location.href);
        url.searchParams.set('path', current);
        url.searchParams.set('key', previewKey);
        if (openPopup(url.href)) popOut(true);
        send({ type: 'navigate', path: current });
      }}
    />
  );
}
