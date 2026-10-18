// relay.html, on a project's preview origin (v-ID-PORT, site.ts), as a
// hidden frame of its IDE (preview-origins.ts): the origin's service
// worker answers the preview's requests (sw.ts) by asking its host, which
// this page is; it passes them to the IDE on the port the IDE gave it, and
// the IDE's bridge to the app's PORT. The app's JavaScript keeps its
// cookies on this origin (the preview's document.cookie is this page's
// too), so each request takes them along, and an answer's cookies the
// app's JavaScript may read are set here.
import { Bridge, type PreviewResponse } from '@/runtime/bridge';
import { loadSite, previewSite, projectUrl } from '@/shared/lib/site';

await loadSite();
const preview = previewSite();
const ide = preview && new URL(projectUrl(preview.project)).origin;

async function start(port: MessagePort): Promise<void> {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.kind === 'http') {
      const reply = event.ports[0];
      const channel = new MessageChannel();
      channel.port1.onmessage = ({ data: response }: MessageEvent<PreviewResponse>) => {
        channel.port1.close();
        for (const cookie of response.cookies ?? []) document.cookie = cookie;
        reply.postMessage(response, [response.body.buffer]);
      };
      port.postMessage({ ...data, port: preview!.port, cookie: document.cookie }, [channel.port2]);
    } else if (data?.kind === 'websocket') {
      port.postMessage({ ...data, port: preview!.port, cookie: document.cookie }, [event.ports[0]]);
    }
  });
  // This origin's service worker, controlling this page, with it as host.
  await Bridge.register('/sw.js', '/', 'default');
  port.postMessage({ kind: 'ready' });
}

if (preview && ide) {
  addEventListener('message', (event) => {
    if (event.origin !== ide || event.data?.kind !== 'playground-relay' || !event.ports[0]) return;
    void start(event.ports[0]);
  });
  window.parent.postMessage({ kind: 'playground-relay-loaded' }, ide);
}
