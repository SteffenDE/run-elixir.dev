// A project's nodes: PGlite, the preview's service worker, the shared
// filesystem, and a shell per terminal tab, each a node in its own worker.
// The first runs what the project's kind starts with (the Phoenix server,
// IEx, or nothing); the others are for mix and friends beside it.
// Everything the UI does to the nodes goes through here.
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { hstore } from '@electric-sql/pglite/contrib/hstore';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { Files, type SearchQuery, type SearchResult } from '@/runtime/host/files';
import { Node, type Connection, type NifBuild } from '@/runtime/host/node';
import { lineDiscipline } from '@/runtime/terminal';
import { BUILD } from '@/shared/lib/build';
import { Bridge } from '@/runtime/bridge';
import { postgres } from '@/runtime/postgres';
import { httpsByFetch } from '@/runtime/https';
import { built, tailwind } from '@/project/lib/programs/tailwind';
import { bundled, esbuild } from '@/project/lib/programs/esbuild';
import { filesChanged } from '@/project/lib/programs/watch';
import { gitProgram } from '@/project/lib/programs/git';
import {
  commandProgram,
  rebar3Program,
  shProgram,
  type StartNode,
} from '@/project/lib/programs/node';
import {
  previewChannel,
  previewKey,
  send,
  type PreviewMessage,
} from '@/project/lib/previewChannel';
import { HIDDEN, WORK, useStore } from '@/project/lib/store';
import { filesStore, pgliteDataDir } from '@/shared/lib/storage';
import { seedTaken, takeSeed } from '@/shared/lib/registry';
import { fileBytes, fileEntry, type Shared } from '@/shared/lib/share';
import type { Template } from '@/shared/lib/templates';
import { setWorkspace, type Workspace } from './workspace';
import { HEX_PORT, hex, hexEnv } from './hex';
import { serverCommand, setup as setupOf, type Setup, type WorkspaceKind } from './kinds';

type Output = (text: string) => void;

interface Session {
  id: number;
  node: Node;
  backlog: string;
  listeners: Set<Output>;
  // Its tty's line discipline: everyone's keys, one line being typed, and
  // the command lines it ran first as if typed (the history).
  discipline: ReturnType<typeof lineDiscipline>;
}

const sessions = new Map<number, Session>();
let files: Files | null = null;
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
// The port the preview shows: Phoenix's, else the first one listened on.
const PREVIEW_PORT = 4000;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

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
  if (!files) return;
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

// What the nodes changed: the tree, open tabs without edits, and the
// watchers.
async function changed(paths: string[]): Promise<void> {
  filesChanged(paths);
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
  if (!files) return Promise.reject(new Error('the playground is not running'));
  return files.read(path);
}

export function stat(path: string): Promise<'file' | 'dir' | null> {
  return files ? files.stat(path) : Promise.resolve(null);
}

// What the project's files say: matches of `query` below /work, but in
// the directories the tree leaves out.
export function search(query: SearchQuery): Promise<SearchResult> {
  return running().search(WORK, query, HIDDEN);
}

function running(): Files {
  if (!files) throw new Error('the playground is not running');
  return files;
}

async function vacant(path: string): Promise<void> {
  if ((await stat(path)) !== null) throw new Error(`${path.slice(WORK.length + 1)} exists already`);
}

// The tree's file operations, on absolute paths below /work.
export async function createFile(path: string, open = true): Promise<void> {
  await vacant(path);
  await running().write(path, new Uint8Array(0));
  if (open) await openFile(path);
}

export async function createDirectory(path: string): Promise<void> {
  await vacant(path);
  await running().mkdir(path);
}

export async function movePath(from: string, to: string): Promise<void> {
  await vacant(to);
  await running().rename(from, to);
  useStore.getState().moved(from, to);
  live.moved?.(from, to);
}

export async function removePath(path: string): Promise<void> {
  await running().remove(path);
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
  if (!files) return;
  await files.write(path, encoder.encode(text));
  useStore.getState().saved(path, text);
  live.saved?.(path, text);
  filesChanged([path]);
  // Phoenix's code reloader compiles on the next request.
  if (useStore.getState().previewPort !== null) {
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
  sessions.get(id)?.node.resize(columns, rows);
}

// Stop whatever runs in the first shell, then start the Phoenix server
// again.
export function restartServer(): void {
  const node = sessions.get(FIRST_SESSION)?.node;
  if (!node || kind !== 'phoenix') return;
  node.interrupt();
  setTimeout(() => node.input(serverCommand(setup.cwd)), 300);
}

// Which node answers a port: the one listening on it.
function nodeOn(port: number): Node | null {
  for (const session of sessions.values())
    if (session.node.listening.has(port)) return session.node;
  return sessions.get(FIRST_SESSION)?.node ?? null;
}

let bridge: Bridge | null = null;

// A connection to a server a node runs on `port` (not its other
// listeners: Mix's locks, PGlite), for a live session's guest's preview.
export function connectServer(port: number): Connection | null {
  for (const session of sessions.values())
    if (session.node.serving.has(port)) return session.node.connect(port);
  return null;
}

// The port the preview was switched to (its path bar, a link to another
// endpoint), which it keeps while any server runs, also while that one
// restarts.
let chosenPort: number | null = null;

// The ports the nodes serve on, and the one the preview shows. Ephemeral
// listeners (Mix's compile lock) are no server.
function updateListening(): void {
  const ports = new Set<number>();
  for (const session of sessions.values()) for (const port of session.node.serving) ports.add(port);
  const sorted = [...ports].sort((a, b) => a - b);
  const port = !ports.size
    ? null
    : (chosenPort ?? (ports.has(PREVIEW_PORT) ? PREVIEW_PORT : sorted[0]));
  if (bridge && port !== null) bridge.port = port;
  if (port !== useStore.getState().previewPort) useStore.getState().setPreviewPort(port);
}

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

// What every node serves and runs on the page. The Hex tailwind and
// esbuild packages' binaries are this page's; sh and rebar3 start nodes of
// their own.
// Every node of the project (its shells and the commands they run). Each
// may connect to what the others listen on, as processes on one machine
// do: Mix's compile notices go so between a shell and the server, which
// reloads the modules another compiled.
const nodes = new Set<Node>();

function updatePeers(): void {
  for (const node of nodes)
    node.peers(
      [...nodes].filter((other) => other !== node).flatMap((other) => [...other.listening]),
    );
}

// A connection a node opened to another node's port: joined to one the
// page opens there.
function routePeer(connection: Connection, port: number): boolean {
  const target = [...nodes].find((node) => node !== connection.node && node.listening.has(port));
  if (!target) return false;
  const other = target.connect(port);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    connection.close();
    other.close();
  };
  connection.ondata = (bytes) => other.write(bytes);
  other.ondata = (bytes) => connection.write(bytes);
  connection.onend = () => other.end();
  other.onend = () => connection.end();
  connection.onclose = close;
  other.onclose = close;
  return true;
}

function nodeServices() {
  return {
    peer: routePeer,
    serve: { 5432: serveDatabase, [HEX_PORT]: hex },
    // make waiting for the backend to build a NIF library (NifBuildDialog).
    onnif: (build: NifBuild) => useStore.getState().setNifBuild(build),
    // The node's HTTPS (ssl to a host name), by the page's fetch().
    https: httpsByFetch(),
    programs: {
      tailwind,
      esbuild,
      git: gitProgram,
      sh: shProgram(startNode),
      rebar3: rebar3Program(startNode),
      ...Object.fromEntries(
        ['mix', 'elixir', 'iex', 'erl', 'escript'].map((name) => [
          name,
          commandProgram(startNode, name),
        ]),
      ),
    },
  };
}

// The nodes for commands nodes ran, and their command lines (for debug()).
const commands = new Map<Node, string>();

// A node for one command a node ran (sh, rebar3), in its own worker.
const startNode: StartNode = (command, { cwd, env }, output, exit) => {
  if (!files) {
    exit(1);
    return { stop() {} };
  }
  const node = new Node({
    base: BUILD,
    files,
    ...nodeServices(),
    onoutput: output,
    onexit(code) {
      nodes.delete(node);
      commands.delete(node);
      updatePeers();
      exit(code);
    },
    onstatus(text) {
      if (!text.startsWith('failed')) return;
      output(encoder.encode(`${command[0]}: ${text}\n`));
      exit(1);
    },
    onlistening: updatePeers,
  });
  nodes.add(node);
  commands.set(node, command.join(' '));
  updatePeers();
  // The port's directory, not the node's own (its PWD came with its env).
  node.start({ command, cwd, env: { ...env, PWD: cwd }, boots: setup.boots });
  return node;
};

// A shell in a new terminal tab (the first runs `initial`).
export function openTerminal(initial: string[] = []): number {
  if (!files) return 0;
  const id = nextSession++;
  const session: Session = {
    id,
    node: null as unknown as Node,
    backlog: '',
    listeners: new Set(),
    discipline: null as unknown as Session['discipline'],
  };
  const emit = (text: string) => {
    session.backlog = (session.backlog + text).slice(-200_000);
    for (const listener of session.listeners) listener(text);
  };
  session.discipline = lineDiscipline(
    emit,
    {
      input: (text) => session.node.input(text),
      interrupt: () => session.node.interrupt(),
    },
    initial,
  );
  session.node = new Node({
    base: BUILD,
    files,
    ...nodeServices(),
    onoutput(bytes) {
      emit(decoder.decode(bytes, { stream: true }));
    },
    onstatus(text) {
      if (id !== FIRST_SESSION) return;
      if (text === 'running') {
        useStore.getState().setStatus(setup.running);
        useStore.getState().setReady(true);
      } else if (text.startsWith('failed') && !useStore.getState().ready) {
        useStore.getState().failedToStart(text.replace(/^failed: /, ''));
      } else useStore.getState().setStatus(text);
    },
    onlistening() {
      updateListening();
      updatePeers();
    },
    onterminal(raw) {
      session.discipline.raw(raw);
    },
  });
  sessions.set(id, session);
  nodes.add(session.node);
  updatePeers();
  session.node.start({
    shell: true,
    initial,
    cwd: setup.cwd,
    boots: setup.boots,
    env: hexEnv,
  });
  useStore.getState().addTerminal(id);
  return id;
}

export function closeTerminal(id: number): void {
  if (id === FIRST_SESSION) return;
  const node = sessions.get(id)?.node;
  node?.stop();
  if (node) nodes.delete(node);
  sessions.delete(id);
  updatePeers();
  useStore.getState().removeTerminal(id);
  updateListening();
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
previewChannel.addEventListener('message', ({ data }: MessageEvent<PreviewMessage>) => {
  if (data.type === 'closed') useStore.getState().popOut(false);
  else if (data.type === 'opened') {
    useStore.getState().popOut(true);
    send({ type: 'port', port: useStore.getState().previewPort });
  }
});

// Keep what changed and stop every node: the project runs elsewhere now.
export async function shutdown(): Promise<void> {
  await files?.flush().catch(() => {});
  for (const session of sessions.values()) session.node.stop();
  nodes.clear();
  sessions.clear();
  files?.worker.terminate();
  files = null;
  const pglite = await db?.catch(() => null);
  await pglite?.close().catch(() => {});
  db = null;
  serveDatabase = postgres(database);
}

// A shared project's changes, over this project's template.
async function applyShared(shared: Shared): Promise<void> {
  const target = running();
  for (const path of shared.removed) await target.remove(`${WORK}/${path}`).catch(() => {});
  for (const [path, entry] of Object.entries(shared.files)) {
    const file = `${WORK}/${path}`;
    await target.mkdir(file.slice(0, file.lastIndexOf('/')));
    await target.write(file, fileBytes(entry));
  }
  await target.flush();
}

// What this project changed over its template, to share: its sources, not
// its builds, dependencies or database.
export async function shareable(name: string, template?: Template): Promise<Shared> {
  const [{ changed: written, removed }, site] = await Promise.all([
    running().changes(HIDDEN),
    fetch(`${BUILD}fs/version`).then((response) => response.text()),
  ]);
  const relative = (path: string) => path.slice(WORK.length + 1);
  return {
    v: 1,
    kind: kind === 'phoenix' ? 'phoenix' : 'empty',
    name,
    site: site.trim(),
    ...(template ? { template } : {}),
    files: Object.fromEntries(written.map(({ path, data }) => [relative(path), fileEntry(data)])),
    removed: removed.map(relative),
  };
}

// The IDE's workspace (workspace.ts): these nodes.
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

// Start a project of `kind`: its files, the service worker, and the first
// shell. `id`: the stored project's, whose changes are kept (none for a
// temporary IEx).
export async function start(workspaceKind: WorkspaceKind, id: string | null): Promise<void> {
  kind = workspaceKind;
  projectId = id;
  setWorkspace(local);
  setup = setupOf(kind);
  const store = useStore.getState();
  if (!crossOriginIsolated) {
    store.failedToStart('This page needs cross-origin isolation (see playground/README.md).');
    return;
  }
  store.setStatus('Starting the files…');
  files = new Files({
    base: BUILD,
    boots: setup.boots,
    template: setup.template,
    store: id ? filesStore(id) : null,
    onchange: (paths: string[]) => void changed(paths),
    onwarning: (message: string) => useStore.getState().setStatus(message),
  });
  await Promise.all([files.ready, Bridge.register('/sw.js', '/', previewKey)]);
  // A project from a link: its changes, before anything runs.
  const seed = id ? await takeSeed(id) : null;
  if (seed && id) {
    store.setStatus('Adding the shared files…');
    await applyShared(seed);
    await seedTaken(id);
  }
  void refreshTree();
  // The preview's requests go to whichever node listens on the port.
  bridge = new Bridge({
    connect: (port: number) => nodeOn(port)!.connect(port),
  });
  chosenPort = null;
  bridge.onport = (port) => {
    chosenPort = port;
    updateListening();
  };
  openTerminal(setup.first);
  // For tests and the curious.
  Object.assign(window, {
    playground: {
      database,
      bridge,
      files,
      sessions,
      get node() {
        return sessions.get(FIRST_SESSION)?.node;
      },
      get output() {
        return sessions.get(FIRST_SESSION)?.backlog ?? '';
      },
      openTerminal,
      shareable,
      // For a bug hunt: what is under way between the page and its nodes
      // (see runtime/trace.ts for tracing it as it happens).
      debug: () => ({
        bridge: bridge?.debug(),
        nodes: Object.fromEntries([...sessions].map(([id, s]) => [id, s.node.debug()])),
        commands: [...commands].map(([node, command]) => ({ command, ...node.debug() })),
      }),
    },
  });
}
