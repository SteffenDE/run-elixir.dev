// Calls from a page to a hidden frame of another origin (`call`), and a
// frame's answers (`serve`). A frame answers only the origins it lets in,
// each call on a port of its own.
type Handler = (caller: string, ...args: never[]) => unknown;

const READY = 'playground-frame-ready';
const CALL = 'playground-frame-call';

// The page's frames, by URL: loaded once, and kept.
const frames = new Map<string, Promise<Window>>();

function frame(url: string): Promise<Window> {
  let loading = frames.get(url);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const element = document.createElement('iframe');
      element.src = url;
      element.hidden = true;
      element.setAttribute('aria-hidden', 'true');
      const origin = new URL(url).origin;
      const timer = setTimeout(() => reject(new Error(`${url}: no answer`)), 20000);
      const ready = (event: MessageEvent) => {
        if (event.origin !== origin || event.source !== element.contentWindow) return;
        if (event.data?.kind !== READY) return;
        window.removeEventListener('message', ready);
        clearTimeout(timer);
        resolve(element.contentWindow!);
      };
      window.addEventListener('message', ready);
      document.body.append(element);
    });
    frames.set(url, loading);
    loading.catch(() => frames.delete(url));
  }
  return loading;
}

// Call `method` in the frame at `url`; its answer, or its error thrown.
export async function call<T>(url: string, method: string, ...args: unknown[]): Promise<T> {
  const target = await frame(url);
  const channel = new MessageChannel();
  const answer = new Promise<T>((resolve, reject) => {
    channel.port1.onmessage = ({ data }) => {
      channel.port1.close();
      if (data.ok) resolve(data.value as T);
      else reject(new Error(data.error));
    };
  });
  target.postMessage({ kind: CALL, method, args }, new URL(url).origin, [channel.port2]);
  return answer;
}

// In a frame page: answer calls from the origins `allowed` names (each
// handler is given the caller's origin first), and tell the parent it may
// call.
export function serve(allowed: (origin: string) => boolean, handlers: Record<string, Handler>) {
  window.addEventListener('message', (event) => {
    const port = event.ports[0];
    if (event.data?.kind !== CALL || !port) return;
    const handler = handlers[event.data.method];
    if (!allowed(event.origin) || !handler) {
      port.postMessage({ ok: false, error: 'not allowed' });
      return;
    }
    Promise.resolve()
      .then(() => handler(event.origin, ...(event.data.args as never[])))
      .then(
        (value) => port.postMessage({ ok: true, value }),
        (error: Error) => port.postMessage({ ok: false, error: error.message }),
      );
  });
  // The message says nothing but that this page loaded.
  window.parent.postMessage({ kind: READY }, '*');
}
