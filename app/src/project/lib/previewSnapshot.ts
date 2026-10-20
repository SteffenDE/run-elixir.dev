// What the docked preview's page shows (bridge.ts's linkShim answers):
// for the tests, which reach no frame of another site in Firefox.
export function previewSnapshot(): Promise<{ title: string; text: string } | null> {
  const target = document.querySelector<HTMLIFrameElement>('.preview iframe')?.contentWindow;
  if (!target) return Promise.resolve(null);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const got = (event: MessageEvent) => {
      if (event.source !== target || event.data?.kind !== 'playground-snapshot') return;
      if (event.data.id !== id) return;
      clearTimeout(timer);
      removeEventListener('message', got);
      resolve({ title: String(event.data.title), text: String(event.data.text) });
    };
    const timer = setTimeout(() => {
      removeEventListener('message', got);
      resolve(null);
    }, 2000);
    addEventListener('message', got);
    target.postMessage({ kind: 'playground-snapshot', id }, '*');
  });
}
