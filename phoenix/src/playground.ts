// The playground's node: PGlite, the preview's service worker, and a shell
// that runs the Phoenix server. Everything the UI does to the node goes
// through here.
import { PGlite } from '@electric-sql/pglite';
import { Node } from '../../runtime/host.js';
import { Bridge } from '../../runtime/bridge.js';
import { postgres } from '../../runtime/postgres.js';
import { HIDDEN, PROJECT, WORK, useStore } from './store';

type Output = (text: string) => void;
const listeners = new Set<Output>();
let backlog = '';
let node: Node | null = null;

// The terminal's output; what came before it subscribed is replayed.
export function onOutput(listener: Output): () => void {
  if (backlog) listener(backlog);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNode(): Node | null {
  return node;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();
let output = '';

function hidden(path: string): boolean {
  return path.split('/').some((part) => HIDDEN.includes(part));
}

// The tree's paths, from the node.
export async function refreshTree(): Promise<void> {
  if (!node) return;
  const entries = await node.fs.list(WORK, HIDDEN);
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

// What the node changed: the tree, open tabs without edits, and the preview
// once the server serves the change.
async function changed(paths: string[]): Promise<void> {
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
  if (!node) return Promise.reject(new Error('the node is not running'));
  return node.fs.read(path);
}

export async function save(path: string, text: string): Promise<void> {
  if (!node) return;
  await node.fs.write(path, encoder.encode(text));
  useStore.getState().saved(path, text);
  // The code reloader compiles on the next request.
  if (path.startsWith(PROJECT)) {
    if (reloading) clearTimeout(reloading);
    reloading = setTimeout(() => useStore.getState().reloadPreview(), 200);
  }
}

export function type(text: string): void {
  node?.input(text);
}

export function interrupt(): void {
  node?.interrupt();
}

const SERVER = 'iex -S mix phx.server';

// Stop whatever runs in the shell, then start the server again.
export function restartServer(): void {
  if (!node) return;
  if (useStore.getState().serverRunning) node.interrupt();
  setTimeout(() => node?.input(`cd ${PROJECT}\n${SERVER}\n`), 300);
}

export async function start(): Promise<void> {
  const store = useStore.getState();
  if (!crossOriginIsolated) {
    store.setStatus('This page needs cross-origin isolation (see playground/README.md).');
    return;
  }
  store.setStatus('Starting the database…');
  const db = await PGlite.create();
  await Bridge.register('sw.js');
  node = new Node({
    base: './',
    serve: { 5432: postgres(db) },
    onoutput(bytes) {
      const text = decoder.decode(bytes, { stream: true });
      backlog = (backlog + text).slice(-200_000);
      output = (output + text).slice(-4000);
      for (const listener of listeners) listener(text);
      const running = /Running PlaygroundWeb\.Endpoint/.test(output);
      const prompt = /\$ $/.test(output);
      if (running && !useStore.getState().serverRunning) {
        output = '';
        useStore.getState().setServerRunning(true);
        useStore.getState().reloadPreview();
      } else if (prompt && useStore.getState().serverRunning) {
        useStore.getState().setServerRunning(false);
      }
    },
    onstatus(text) {
      if (text === 'running') {
        useStore.getState().setStatus('Phoenix 1.8 on Rust-OTP (WebAssembly), with PGlite');
        useStore.getState().setReady(true);
        void refreshTree();
      } else useStore.getState().setStatus(text);
    },
    onchange: (paths) => void changed(paths),
  });
  const bridge = new Bridge(node);
  // For tests and the curious.
  Object.assign(window, {
    playground: {
      node,
      db,
      bridge,
      get output() {
        return backlog;
      },
    },
  });
  node.start({ shell: true, initial: [`cd ${PROJECT}`, SERVER] });
}
