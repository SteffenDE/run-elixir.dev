// The apex's shared worker (docs/tailscale.md): this browser's one
// Tailscale node, main.go built to WebAssembly (tailscale/build.py), for
// every page of the apex that connects (the Tailscale page, the projects'
// list, a project's page, which hands on what its exec frame may open:
// client.ts). Its state (the node's keys, the profile) is kept in the
// apex's IndexedDB, which no project's code reaches (that runs on the
// usercontent domain, docs/frames.md).
//
// The node starts once Tailscale is set up (it reached Running and was not
// signed out since), or when the Tailscale page asks; before that its
// WebAssembly (about 30 MB) is not loaded. Two builds' pages make two
// workers (a worker is its script's URL); a lock lets one run the node.
import '../../../tailscale/wasm_exec.js';
import { CONTROL_URL, HOSTNAME, TAG } from './protocol';
import type { Action, Exposure, Piece, Proto, Reply, Request, Status } from './protocol';

interface Go {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}
interface Conn {
  write(bytes: Uint8Array): void;
  end(): void;
  close(): void;
  local: string;
}
// What the page's listener gives the node for an inbound connection.
interface Sink {
  ondata(bytes: Uint8Array<ArrayBuffer>): void;
  onend(error: string | null): void;
  ready(conn: Conn): void;
}
// globalThis.playgroundTailscale, as main.go sets it.
interface Node {
  start(config: {
    controlURL: string;
    hostname: string;
    tags: string[];
    state: Record<string, Uint8Array>;
    save(key: string, bytes: Uint8Array | null): void;
    notify(json: string): void;
  }): void;
  login(): Promise<void>;
  logout(): Promise<void>;
  setExitNode(id: string): Promise<void>;
  setControlURL(url: string): Promise<void>;
  dial(
    host: string,
    port: number,
    proto: Proto,
    ondata: (bytes: Uint8Array<ArrayBuffer>) => void,
    onend: (error: string | null) => void,
  ): Promise<Conn>;
  dnsQuery(query: Uint8Array): Promise<Uint8Array>;
  listen(port: number, onconnection: (remote: string) => Sink): void;
  unlisten(port: number): void;
}
const global = globalThis as unknown as { Go: new () => Go; playgroundTailscale?: Node };
declare const self: {
  addEventListener(type: 'connect', listener: (event: MessageEvent) => void): void;
};

const LOCK = 'playground-tailscale';

// The node's log (Go's log package, which wasm_exec.js writes to the
// console), its last lines kept for the apex's pages to read
// (window.tailscale.logs(), client.ts).
const LOG: string[] = [];
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const write = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    LOG.push(args.map(String).join(' '));
    if (LOG.length > 1000) LOG.shift();
    write(...args);
  };
}

// IndexedDB: `state`, main.go's keys and their bytes; `settings`, the
// control server (controlURL) and whether Tailscale is set up
// (configured).
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const opening = indexedDB.open('playground-tailscale', 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('state');
    opening.result.createObjectStore('settings');
  };
  opening.onsuccess = () => resolve(opening.result);
  opening.onerror = () => reject(opening.error);
});

async function store<T>(
  name: string,
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database;
  return new Promise((resolve, reject) => {
    const request = use(db.transaction(name, mode).objectStore(name));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const setting = <T>(key: string) =>
  store<T | undefined>('settings', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
const setSetting = (key: string, value: unknown) =>
  store('settings', 'readwrite', (s) => s.put(value, key));

async function savedState(): Promise<Record<string, Uint8Array>> {
  const keys = await store('state', 'readonly', (s) => s.getAllKeys());
  const values = await store('state', 'readonly', (s) => s.getAll());
  return Object.fromEntries(keys.map((key, i) => [String(key), values[i] as Uint8Array]));
}

const pages = new Set<MessagePort>();
let status: Status = { state: 'off', controlURL: CONTROL_URL, exitNodes: [] };
let configured = false;
const settled = Promise.all([setting<string>('controlURL'), setting<boolean>('configured')]).then(
  ([url, was]) => {
    configured = was === true;
    publish({ ...status, controlURL: url ?? CONTROL_URL });
  },
);

function publish(next: Status): void {
  status = next;
  const reply: Reply = { kind: 'status', status };
  for (const page of pages) page.postMessage(reply);
}

// The node's WebAssembly, as the first page names it (its build's).
let wasm: (url: string) => void;
const wasmUrl = new Promise<string>((resolve) => (wasm = resolve));

let starting: Promise<Node> | null = null;
function node(): Promise<Node> {
  starting ??= (async () => {
    await settled;
    const url = await wasmUrl;
    // One node per browser: another build's worker may hold it.
    const waiting = setTimeout(() => publish({ ...status, state: 'waiting' }), 500);
    await new Promise<void>((held) => {
      void navigator.locks.request(LOCK, () => {
        held();
        return new Promise<void>(() => {});
      });
    });
    clearTimeout(waiting);
    publish({ ...status, state: 'loading' });
    const go = new global.Go();
    const { instance } = await WebAssembly.instantiateStreaming(fetch(url), go.importObject);
    void go.run(instance);
    const api = global.playgroundTailscale!;
    api.start({
      controlURL: status.controlURL,
      hostname: HOSTNAME,
      tags: [TAG],
      state: await savedState(),
      save: (key, bytes) =>
        void (bytes
          ? store('state', 'readwrite', (s) => s.put(bytes, key))
          : store('state', 'readwrite', (s) => s.delete(key))),
      notify: (json) => {
        const next = JSON.parse(json) as Status;
        if (next.state === 'Running' && !configured) {
          configured = true;
          void setSetting('configured', true);
        }
        publish(next);
      },
    });
    return api;
  })();
  starting.catch((error: Error) => {
    starting = null;
    publish({ ...status, state: 'off', error: `Tailscale did not start: ${error.message}` });
  });
  return starting;
}

async function act(action: Action): Promise<void> {
  switch (action.kind) {
    case 'start':
      await node();
      return;
    case 'login':
      return (await node()).login();
    case 'logout':
      configured = false;
      await setSetting('configured', false);
      if (starting) await (await node()).logout();
      return;
    case 'exit-node':
      return (await node()).setExitNode(String(action.id));
    case 'control-url': {
      const url = String(action.url);
      if (!/^https?:\/\/[^/]+/.test(url)) throw new Error(`${url}: not a URL`);
      await setSetting('controlURL', url);
      if (starting) await (await node()).setControlURL(url);
      else publish({ ...status, controlURL: url });
      return;
    }
  }
}

// A connection through the node to `host`:`port`, on `port` (Piece).
async function dial(conn: MessagePort, host: string, port: number, proto: Proto) {
  const say = (piece: Piece, transfer: Transferable[] = []) => conn.postMessage(piece, transfer);
  if (!starting || status.state !== 'Running') {
    say({ kind: 'error', message: 'Tailscale is not connected' });
    conn.close();
    return;
  }
  let through: Conn;
  try {
    through = await (
      await node()
    ).dial(
      host,
      port,
      proto,
      (bytes) => say({ kind: 'data', bytes }, [bytes.buffer]),
      (error) => say({ kind: 'end', error }),
    );
  } catch (error) {
    say({ kind: 'error', message: (error as Error).message });
    conn.close();
    return;
  }
  say({ kind: 'open', local: through.local });
  // What the page sent meanwhile waited in the port until now.
  conn.onmessage = ({ data }: MessageEvent<Piece>) => {
    if (data.kind === 'data') through.write(data.bytes);
    else if (data.kind === 'end') through.end();
    else if (data.kind === 'close') {
      through.close();
      conn.close();
    }
  };
}

// The device's ports shared in the tailnet, each by one page (its
// exposure's port): inbound connections there go to that page, which
// takes them to the node listening on the port.
const exposed = new Map<number, MessagePort>();
// How long a page has to take an inbound connection; one that does not
// has gone, and its port is no longer shared.
const TAKE = 5000;

async function expose(owner: MessagePort, port: number) {
  const say = (message: Exposure) => owner.postMessage(message);
  if (!starting || status.state !== 'Running') {
    say({ kind: 'error', message: 'Tailscale is not connected' });
    return owner.close();
  }
  if (exposed.has(port)) {
    say({ kind: 'error', message: `port ${port} is shared already, by another project` });
    return owner.close();
  }
  const api = await node();
  exposed.set(port, owner);
  const stop = () => {
    if (exposed.get(port) !== owner) return;
    exposed.delete(port);
    api.unlisten(port);
    owner.close();
  };
  owner.onmessage = ({ data }: MessageEvent<Exposure>) => {
    if (data.kind === 'unexpose') stop();
  };
  api.listen(port, (remote) => {
    console.log(`tailscale: ${remote} → port ${port}, to its page`);
    const channel = new MessageChannel();
    const conn = channel.port1;
    owner.postMessage({ kind: 'inbound', remote } satisfies Exposure, [channel.port2]);
    let through: Conn | null = null;
    const timer = setTimeout(() => {
      through?.close();
      conn.close();
      stop();
    }, TAKE);
    return {
      ondata: (bytes) => conn.postMessage({ kind: 'data', bytes } satisfies Piece, [bytes.buffer]),
      onend: (error) => conn.postMessage({ kind: 'end', error } satisfies Piece),
      ready: (handle) => {
        through = handle;
        conn.onmessage = ({ data }: MessageEvent<Piece>) => {
          if (data.kind === 'open') clearTimeout(timer);
          else if (data.kind === 'data') handle.write(data.bytes);
          else if (data.kind === 'end') handle.end();
          else if (data.kind === 'close') {
            clearTimeout(timer);
            handle.close();
            conn.close();
          }
        };
      },
    };
  });
  say({ kind: 'exposed' });
}

self.addEventListener('connect', (event) => {
  const page = event.ports[0];
  pages.add(page);
  page.onmessage = ({ data, ports }: MessageEvent<Request>) => {
    if (data.kind === 'hello') {
      wasm(data.wasm);
      page.postMessage({ kind: 'status', status } satisfies Reply);
      void settled.then(() => {
        if (configured) void node();
      });
    } else if (data.kind === 'act') {
      act(data.action).then(
        () => page.postMessage({ kind: 'done', id: data.id } satisfies Reply),
        (error: Error) =>
          page.postMessage({ kind: 'done', id: data.id, error: error.message } satisfies Reply),
      );
    } else if (data.kind === 'logs') {
      page.postMessage({ kind: 'logs', id: data.id, lines: [...LOG] } satisfies Reply);
    } else if (data.kind === 'dial' && ports[0]) {
      const proto = (['tcp', 'udp'] as const).find((name) => name === data.proto);
      if (proto) void dial(ports[0], String(data.host), Number(data.port), proto);
    } else if (data.kind === 'expose' && ports[0]) {
      void expose(ports[0], Number(data.port));
    } else if (data.kind === 'dns') {
      const answer = (reply: Reply) => page.postMessage(reply);
      if (!starting || status.state !== 'Running')
        answer({ kind: 'dns', id: data.id, error: 'Tailscale is not connected' });
      else
        void node()
          .then((api) => api.dnsQuery(data.query))
          .then(
            (bytes) => answer({ kind: 'dns', id: data.id, answer: bytes }),
            (error: Error) => answer({ kind: 'dns', id: data.id, error: error.message }),
          );
    }
  };
});
