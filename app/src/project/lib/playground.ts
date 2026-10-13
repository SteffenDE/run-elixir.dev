// A project's nodes: PGlite, the preview's service worker, the shared
// filesystem, and a shell per terminal tab, each a node in its own worker.
// The first runs what the project's kind starts with (the Phoenix server,
// IEx, or nothing); the others are for mix and friends beside it.
// Everything the UI does to the nodes goes through here.
import { PGlite } from '@electric-sql/pglite';
import { Files, Node } from '@runtime/host.js';
import { Bridge } from '@runtime/bridge.js';
import { postgres } from '@runtime/postgres.js';
import { built, filesChanged, tailwind } from '@/project/lib/programs/tailwind';
import { gitProgram } from '@/project/lib/programs/git';
import {
  previewChannel,
  previewKey,
  send,
  type PreviewMessage,
} from '@/project/lib/previewChannel';
import { HIDDEN, WORK, useStore } from '@/project/lib/store';
import { filesStore, pgliteDataDir } from '@/shared/lib/storage';
import { seedTaken, takeSeed } from '@/shared/lib/projects';
import { fileBytes, fileEntry, type Shared } from '@/shared/lib/share';
import type { Template } from '@/shared/lib/templates';
import { HEX_PORT, hex, hexEnv } from './hex';
import { serverCommand, setup as setupOf, type Setup, type WorkspaceKind } from './kinds';

type Output = (text: string) => void;

interface Session {
  id: number;
  node: Node;
  backlog: string;
  listeners: Set<Output>;
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
  const { tabs, replace } = useStore.getState();
  for (const tab of tabs) {
    if (!visible.includes(tab.path) || tab.draft !== tab.saved) continue;
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

function running(): Files {
  if (!files) throw new Error('the playground is not running');
  return files;
}

async function vacant(path: string): Promise<void> {
  if ((await stat(path)) !== null) throw new Error(`${path.slice(WORK.length + 1)} exists already`);
}

// The tree's file operations, on absolute paths below /work.
export async function createFile(path: string): Promise<void> {
  await vacant(path);
  await running().write(path, new Uint8Array(0));
  await openFile(path);
}

export async function createDirectory(path: string): Promise<void> {
  await vacant(path);
  await running().mkdir(path);
}

export async function movePath(from: string, to: string): Promise<void> {
  await vacant(to);
  await running().rename(from, to);
  useStore.getState().moved(from, to);
}

export async function removePath(path: string): Promise<void> {
  await running().remove(path);
  useStore.getState().removed(path);
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

// Show `path` (the app's) in the preview.
export function showInPreview(path: string): void {
  useStore.getState().navigate(path);
}

export async function save(path: string, text: string): Promise<void> {
  if (!files) return;
  await files.write(path, encoder.encode(text));
  useStore.getState().saved(path, text);
  filesChanged([path]);
  // Phoenix's code reloader compiles on the next request.
  if (useStore.getState().previewPort !== null) {
    if (reloading) clearTimeout(reloading);
    reloading = setTimeout(() => useStore.getState().reloadPreview(), 200);
  }
}

export function type(id: number, text: string): void {
  sessions.get(id)?.node.input(text);
}

export function interrupt(id: number): void {
  sessions.get(id)?.node.interrupt();
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

// The ports the nodes serve on, and the one the preview shows. Ephemeral
// listeners (Mix's compile lock) are no server.
function updateListening(): void {
  const ports = new Set<number>();
  for (const session of sessions.values()) for (const port of session.node.serving) ports.add(port);
  const sorted = [...ports].sort((a, b) => a - b);
  const port = ports.has(PREVIEW_PORT) ? PREVIEW_PORT : (sorted[0] ?? null);
  if (bridge && port !== null) bridge.port = port;
  if (port !== useStore.getState().previewPort) useStore.getState().setPreviewPort(port);
}

function database(): Promise<PGlite> {
  db ??= PGlite.create(projectId ? pgliteDataDir(projectId) : undefined);
  return db;
}

// A shell in a new terminal tab (the first runs `initial`).
export function openTerminal(initial: string[] = []): number {
  if (!files) return 0;
  const id = nextSession++;
  const session: Session = { id, node: null as unknown as Node, backlog: '', listeners: new Set() };
  session.node = new Node({
    base: '/',
    files,
    serve: { 5432: postgres(database), [HEX_PORT]: hex },
    // The Hex tailwind package's binary is this page's.
    programs: { tailwind, git: gitProgram },
    onoutput(bytes) {
      const text = decoder.decode(bytes, { stream: true });
      session.backlog = (session.backlog + text).slice(-200_000);
      for (const listener of session.listeners) listener(text);
    },
    onstatus(text) {
      if (id !== FIRST_SESSION) return;
      if (text === 'running') {
        useStore.getState().setStatus(setup.running);
        useStore.getState().setReady(true);
      } else useStore.getState().setStatus(text);
    },
    onlistening: updateListening,
  });
  sessions.set(id, session);
  session.node.start({ shell: true, initial, cwd: setup.cwd, boots: setup.boots, env: hexEnv });
  useStore.getState().addTerminal(id);
  return id;
}

export function closeTerminal(id: number): void {
  if (id === FIRST_SESSION) return;
  sessions.get(id)?.node.stop();
  sessions.delete(id);
  useStore.getState().removeTerminal(id);
  updateListening();
}

// A popped-out preview hears what the docked one would: reloads and new
// CSS. Its closing brings the panel back.
useStore.subscribe((state, before) => {
  if (state.previewKey !== before.previewKey) send({ type: 'reload' });
});
built.add(() => send({ type: 'css' }));
previewChannel.addEventListener('message', ({ data }: MessageEvent<PreviewMessage>) => {
  if (data.type === 'closed') useStore.getState().popOut(false);
  else if (data.type === 'opened') useStore.getState().popOut(true);
});

// Keep what changed and stop every node: the project runs elsewhere now.
export async function shutdown(): Promise<void> {
  await files?.flush().catch(() => {});
  for (const session of sessions.values()) session.node.stop();
  sessions.clear();
  files?.worker.terminate();
  files = null;
  const pglite = await db?.catch(() => null);
  await pglite?.close().catch(() => {});
  db = null;
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
    fetch('/fs/version').then((response) => response.text()),
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

// Start a project of `kind`: its files, the service worker, and the first
// shell. `id`: the stored project's, whose changes are kept (none for a
// temporary IEx).
export async function start(workspaceKind: WorkspaceKind, id: string | null): Promise<void> {
  kind = workspaceKind;
  projectId = id;
  setup = setupOf(kind);
  const store = useStore.getState();
  if (!crossOriginIsolated) {
    store.setStatus('This page needs cross-origin isolation (see playground/README.md).');
    return;
  }
  store.setStatus('Starting the files…');
  files = new Files({
    base: '/',
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
  bridge = new Bridge({ connect: (port: number) => nodeOn(port)!.connect(port) });
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
    },
  });
}
