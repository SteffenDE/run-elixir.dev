import { useEffect, useState } from 'react';
import { built } from '@/project/lib/programs/tailwind';
import { openPopup, previewKey, send } from '@/project/lib/previewChannel';
import { useStore } from '@/project/lib/store';
import { PreviewFrame } from './PreviewFrame';

// The preview docked in the IDE.
export function Preview() {
  const path = useStore((state) => state.previewPath);
  const navigation = useStore((state) => state.previewNavigation);
  const reload = useStore((state) => state.previewKey);
  const running = useStore((state) => state.previewPort !== null);
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
      path={path}
      navigation={navigation}
      reload={reload}
      css={css}
      onNavigate={navigate}
      onReload={reloadPreview}
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
