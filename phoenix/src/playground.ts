// The playground's nodes: PGlite, the preview's service worker, the shared
// filesystem, and a shell per terminal tab, each a node in its own worker.
// The first runs the Phoenix server; the others are for mix and friends
// while it runs. Everything the UI does to the nodes goes through here.
import { PGlite } from '@electric-sql/pglite';
import { Files, Node } from '../../runtime/host.js';
import { Bridge } from '../../runtime/bridge.js';
import { postgres } from '../../runtime/postgres.js';
import { built, filesChanged, tailwind } from './programs/tailwind';
import { previewChannel, send, type PreviewMessage } from './previewChannel';
import { HIDDEN, PROJECT, WORK, useStore } from './store';

type Output = (text: string) => void;

interface Session {
  id: number;
  node: Node;
  backlog: string;
  listeners: Set<Output>;
}

const sessions = new Map<number, Session>();
let files: Files | null = null;
let db: PGlite | null = null;
let nextSession = 1;
export const SERVER_SESSION = 1;
const SERVER_PORT = 4000;

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

export async function save(path: string, text: string): Promise<void> {
  if (!files) return;
  await files.write(path, encoder.encode(text));
  useStore.getState().saved(path, text);
  filesChanged([path]);
  // The code reloader compiles on the next request.
  if (path.startsWith(PROJECT)) {
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

const SERVER = 'iex -S mix phx.server';

// Stop whatever runs in the first shell, then start the server again.
export function restartServer(): void {
  const node = sessions.get(SERVER_SESSION)?.node;
  if (!node) return;
  node.interrupt();
  setTimeout(() => node.input(`cd ${PROJECT}\n${SERVER}\n`), 300);
}

// Which node answers a port: the one listening on it.
function nodeOn(port: number): Node | null {
  for (const session of sessions.values())
    if (session.node.listening.has(port)) return session.node;
  return sessions.get(SERVER_SESSION)?.node ?? null;
}

function updateServer(): void {
  const running = [...sessions.values()].some((s) => s.node.listening.has(SERVER_PORT));
  if (running !== useStore.getState().serverRunning) useStore.getState().setServerRunning(running);
}

// A shell in a new terminal tab (the first runs `initial`).
export function openTerminal(initial: string[] = []): number {
  if (!files || !db) return 0;
  const id = nextSession++;
  const session: Session = { id, node: null as unknown as Node, backlog: '', listeners: new Set() };
  session.node = new Node({
    base: './',
    files,
    serve: { 5432: postgres(db) },
    // The Hex tailwind package's binary is this page's.
    programs: { tailwind },
    onoutput(bytes) {
      const text = decoder.decode(bytes, { stream: true });
      session.backlog = (session.backlog + text).slice(-200_000);
      for (const listener of session.listeners) listener(text);
    },
    onstatus(text) {
      if (id !== SERVER_SESSION) return;
      if (text === 'running') {
        useStore.getState().setStatus('Phoenix 1.8 on Rust-OTP (WebAssembly), with PGlite');
        useStore.getState().setReady(true);
      } else useStore.getState().setStatus(text);
    },
    onlistening: updateServer,
  });
  sessions.set(id, session);
  session.node.start({ shell: true, initial, cwd: PROJECT });
  useStore.getState().addTerminal(id);
  return id;
}

export function closeTerminal(id: number): void {
  if (id === SERVER_SESSION) return;
  sessions.get(id)?.node.stop();
  sessions.delete(id);
  useStore.getState().removeTerminal(id);
  updateServer();
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

export async function start(): Promise<void> {
  const store = useStore.getState();
  if (!crossOriginIsolated) {
    store.setStatus('This page needs cross-origin isolation (see playground/README.md).');
    return;
  }
  store.setStatus('Starting the database and the files…');
  files = new Files({ base: './', onchange: (paths: string[]) => void changed(paths) });
  [db] = await Promise.all([PGlite.create(), files.ready, Bridge.register('sw.js')]);
  void refreshTree();
  // The preview's requests go to whichever node listens on the port.
  const bridge = new Bridge({ connect: (port: number) => nodeOn(port)!.connect(port) });
  openTerminal([`cd ${PROJECT}`, SERVER]);
  // For tests and the curious.
  Object.assign(window, {
    playground: {
      db,
      bridge,
      files,
      sessions,
      get node() {
        return sessions.get(SERVER_SESSION)?.node;
      },
      get output() {
        return sessions.get(SERVER_SESSION)?.backlog ?? '';
      },
      openTerminal,
    },
  });
}
