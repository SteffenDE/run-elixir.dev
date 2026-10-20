// A project's page: what the IDE shows of the project, and the frame that
// runs it (docs/frames.md). The nodes, the shared files and the page
// programs run in a worker of a frame on the usercontent domain
// (exec/host.ts), which this page drives over a port; this page keeps what
// is the apex's: the project's stores (its files' changes, PGlite), Hex's
// cache, the terminals' screens and line disciplines, the tree and the
// tabs. Everything the UI does to the project goes through here.
import { Terminal } from '@xterm/xterm';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { hstore } from '@electric-sql/pglite/contrib/hstore';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import type { ExecEvents, ExecStart } from '@/exec/host';
import type { Entry, SearchQuery, SearchResult } from '@/runtime/host/files';
import type { Connection, NifBuild } from '@/runtime/host/node';
import { serveStore } from '@/runtime/overlay';
import { PortConnection } from '@/runtime/portConnection';
import { postgres } from '@/runtime/postgres';
import { REPORT, lineDiscipline } from '@/runtime/terminal';
import { BUILD, RUNTIME } from '@/shared/lib/build';
import { Rpc } from '@/shared/lib/rpc';
import {
  connectTailscale,
  IEX,
  setTailnetProject,
  tailnetDial,
  tailnetResolve,
  tailscaleBlocked,
} from '@/tailscale/client';
import { apexOrigin, execOrigin, previewOrigins } from '@/shared/lib/site';
import { built } from '@/project/lib/programs/tailwind';
import { bundled } from '@/project/lib/programs/esbuild';
import {
  closePopup,
  onPreviewMessage,
  previewKey,
  send,
  setPreviewKey,
  type PreviewMessage,
} from '@/project/lib/previewChannel';
import { disposeTerminals } from '@/project/lib/terminal-handle';
import { HIDDEN, WORK, useStore } from '@/project/lib/store';
import { filesStore, pgliteDataDir } from '@/shared/lib/storage';
import { seedTaken, takeSeed } from '@/shared/lib/projects';
import type { Shared } from '@/shared/lib/share';
import type { Template } from '@/shared/lib/templates';
import { setWorkspace, type Workspace } from './workspace';
import { forgetRelays, previewRelay } from './previewOrigins';
import { previewSnapshot } from './previewSnapshot';
import { setPreviewHost, type PreviewHost } from './previewHost';
import { hex } from './hex';
import { serverCommand, setup as setupOf, type Setup, type WorkspaceKind } from './kinds';

type Output = (text: string) => void;

// A shell's node, as this page knows it: what it runs is the frame's.
interface ShellNode {
  input(text: string): void;
  interrupt(): void;
  // Stops what runs now at once, the shell staying.
  terminate(): void;
  // The ports it serves on (a server's: not Mix's locks).
  serving: Set<number>;
}

interface Session {
  id: number;
  node: ShellNode;
  backlog: string;
  listeners: Set<Output>;
  // Its tty's line discipline: everyone's keys, one line being typed, and
  // the command lines it ran first as if typed (the history).
  discipline: ReturnType<typeof lineDiscipline>;
  // Its screen, whether a terminal shows it or not: it answers the cursor
  // position the shell's line editor asks for, and is what the shell
  // looks like (the visible terminals only show it; they do not answer).
  screen: Terminal;
  decoder: TextDecoder;
}

const sessions = new Map<number, Session>();
let exec: Rpc | null = null;
let frame: HTMLIFrameElement | null = null;
let setup: Setup = setupOf('empty');
let kind: WorkspaceKind = 'empty';
// The stored project's id (null for a temporary IEx).
let projectId: string | null = null;
// Started on the first connection to 5432; a stored project's is kept in
// IndexedDB.
let db: Promise<PGlite> | null = null;
// Postgres on 5432 for every node: one handler, so that the nodes'
// connections take turns in PGlite's one session.
let serveDatabase = postgres(database);
let nextSession = 1;
export const FIRST_SESSION = 1;
// The ports Node.js processes serve on (exec/host.ts's 'serving').
let scriptPorts = new Set<number>();

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function running(): Rpc {
  if (!exec) throw new Error('the playground is not running');
  return exec;
}

// The shared files, in the frame.
const files = {
  list: (path: string, skip: string[] = []) => running().call<Entry[]>('list', [path, skip]),
  stat: (path: string) =>
    exec ? exec.call<'file' | 'dir' | null>('stat', [path]) : Promise.resolve(null),
  read: (path: string) => running().call<Uint8Array>('read', [path]),
  write: (path: string, data: string | Uint8Array) => running().call<void>('write', [path, data]),
  mkdir: (path: string) => running().call<void>('mkdir', [path]),
  remove: (path: string) => running().call<void>('remove', [path]),
  rename: (from: string, to: string) => running().call<void>('rename', [from, to]),
  flush: () => (exec ? exec.call<void>('flush') : Promise.resolve()),
};

// A terminal's output; what came before it subscribed is replayed.
export function onOutput(id: number, listener: Output): () => void {
  const session = sessions.get(id);
  if (!session) return () => {};
  if (session.backlog) listener(session.backlog);
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

function hidden(path: string): boolean {
  return path.split('/').some((part) => HIDDEN.includes(part));
}

// The tree's paths, from the shared filesystem.
export async function refreshTree(): Promise<void> {
  if (!exec) return;
  const entries = await files.list(WORK, HIDDEN);
  const prefix = WORK.length + 1;
  const dirs = new Set(
    entries.filter((e) => !e.dir).map((e) => e.path.slice(0, e.path.lastIndexOf('/'))),
  );
  const paths = entries
    .filter((e) => !e.dir || !dirs.has(e.path))
    .map((e) => e.path.slice(prefix) + (e.dir ? '/' : ''));
  useStore.getState().setPaths(paths);
}

// A live session's host (src/live/lib/host.ts) hears of saves, moves and
// removals, and of files the nodes changed, which it applies to the files
// open in the session (and the tabs showing those: `changed` returns
// their paths).
export const live: {
  saved?: (path: string, text: string) => void;
  moved?: (from: string, to: string) => void;
  removed?: (path: string) => void;
  changed?: (paths: string[]) => Promise<Set<string>>;
} = {};

let refreshing: ReturnType<typeof setTimeout> | null = null;
let reloading: ReturnType<typeof setTimeout> | null = null;

// What the nodes changed: the tree, and open tabs without edits.
async function changed(paths: string[]): Promise<void> {
  const visible = paths.filter((path) => path.startsWith(WORK) && !hidden(path));
  if (!visible.length) return;
  refreshing ??= setTimeout(() => {
    refreshing = null;
    void refreshTree();
  }, 300);
  const shared = (await live.changed?.(visible)) ?? new Set();
  const { tabs, replace } = useStore.getState();
  for (const tab of tabs) {
    if (!visible.includes(tab.path) || tab.draft !== tab.saved || shared.has(tab.path)) continue;
    try {
      const text = decoder.decode(await read(tab.path));
      if (text !== tab.saved) replace(tab.path, text);
    } catch {
      // Removed: the tab stays with what it had.
    }
  }
}

export function read(path: string): Promise<Uint8Array> {
  if (!exec) return Promise.reject(new Error('the playground is not running'));
  return files.read(path);
}

export function stat(path: string): Promise<'file' | 'dir' | null> {
  return files.stat(path);
}

// What the project's files say: matches of `query` below /work, but in
// the directories the tree leaves out.
export function search(query: SearchQuery): Promise<SearchResult> {
  return running().call<SearchResult>('search', [WORK, query, HIDDEN]);
}

async function vacant(path: string): Promise<void> {
  if ((await stat(path)) !== null) throw new Error(`${path.slice(WORK.length + 1)} exists already`);
}

// The tree's file operations, on absolute paths below /work.
export async function createFile(path: string, open = true): Promise<void> {
  await vacant(path);
  await files.write(path, new Uint8Array(0));
  if (open) await openFile(path);
}

export async function createDirectory(path: string): Promise<void> {
  await vacant(path);
  await files.mkdir(path);
}

export async function movePath(from: string, to: string): Promise<void> {
  await vacant(to);
  await files.rename(from, to);
  useStore.getState().moved(from, to);
  live.moved?.(from, to);
}

export async function removePath(path: string): Promise<void> {
  await files.remove(path);
  useStore.getState().removed(path);
  live.removed?.(path);
}

// Open a file in the editor, with the caret on `line`.
export async function openFile(path: string, line = 1): Promise<void> {
  const text = decoder.decode(await read(path));
  useStore.getState().open(path, text, line);
  useStore.getState().setFilesShown(true);
}

// Where relative paths a shell prints may start: its usual directory,
// then /work.
export function searchPath(): string[] {
  return [...new Set([setup.cwd, WORK])];
}

export async function save(path: string, text: string): Promise<void> {
  if (!exec) return;
  await files.write(path, encoder.encode(text));
  useStore.getState().saved(path, text);
  live.saved?.(path, text);
  void exec.call('saved', [path]);
  // Phoenix's code reloader compiles on the next request. A Node.js
  // process's server (Vite's) watches the files and updates its page
  // itself.
  const shown = useStore.getState().previewPort;
  if (shown !== null && !scriptPorts.has(shown)) {
    if (reloading) clearTimeout(reloading);
    reloading = setTimeout(() => useStore.getState().reloadPreview(), 200);
  }
}

// Keys typed into shell `id`'s terminal, here or by a live session's guest.
export function keys(id: number, data: string): void {
  sessions.get(id)?.discipline.keys(data);
}

// The size of shell `id`'s terminal, for the node's line editing.
export function resize(id: number, columns: number, rows: number): void {
  if (!sessions.has(id)) return;
  void exec?.call('resize', [id, columns, rows]);
  sessions.get(id)!.screen.resize(columns, rows);
}

// Stop whatever runs in the first shell, then start the Phoenix server
// again.
export function restartServer(): void {
  const node = sessions.get(FIRST_SESSION)?.node;
  if (!node || kind !== 'phoenix') return;
  node.terminate();
  setTimeout(() => node.input(serverCommand(setup.cwd)), 300);
}

// A connection to a server a node or a Node.js process runs on `port`
// (not their other listeners: Mix's locks, PGlite), for a live session's
// guest's preview; null when none serves there.
export function connectServer(port: number): Connection | null {
  if (
    !scriptPorts.has(port) &&
    ![...sessions.values()].some((session) => session.node.serving.has(port))
  )
    return null;
  const channel = new MessageChannel();
  void exec?.call('connectServer', [port, channel.port2], [channel.port2]);
  return new PortConnection(channel.port1, {}, 0) as unknown as Connection;
}

// The preview: a port's origin once its relay is ready (PreviewFrame's
// prepare), and the port it went to by itself (onPort).
const serveRelay = (requests: MessagePort) =>
  void exec?.call('relay', [requests], [requests]).catch(() => requests.close());
const preview: PreviewHost = {
  ready: (port) => previewRelay(previewKey, port, serveRelay),
  shows: (port) => void exec?.call('previewShows', [port]),
};

function database(): Promise<PGlite> {
  // The extensions Phoenix apps ask for (phx.gen.auth: citext), a few KB
  // each, for CREATE EXTENSION.
  const extensions = {
    citext,
    fuzzystrmatch,
    hstore,
    ltree,
    pg_trgm,
    pgcrypto,
    unaccent,
    uuid_ossp,
  };
  db ??= PGlite.create(projectId ? pgliteDataDir(projectId) : undefined, {
    extensions,
  });
  return db;
}

// The apex's services for the nodes (exec/host.ts carries their
// connections here): Postgres, and Hex's cache. Each remote node has a
// stand-in, which postgres.ts tells nodes apart by.
const standIns = new Map<number, object>();
function connect(service: 'postgres' | 'hex', node: number, id: number, port: MessagePort): void {
  if (!standIns.has(node)) standIns.set(node, {});
  const connection = new PortConnection(port, standIns.get(node)!, id) as unknown as Connection;
  if (service === 'postgres') serveDatabase(connection);
  else hex(connection);
}

// A shell in a new terminal tab (the first runs `initial`).
export function openTerminal(initial: string[] = []): number {
  if (!exec) return 0;
  const id = nextSession++;
  const rpc = exec;
  const session: Session = {
    id,
    node: {
      input: (text) => void rpc.call('input', [id, text]),
      interrupt: () => void rpc.call('interrupt', [id]),
      terminate: () => void rpc.call('terminate', [id]),
      serving: new Set(),
    },
    backlog: '',
    listeners: new Set(),
    discipline: null as unknown as Session['discipline'],
    screen: new Terminal({ cols: 80, rows: 24, convertEol: true, scrollback: 5000 }),
    decoder: new TextDecoder(),
  };
  session.screen.onData((data) => {
    if (REPORT.test(data)) session.node.input(data);
  });
  session.discipline = lineDiscipline(
    (text) => emit(session, text),
    {
      input: (text) => session.node.input(text),
      interrupt: () => session.node.interrupt(),
    },
    initial,
  );
  sessions.set(id, session);
  void rpc.call('openShell', [id, { initial }]);
  useStore.getState().addTerminal(id);
  return id;
}

function emit(session: Session, text: string): void {
  session.backlog = (session.backlog + text).slice(-200_000);
  session.screen.write(text);
  for (const listener of session.listeners) listener(text);
}

export function closeTerminal(id: number): void {
  if (id === FIRST_SESSION) return;
  sessions.get(id)?.screen.dispose();
  sessions.delete(id);
  void exec?.call('closeShell', [id]);
  useStore.getState().removeTerminal(id);
}

// What the frame tells: output, the first shell's status, raw mode, the
// ports served, the files the nodes changed, NIF builds, new CSS and
// bundles, and what a node could not reach without Tailscale.
function listen(rpc: Rpc): void {
  const on = <K extends keyof ExecEvents>(event: K, listener: (data: ExecEvents[K]) => void) =>
    rpc.on(event, listener);
  on('output', ({ id, bytes }) => {
    const session = sessions.get(id);
    if (session) emit(session, session.decoder.decode(bytes, { stream: true }));
  });
  on('status', ({ id, text }) => {
    if (id !== FIRST_SESSION) return;
    const store = useStore.getState();
    if (text === 'running') {
      store.setStatus(setup.running);
      store.setReady(true);
    } else if (text.startsWith('failed') && !store.ready) {
      store.failedToStart(text.replace(/^failed: /, ''));
    } else store.setStatus(text);
  });
  on('terminal', ({ id, raw, signals }) => sessions.get(id)?.discipline.raw(raw, signals));
  on('serving', ({ ports, port, byShell, scripts }) => {
    scriptPorts = new Set(scripts);
    for (const [id, served] of Object.entries(byShell)) {
      const session = sessions.get(Number(id));
      if (session) session.node.serving = new Set(served);
    }
    for (const each of ports) void previewRelay(previewKey, each, serveRelay).catch(() => {});
    const store = useStore.getState();
    if (ports.join() !== store.serving.join()) store.setServing(ports);
    if (port !== store.previewPort) store.setPreviewPort(port);
  });
  on('changed', (paths) => void changed(paths));
  on('warning', (message) => useStore.getState().setStatus(message));
  on('nif', (build: NifBuild) => useStore.getState().setNifBuild(build));
  on('css', (output) => {
    for (const listener of built) listener(output);
  });
  on('bundled', () => {
    for (const listener of bundled) listener();
  });
  on('blocked', tailscaleBlocked);
  // The apex's services, and the tailnet as this page lets the project
  // use it (docs/tailscale.md).
  rpc.handle({ connect, tailnetDial, tailnetResolve });
}

// A popped-out preview hears what the docked one would: reloads and new
// CSS. Its closing brings the panel back.
useStore.subscribe((state, before) => {
  if (state.previewKey !== before.previewKey) send({ type: 'reload' });
  if (state.previewPort !== before.previewPort) send({ type: 'port', port: state.previewPort });
});
built.add(() => send({ type: 'css' }));
// A rebuilt bundle: the preview loads it (a save's reload may come first).
bundled.add(() => {
  if (useStore.getState().previewPort === null) return;
  if (reloading) clearTimeout(reloading);
  reloading = setTimeout(() => useStore.getState().reloadPreview(), 100);
});
onPreviewMessage(({ data }: MessageEvent<PreviewMessage>) => {
  if (data.type === 'closed') useStore.getState().popOut(false);
  else if (data.type === 'opened') {
    useStore.getState().popOut(true);
    send({ type: 'port', port: useStore.getState().previewPort });
  }
});

// The page starts its project once (React may run its effect twice), and
// again only after shutdown().
let begun = false;
export function beginStart(): boolean {
  if (begun) return false;
  begun = true;
  return true;
}

// Keep what changed and stop every node: the project runs elsewhere now.
export async function shutdown(): Promise<void> {
  await exec?.call('shutdown').catch(() => {});
  exec?.close();
  exec = null;
  setTailnetProject(null);
  frame?.remove();
  frame = null;
  forgetRelays();
  for (const session of sessions.values()) session.screen.dispose();
  sessions.clear();
  nextSession = 1;
  scriptPorts = new Set();
  const pglite = await db?.catch(() => null);
  await pglite?.close().catch(() => {});
  db = null;
  serveDatabase = postgres(database);
}

// The page goes to another of the apex's pages in place (navigate.ts):
// what leaving it by a load would end ends, and the next project starts
// afresh.
export async function leave(): Promise<void> {
  await shutdown();
  closePopup();
  disposeTerminals();
  begun = false;
  useStore.setState(useStore.getInitialState(), true);
}

// What this project changed over its template, to share: its sources, not
// its builds, dependencies or database (exec/host.ts changes).
export async function shareable(name: string, template?: Template): Promise<Shared> {
  const changes = await running().call<Omit<Shared, 'name' | 'template'>>('changes', [HIDDEN]);
  return { ...changes, name, ...(template ? { template } : {}) };
}

// The IDE's workspace (workspace.ts): this project.
export const local: Workspace = {
  read,
  stat,
  search,
  createFile: (path) => createFile(path),
  createDirectory,
  movePath,
  removePath,
  openFile,
  save,
  searchPath,
  onOutput,
  keys,
  resize,
  openTerminal: () => void openTerminal(),
  closeTerminal,
  restartServer,
};

// The frame that runs the project (e-KEY on the usercontent domain), its
// worker's port once it started. After the page's load: a frame of
// another site would hold its load event up (Firefox) until it started.
async function startFrame(origin: string): Promise<Rpc> {
  if (document.readyState !== 'complete')
    await new Promise((loaded) => addEventListener('load', loaded, { once: true }));
  return new Promise((resolve, reject) => {
    const element = document.createElement('iframe');
    element.src = `${origin}/exec.html`;
    element.className = 'exec-frame';
    element.setAttribute('aria-hidden', 'true');
    element.tabIndex = -1;
    // Its own SharedArrayBuffers and threads (Chromium asks for this).
    element.allow = 'cross-origin-isolated';
    const timer = setTimeout(
      () => reject(new Error(`${origin}: the project did not start`)),
      30000,
    );
    const loaded = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== element.contentWindow) return;
      if (event.data?.kind !== 'playground-exec-loaded') return;
      removeEventListener('message', loaded);
      clearTimeout(timer);
      if (!event.data.isolated) {
        reject(new Error(`${origin} is not cross-origin isolated (see docs/frames.md).`));
        return;
      }
      const channel = new MessageChannel();
      element.contentWindow!.postMessage({ kind: 'playground-exec' }, origin, [channel.port2]);
      resolve(new Rpc(channel.port1));
    };
    addEventListener('message', loaded);
    frame = element;
    document.body.append(element);
  });
}

// Start a project of `kind`: the frame that runs it, its files, and the
// first shell. `id`: the stored project's, whose changes are kept (none
// for a temporary IEx).
export async function start(workspaceKind: WorkspaceKind, id: string | null): Promise<void> {
  kind = workspaceKind;
  projectId = id;
  // This page's project (it may have run another before).
  setPreviewKey();
  setWorkspace(local);
  setPreviewHost(preview);
  setup = setupOf(kind);
  const store = useStore.getState();
  if (!crossOriginIsolated) {
    store.failedToStart('This page needs cross-origin isolation (see playground/README.md).');
    return;
  }
  const origin = execOrigin(previewKey);
  if (!origin || !previewOrigins(previewKey)) {
    store.failedToStart(
      "This site names no usercontent domain (playground.json's usercontent; docs/frames.md).",
    );
    return;
  }
  // The tailnet, for this project as the user lets it (docs/tailscale.md).
  setTailnetProject(id ?? IEX);
  connectTailscale();
  store.setStatus('Starting the files…');
  try {
    exec = await startFrame(origin);
    listen(exec);
    let storePort: MessagePort | null = null;
    if (id) {
      const channel = new MessageChannel();
      serveStore(channel.port1, filesStore(id));
      storePort = channel.port2;
    }
    await exec.call<void>(
      'start',
      [
        {
          kind,
          key: previewKey,
          ide: apexOrigin(),
          // Paths: the frame takes them from its own origin.
          build: BUILD,
          runtime: RUNTIME,
          store: storePort,
        } satisfies ExecStart,
      ],
      storePort ? [storePort] : [],
    );
  } catch (error) {
    store.failedToStart((error as Error).message);
    return;
  }
  // A project from a link: its changes, before anything runs.
  const seed = id ? await takeSeed(id) : null;
  if (seed && id) {
    store.setStatus('Adding the shared files…');
    await exec.call('applyShared', [seed]);
    await seedTaken(id);
  }
  // The tree before start returns: a live session resumed next welcomes
  // its guests with it.
  await refreshTree();
  openTerminal(setup.first);
  const rpc = exec;
  // For tests and the curious.
  Object.assign(window, {
    playground: {
      database,
      files,
      sessions,
      get node() {
        return sessions.get(FIRST_SESSION)?.node;
      },
      get output() {
        return sessions.get(FIRST_SESSION)?.backlog ?? '';
      },
      bridge: {
        cookieHeader: (jar?: string) => rpc.call<string | null>('cookieHeader', [jar]),
        remember: (cookie: string) => rpc.call<string[]>('remember', [cookie]),
      },
      openTerminal,
      shareable,
      previewSnapshot,
      // For a bug hunt: what is under way between the page and its nodes
      // (see runtime/trace.ts for tracing it as it happens).
      debug: async () => ({
        ...(await rpc.call<object>('debug')),
        postgres: serveDatabase.debug(),
      }),
    },
  });
}
