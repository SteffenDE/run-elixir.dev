// Bridge mode's bootstrap (public/root/bridge.html, docs/frames.md): it
// runs only framed, takes its start only from its parent, takes nothing
// from its URL or an opener, and loads only a package's page below the
// bridge it made.
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { sha256, stamp } from '../../src/swScript';

const html = readFileSync(new URL('../../public/root/bridge.html', import.meta.url), 'utf8');
const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)![1];
const run = new Function(
  'window',
  'addEventListener',
  'navigator',
  'location',
  'fetch',
  `return (async () => {${source}})();`,
);
const ENTRY = 'npm/@elixir-playground/runtime@1.1.0/exec.html';

// The bootstrap in a frame (or not), its parent, its service worker; the
// handlers it added to its window, and what it said.
// `refusals`: how many announces the active worker refuses (an older
// sw.js) before the updated one takes them.
// `config`: what the origin answers for /bridge.json (null: no file).
// `served`: the code of the /sw.js the origin sends now, stamped
// (src/swScript.ts; null: none); `runs`: the code the active worker runs,
// whose hash it reports.
const CODE = 'self.addEventListener("fetch", () => {});';
function frame({
  top = false,
  opener = null as unknown,
  refusals = 0,
  config = { bridge: 'bridge.test' } as unknown,
  served = CODE as string | null,
  runs = CODE,
} = {}) {
  const parent = { postMessage: vi.fn() };
  const self: Record<string, unknown> = { parent, opener };
  self.top = top ? self : {};
  const handlers: ((event: unknown) => void)[] = [];
  const container = Object.assign(new EventTarget(), {
    startMessages: vi.fn(),
    register: vi.fn(async () => registration),
  });
  // The keys whose port was closed at the bootstrap's end.
  const closed: string[] = [];
  // A worker that answers announces as the bridge does.
  const makeWorker = (state = 'activated') =>
    Object.assign(new EventTarget(), {
      state,
      postMessage: vi.fn((message: { bridge: string }, ports: MessagePort[] = []) => {
        ports[0]?.addEventListener('close', () => closed.push(message.bridge));
        ports[0]?.start();
        const protocol = refusals-- > 0 ? null : 1;
        void sha256(runs).then((script) =>
          container.dispatchEvent(
            Object.assign(new Event('message'), {
              data: { kind: 'bridged', bridge: message.bridge, protocol, protocols: [1], script },
            }),
          ),
        );
      }),
    });
  const worker = makeWorker();
  const registration: {
    update: () => Promise<unknown>;
    active: typeof worker | null;
    installing: typeof worker | null;
  } = { update: vi.fn(async () => {}), active: worker, installing: null };
  const location = {
    href: 'https://e-abcdefghij.bridge.test/bridge.html',
    host: 'e-abcdefghij.bridge.test',
    replace: vi.fn(),
  };
  const fetch = vi.fn(async (url: string) =>
    url === '/bridge.json' && config !== null
      ? Response.json(config)
      : url === '/sw.js' && served !== null
        ? new Response(await stamp(served))
        : new Response('<!doctype html>', { status: url === '/sw.js' ? 404 : 200 }),
  );
  const loading = run(
    self,
    (type: string, handler: (event: unknown) => void) => {
      if (type === 'message') handlers.push(handler);
    },
    { serviceWorker: container },
    location,
    fetch,
  );
  const send = (event: object) => Promise.all(handlers.map((handler) => handler(event)));
  return {
    parent,
    self,
    container,
    worker,
    makeWorker,
    registration,
    location,
    loading,
    send,
    closed,
    fetch,
  };
}

const control = () => new MessageChannel().port1;

it('refuses to run top-level', async () => {
  const { loading, container, parent } = frame({ top: true });
  await expect(loading).rejects.toThrow('only in a frame');
  expect(container.register).not.toHaveBeenCalled();
  expect(parent.postMessage).not.toHaveBeenCalled();
});

it('refuses to run with an opener', async () => {
  const { loading, container } = frame({ opener: {} });
  await expect(loading).rejects.toThrow('opener');
  expect(container.register).not.toHaveBeenCalled();
});

it('runs only on the shared domain /bridge.json names', async () => {
  for (const config of [null, { bridge: 'other.test' }, { bridge: '' }, 'bridge.test']) {
    const { loading, container, parent } = frame({ config });
    await expect(loading).rejects.toThrow('no shared usercontent domain');
    expect(container.register).not.toHaveBeenCalled();
    // Not even that it loaded: its parent sends it nothing.
    expect(parent.postMessage).not.toHaveBeenCalled();
  }
});

it('says it loaded to its parent, with nothing else in it', async () => {
  const { loading, parent } = frame();
  await loading;
  expect(parent.postMessage).toHaveBeenCalledWith(
    { kind: 'playground-bridge-loaded', protocols: [1] },
    '*',
  );
});

it('takes its start from its parent alone', async () => {
  const { loading, send, container, location } = frame();
  await loading;
  await send({
    source: {},
    origin: 'https://evil.test',
    data: { kind: 'playground-bridge', protocol: 1, entry: ENTRY },
    ports: [control()],
  });
  expect(container.register).not.toHaveBeenCalled();
  expect(location.replace).not.toHaveBeenCalled();
});

it('loads only a package’s page, below the bridge it made', async () => {
  const { loading, send, self, container, location } = frame();
  await loading;
  for (const entry of [
    'https://evil.test/x.html',
    '/npm/@elixir-playground/runtime@1.1.0/exec.html',
    'npm/@elixir-playground/runtime@1.1.0/../../../evil.html',
    'npm/@elixir-playground/runtime@1.1.0/exec.js',
    'npm/other/runtime@1.1.0/exec.html',
    'javascript:alert(1)',
  ])
    await send({
      source: self.parent,
      origin: 'https://apex.test',
      data: { kind: 'playground-bridge', protocol: 1, entry },
      ports: [control()],
    });
  // No port, another protocol.
  await send({
    source: self.parent,
    data: { kind: 'playground-bridge', protocol: 1, entry: ENTRY },
    ports: [],
  });
  await send({
    source: self.parent,
    data: { kind: 'playground-bridge', protocol: 2, entry: ENTRY },
    ports: [control()],
  });
  expect(container.register).not.toHaveBeenCalled();
  expect(location.replace).not.toHaveBeenCalled();
});

it('gives the worker a port under a random key, then loads the page below it', async () => {
  const { loading, send, self, container, worker, location } = frame();
  await loading;
  const apex = new MessageChannel();
  const served: unknown[] = [];
  apex.port2.onmessage = ({ data }) => served.push(data);
  await send({
    source: self.parent,
    origin: 'https://apex.test',
    data: { kind: 'playground-bridge', protocol: 1, entry: ENTRY },
    ports: [apex.port1],
  });
  await vi.waitFor(() => expect(location.replace).toHaveBeenCalled());
  expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  const [announce] = worker.postMessage.mock.calls[0] as unknown as [{ bridge: string }];
  expect(announce).toMatchObject({ kind: 'bridge', protocol: 1 });
  expect(announce.bridge).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(location.replace).toHaveBeenCalledWith(`/_bridge/${announce.bridge}/${ENTRY}`);
  await vi.waitFor(() => expect(served).toEqual([{ kind: 'serve' }]));
  apex.port1.close();
  apex.port2.close();
  // A second start is ignored.
  await send({
    source: self.parent,
    origin: 'https://apex.test',
    data: { kind: 'playground-bridge', protocol: 1, entry: ENTRY },
    ports: [control()],
  });
  expect(location.replace).toHaveBeenCalledTimes(1);
});

it.each(['npm/@acme/tool@1.0.0/tool.html', 'npm/tool@1.0.0/pages/tool.html'])(
  'loads a third-party shared frame: %s',
  async (entry) => {
    const { loading, send, self, worker, location } = frame();
    await loading;
    const port = control();
    await send({
      source: self.parent,
      origin: 'https://apex.test',
      data: { kind: 'playground-bridge', protocol: 1, entry },
      ports: [port],
    });
    const [announce] = worker.postMessage.mock.calls[0] as unknown as [{ bridge: string }];
    expect(location.replace).toHaveBeenCalledWith(`/_bridge/${announce.bridge}/${entry}`);
    port.close();
  },
);

const start = (self: Record<string, unknown>) => ({
  source: self.parent,
  origin: 'https://apex.test',
  data: { kind: 'playground-bridge', protocol: 1, entry: ENTRY },
  ports: [control()],
});

it('bridges with the active worker at once when it runs the served sw.js', async () => {
  const { loading, send, self, location, worker, registration, fetch } = frame();
  await loading;
  // An update check that never ends: not waited for.
  registration.update = () => new Promise(() => {});
  await send(start(self));
  await vi.waitFor(() => expect(location.replace).toHaveBeenCalled());
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith('/sw.js', { cache: 'no-cache' });
});

it('waits for the update check when the served sw.js is another', async () => {
  for (const served of [`${CODE} // changed`, CODE.replace('fetch', 'message')]) {
    const { loading, send, self, location, worker, makeWorker, registration, closed } = frame({
      served,
    });
    await loading;
    const updated = makeWorker('activated');
    let checked = () => {};
    registration.update = () =>
      new Promise<void>((resolve) => {
        checked = () => {
          registration.installing = updated;
          resolve();
        };
      });
    void send(start(self));
    // The active worker reported its own script: refused, its port closed.
    await vi.waitFor(() => expect(closed).toHaveLength(1));
    expect(location.replace).not.toHaveBeenCalled();
    checked();
    await vi.waitFor(() => expect(location.replace).toHaveBeenCalled());
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const [[announce]] = updated.postMessage.mock.calls as unknown as [{ bridge: string }][];
    expect(location.replace).toHaveBeenCalledWith(`/_bridge/${announce.bridge}/${ENTRY}`);
  }
});

it('waits for the update check when sw.js has a stamp line appended after it', async () => {
  // A stamp is the hash of what is before it: anything after it is a change.
  const { loading, send, self, location, registration, fetch } = frame();
  fetch.mockImplementation(async (url: string) =>
    url === '/bridge.json'
      ? Response.json({ bridge: 'bridge.test' })
      : new Response(`${await stamp(CODE)}// revision 1\n`),
  );
  await loading;
  const update = vi.fn(async () => {});
  registration.update = update;
  await send(start(self));
  await vi.waitFor(() => expect(location.replace).toHaveBeenCalled());
  expect(update).toHaveBeenCalled();
});

it('bridges only once the update check is done', async () => {
  const { loading, send, self, location, worker, registration } = frame({ served: null });
  await loading;
  let checked = () => {};
  registration.update = () => new Promise<void>((resolve) => (checked = resolve));
  void send(start(self));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(worker.postMessage).not.toHaveBeenCalled();
  checked();
  await vi.waitFor(() => expect(location.replace).toHaveBeenCalled());
  const [[announce]] = worker.postMessage.mock.calls as unknown as [{ bridge: string }][];
  expect(location.replace).toHaveBeenCalledWith(`/_bridge/${announce.bridge}/${ENTRY}`);
});

it('bridges with the worker an update installs, once it is active', async () => {
  const { loading, send, self, location, worker, makeWorker, registration } = frame({
    served: null,
  });
  await loading;
  const updated = makeWorker('installing');
  registration.update = async () => {
    registration.installing = updated;
  };
  void send(start(self));
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Installed, not yet active: no announce to either worker.
  expect(updated.postMessage).not.toHaveBeenCalled();
  updated.state = 'activated';
  updated.dispatchEvent(new Event('statechange'));
  await vi.waitFor(() => expect(location.replace).toHaveBeenCalled());
  expect(worker.postMessage).not.toHaveBeenCalled();
  const [[announce]] = updated.postMessage.mock.calls as unknown as [{ bridge: string }][];
  expect(location.replace).toHaveBeenCalledWith(`/_bridge/${announce.bridge}/${ENTRY}`);
});

it('bridges with the worker there when the update check fails', async () => {
  const { loading, send, self, location, worker, registration } = frame({ served: null });
  await loading;
  registration.update = async () => {
    throw new TypeError('offline');
  };
  await send(start(self));
  await vi.waitFor(() => expect(location.replace).toHaveBeenCalled());
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
});

it('asks for the newest worker again when the one it waited for became redundant', async () => {
  const { loading, send, self, location, worker, makeWorker, registration } = frame({
    served: null,
  });
  await loading;
  const replaced = makeWorker('installing');
  let updates = 0;
  registration.update = async () => {
    registration.installing = updates++ === 0 ? replaced : null;
  };
  void send(start(self));
  await new Promise((resolve) => setTimeout(resolve, 20));
  replaced.state = 'redundant';
  replaced.dispatchEvent(new Event('statechange'));
  await vi.waitFor(() => expect(location.replace).toHaveBeenCalled());
  expect(replaced.postMessage).not.toHaveBeenCalled();
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
});

it('asks again when the worker does not speak the bridge', async () => {
  const { loading, send, self, location, worker, container } = frame({ refusals: 1 });
  await loading;
  await send({
    source: self.parent,
    origin: 'https://apex.test',
    data: { kind: 'playground-bridge', protocol: 1, entry: ENTRY },
    ports: [control()],
  });
  await vi.waitFor(() => expect(location.replace).toHaveBeenCalled());
  // Announced twice, each with a key and a port of its own; registered
  // twice. The page loads below the key the worker took.
  expect(worker.postMessage).toHaveBeenCalledTimes(2);
  expect(container.register).toHaveBeenCalledTimes(2);
  const [[first], [second]] = worker.postMessage.mock.calls as unknown as [{ bridge: string }][];
  expect(first.bridge).not.toBe(second.bridge);
  expect(location.replace).toHaveBeenCalledWith(`/_bridge/${second.bridge}/${ENTRY}`);
});

it('gives the apex one port, for the worker that took it; the refused one is closed', async () => {
  const { loading, send, self, location, worker, closed } = frame({ refusals: 1 });
  await loading;
  const apex = new MessageChannel();
  const served: MessagePort[] = [];
  apex.port2.onmessage = ({ data, ports }) => data.kind === 'serve' && served.push(ports[0]);
  await send({
    source: self.parent,
    origin: 'https://apex.test',
    data: { kind: 'playground-bridge', protocol: 1, entry: ENTRY },
    ports: [apex.port1],
  });
  await vi.waitFor(() => expect(location.replace).toHaveBeenCalled());
  await vi.waitFor(() => expect(served).toHaveLength(1));
  // The refused worker's port: closed with its other end, which the apex
  // never got.
  const [[first], [second]] = worker.postMessage.mock.calls as unknown as [{ bridge: string }][];
  await vi.waitFor(() => expect(closed).toEqual([first.bridge]));
  expect(closed).not.toContain(second.bridge);
  apex.port1.close();
  apex.port2.close();
});
