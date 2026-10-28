// relay.html, on a project's preview origin (v-ID-PORT on the usercontent
// domain, site.ts), as a hidden frame of the page that runs the project
// (previewOrigins.ts: the apex's, or an embedder's the site names): the origin's service worker answers the preview's
// requests (sw.ts) by asking its host, which this page is; it passes them
// on the data port the IDE gave it, to the bridge in the worker that runs
// the project (exec/host.ts), to the app's PORT; the control port tells
// that page it is ready. The cookies the app's JavaScript may read are kept on this
// origin (cookies.ts, the preview's document.cookie too), so each request
// takes them along, and an answer's are set here.
import { Bridge, type PreviewResponse } from '../bridge';
import { cookieString, readJar, setCookie, writeJar } from '../cookies';
import { loadSite, parentOrigins, previewSite } from '../lib/site';

await loadSite();
const preview = previewSite();
const parents = new Set(parentOrigins());
const jar = () => cookieString(readJar());

async function start(control: MessagePort, port: MessagePort): Promise<void> {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.kind === 'http') {
      const reply = event.ports[0];
      const channel = new MessageChannel();
      channel.port1.onmessage = ({ data: response }: MessageEvent<PreviewResponse>) => {
        channel.port1.close();
        if (response.cookies?.length) {
          const kept = readJar();
          for (const cookie of response.cookies) setCookie(kept, cookie);
          writeJar(kept);
        }
        reply.postMessage(response, [response.body.buffer]);
      };
      // Its own port, or a sibling preview origin's (sw.ts).
      port.postMessage({ ...data, port: data.port ?? preview!.port, cookie: jar() }, [
        channel.port2,
      ]);
    } else if (data?.kind === 'websocket') {
      port.postMessage({ ...data, port: preview!.port, cookie: jar() }, [event.ports[0]]);
    }
  });
  // This origin's service worker, controlling this page, with it as host.
  await Bridge.register('/sw.js', '/');
  control.postMessage({ kind: 'ready' });
}

if (preview) {
  let started = false;
  addEventListener('message', (event) => {
    if (event.source !== window.parent || started || !parents.has(event.origin)) return;
    if (event.data?.kind !== 'playground-relay' || !event.ports[1]) return;
    started = true;
    void start(event.ports[0], event.ports[1]);
  });
  // Nothing in it but that the frame loaded: any parent may hear it.
  window.parent.postMessage({ kind: 'playground-relay-loaded' }, '*');
}
