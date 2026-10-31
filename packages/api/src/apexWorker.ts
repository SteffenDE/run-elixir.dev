// The apex's worker (docs/frames.md, "Bridge mode"): a dedicated worker
// on the calling page's origin that answers the usercontent domain's
// frames, so the page's main thread only wires up ports.
//
// - **Files** (bridge mode): a frame's service worker asks for a path
//   below its bridge (npm/@elixir-playground/NAME@VERSION/FILE: the
//   frames' pages, worker scripts and imports); the worker fetches it from
//   where the page's packages are (their descriptors' bases, resolved
//   against the page or its CDN), through the page's HTTP cache, and hands
//   the bytes over (transferred). `playground.json` is the frame's site
//   configuration: this page is its apex.
// - **Services** (every mode, the exec frame only): NIF builds, git's
//   smart HTTP and the TCP relay's WebSocket, from the backend the page
//   names (create()'s `services`). The worker makes the requests, so the
//   backend sees this page's Origin and decides by it.
import type {
  LinkRequest,
  LinkResponse,
  LinkSocket,
} from '@elixir-playground/runtime/lib/apexLink';

// What a frame may ask for: create() hands it with the frame's ports.
export interface BridgeTable {
  // [path prefix below the bridge, the URL it comes from], longest first.
  sources: [string, string][];
  // The frame's playground.json, or null outside bridge mode.
  config: Record<string, unknown> | null;
  // The services' URLs (the exec frame's alone), each null if the page
  // has none.
  services: { relay: string | null; nif: string | null; git: string | null } | null;
  // Where the exec frame's workers read the packages' data themselves:
  // the service worker adds them to a worker program's connect-src
  // (swBridge.ts workerPolicy).
  connect?: string[];
}

export type ApexWorkerMessage =
  // A frame's port (control: it sends `serve` with more), or the exec
  // frame's link (link: it sends requests itself).
  { kind: 'frame' | 'link'; table: BridgeTable };

declare const self: {
  onmessage: ((event: MessageEvent<ApexWorkerMessage>) => void) | null;
};

const json = (status: number, body: unknown): LinkResponse => {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    status,
    headers: [['content-type', 'application/json']],
    body: bytes.buffer as ArrayBuffer,
  };
};
const text = (status: number, body: string): LinkResponse => {
  const bytes = new TextEncoder().encode(body);
  return { status, headers: [['content-type', 'text/plain']], body: bytes.buffer as ArrayBuffer };
};

// What the frame's server would say about a file, of what its answer has.
const KEPT = ['content-type', 'content-disposition', 'location'];

// `rest` (a relative path, with its query) below `base`'s directory, or
// null: a frame names the path, and nothing it names may reach another
// path of the page's origin, or another origin. No leading or doubled
// slash (`//host` is another origin), no `.` or `..` segment, no
// backslash and no encoded `.`, `/` or `\` (which a server may decode).
export function below(base: string, rest: string): URL | null {
  const at = rest.indexOf('?');
  const path = at < 0 ? rest : rest.slice(0, at);
  const segments = path.split('/');
  if (/\\|%2e|%2f|%5c/i.test(path)) return null;
  if (segments.some((part) => part === '' || part === '.' || part === '..')) return null;
  const root = new URL(base.endsWith('/') ? base : `${base}/`);
  const url = new URL(path, root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) return null;
  url.search = at < 0 ? '' : rest.slice(at);
  return url;
}

// A service's URL for `path` below _services/, or null.
function serviceTarget(table: BridgeTable, path: string): URL | null {
  const services = table.services;
  if (!services) return null;
  const slash = path.indexOf('/');
  const name = slash < 0 ? path : path.slice(0, slash);
  const base = name === 'nif' ? services.nif : name === 'git' ? services.git : null;
  return base && slash >= 0 ? below(base, path.slice(slash + 1)) : null;
}

// Answer a request for `path`.
export async function answer(table: BridgeTable, request: LinkRequest): Promise<LinkResponse> {
  const path = request.path.replace(/^\/+/, '');
  const method = (request.method ?? 'GET').toUpperCase();
  if (path.startsWith('_services/')) {
    const target = serviceTarget(table, path.slice('_services/'.length));
    if (!target) return text(404, 'This page names no such service.');
    const response = await fetch(target, {
      method,
      headers: (request.headers ?? []).filter(([name]) =>
        ['content-type', 'accept', 'git-protocol'].includes(name.toLowerCase()),
      ),
      body: method === 'GET' || method === 'HEAD' ? null : request.body,
      credentials: 'omit',
    }).catch(() => null);
    if (!response) return text(502, 'The service could not be reached.');
    return {
      status: response.status,
      headers: [...response.headers].filter(([name]) => KEPT.includes(name)),
      body: await response.arrayBuffer(),
    };
  }
  if (method !== 'GET' && method !== 'HEAD') return text(405, 'Only GET.');
  const [pathname] = path.split('?');
  if (pathname === 'playground.json' && table.config) return json(200, table.config);
  const source = table.sources.find(([prefix]) => pathname.startsWith(prefix));
  if (!source) return text(404, 'Not one of this page’s packages.');
  const [prefix, base] = source;
  const target = below(base, pathname.slice(prefix.length));
  if (!target) return text(404, 'Not one of this page’s packages.');
  // Public files: no credentials (the page's cookies reach nothing here).
  const response = await fetch(target, { credentials: 'omit' }).catch(() => null);
  if (!response) return text(502, `${target.href} could not be fetched.`);
  const headers = [...response.headers].filter(([name]) => KEPT.includes(name));
  if (table.connect?.length) headers.push(['x-playground-connect', table.connect.join(' ')]);
  return {
    status: response.status,
    headers,
    body: method === 'HEAD' ? null : await response.arrayBuffer(),
  };
}

// A WebSocket for the frame (the relay's), carried on `port`.
function socket(table: BridgeTable, request: LinkSocket, port: MessagePort): void {
  const url = request.path === '_services/relay' ? table.services?.relay : null;
  if (!url) {
    port.postMessage({ close: { error: true } });
    port.close();
    return;
  }
  let open: WebSocket;
  try {
    open = new WebSocket(url);
  } catch {
    port.postMessage({ close: { error: true } });
    port.close();
    return;
  }
  open.binaryType = 'arraybuffer';
  open.onopen = () => port.postMessage({ open: true });
  open.onmessage = ({ data }) =>
    port.postMessage({ message: data }, data instanceof ArrayBuffer ? [data] : []);
  let errored = false;
  open.onerror = () => {
    errored = true;
  };
  open.onclose = () => {
    port.postMessage({ close: { error: errored } });
    port.close();
  };
  port.onmessage = ({ data }) => {
    if (data?.send && open.readyState === WebSocket.OPEN) open.send(data.send);
    else if (data?.close) open.close();
  };
}

// Requests on `port`, for a frame of this table: the services only for
// the exec frame's (`services`).
function serve(port: MessagePort, table: BridgeTable): void {
  port.onmessage = ({ data, ports }) => {
    if (data?.kind === 'get' && ports[0]) {
      const reply = ports[0];
      void answer(table, data as LinkRequest).then(
        (response) => reply.postMessage(response, response.body ? [response.body] : []),
        () => reply.postMessage(text(500, 'The apex failed to answer.')),
      );
    } else if (data?.kind === 'socket' && ports[0]) {
      socket(table, data as LinkSocket, ports[0]);
    } else if (data?.kind === 'serve' && ports[0]) {
      serve(ports[0], table);
    }
  };
}

self.onmessage = ({ data, ports }) => {
  if ((data?.kind === 'frame' || data?.kind === 'link') && ports[0]) serve(ports[0], data.table);
};
