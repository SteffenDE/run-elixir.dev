// A project's page: what the IDE shows of the project, and the sandbox
// that runs it (create(), api/sandbox.ts; docs/frames.md). The nodes, the
// shared files and the page programs run in a worker of a frame on the
// usercontent domain (exec/host.ts), which the sandbox drives over a port;
// this page keeps what is the apex's: the project's stores (its files'
// changes, PGlite), Hex's cache, the terminals' screens, the tree and the
// tabs. Everything the UI does to the project goes through here: the
// API's calls, and the IDE's own over the sandbox's port (sandbox.exec).
import { Terminal } from '@xterm/xterm';
import { EditStateManager } from '@pierre/diffs/edit';
import type { ExecEvents } from '@/exec/host';
import type { Entry, SearchQuery, SearchResult } from '@/runtime/host/files';
import type { Connection, NifBuild } from '@/runtime/host/node';
import type { GitOptions, GitOutput } from '@/runtime/host/git';
import { open as openStore, serveStore, sharedRecords } from '@/runtime/overlay';
import { PortConnection } from '@/runtime/portConnection';
import { REPORT } from '@/runtime/terminal';
import { sitePackages } from '@/shared/lib/build';
import type { Rpc } from '@/shared/lib/rpc';
import { create, type Process, type Sandbox } from '@/api';
import { PGLITE_PLUGIN, pglite, type PgliteInstance } from '@/api/pglite';
import { tailscale } from '@/tailscale/plugin';
import { connectTailscale, IEX, setTailnetProject, tailscaleBlocked } from '@/tailscale/client';
import { relayWay, setRelayProject } from '@/relay/client';
import { relayed } from '@/runtime/relay';
import { previewOrigins, usercontentDomain } from '@/shared/lib/site';
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
import { baseline, clone } from '@/project/lib/git';
import { repositoryLabel } from '@/shared/lib/repository';
import { filesChanged as changesHeard, watchChanges } from '@/project/lib/review';
import { SHARED_STORE } from '@/shared/lib/storage';
import type { KeptRecord } from '@/runtime/overlay';
import { getProject, seedTaken, takeSeed, updateProject } from '@/shared/lib/projects';
import { applied, loadSettings, SETTINGS_CHANNEL, type Applied } from '@/shared/lib/settings';
import { guestMayType, useLive } from '@/live/lib/store';
import { askTrust } from './trust';
import type { Shared } from '@/shared/lib/share';
import type { Template } from '@/shared/lib/templates';
import { setWorkspace, type Workspace } from './workspace';
import { previewRelay } from './previewOrigins';
import { previewSnapshot } from './previewSnapshot';
import { setPreviewHost, type PreviewHost } from './previewHost';
import { setup as setupOf, type Setup, type WorkspaceKind } from './kinds';

type Output = (text: string) => void;

// A shell's node, as this page knows it: a sandbox's process on a terminal
// (exec/host.ts spawn), whose line discipline the exec frame keeps.
interface ShellNode {
  // Keys typed (a terminal's, its reports too), as they come.
  input(text: string): void;
  // Stops what runs now at once, the shell staying.
  terminate(): void;
  // The ports it serves on (a server's: not Mix's locks).
  serving: Set<number>;
}

interface Session {
  id: number;
  process: Process;
  node: ShellNode;
  backlog: string;
  listeners: Set<Output>;
  // Its screen, whether a terminal shows it or not: it answers the cursor
  // position the shell's line editor asks for, and is what the shell
  // looks like (the visible terminals only show it; they do not answer).
  screen: Terminal;
  decoder: TextDecoder;
}

const sessions = new Map<number, Session>();
let sandbox: Sandbox | null = null;
// The sandbox's port: the IDE's own calls (git, search, its changes).
let exec: Rpc | null = null;
let setup: Setup = setupOf('empty');
let kind: WorkspaceKind = 'empty';
// The stored project's id (null for a temporary IEx).
let projectId: string | null = null;
// The user's settings as this project takes them (settings.ts): what each
// new shell starts with.
let settings: Applied = { env: {}, shared: false, setup: null, startup: [] };
// Where the setup script goes for its one run (sourced in the first shell).
const SETUP_SCRIPT = '/tmp/playground-setup.sh';
// The other projects open in this browser, which hear what this one kept
// in /shared and tell it what they kept.
let sharedPeers: BroadcastChannel | null = null;
// The first shell is the sandbox's first process.
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

// git for the IDE itself (runtime/git.ts): a command's status and output,
// one command at a time.
export const git = (args: string[], options: GitOptions = {}) =>
  running().call<GitOutput>('git', [args, options]);

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
  const rpc = exec;
  if (!rpc) return;
  const entries = await rpc.call<Entry[]>('list', [WORK, HIDDEN]).catch((error) => {
    if (exec !== rpc) return [];
    throw error;
  });
  if (exec !== rpc) return;
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
// The changes view's watch (review.ts), while the project runs here.
let unwatchChanges = () => {};

// What the nodes changed: the tree, and open tabs without edits.
async function changed(paths: string[]): Promise<void> {
  // The changes view hears of .git's too (a commit at the shell).
  changesHeard(paths);
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

// Relative paths printed by a command may start at /work or in one of
// its project folders. Discover those from the tree, without a preset cwd.
export function searchPath(): string[] {
  const folders = useStore
    .getState()
    .paths.filter((path) => path.includes('/'))
    .map((path) => `${WORK}/${path.split('/')[0]}`);
  return [WORK, ...new Set(folders)];
}

export async function save(path: string, text: string): Promise<void> {
  if (!exec) return;
  await files.write(path, encoder.encode(text));
  useStore.getState().saved(path, text);
  live.saved?.(path, text);
  // The nodes' watchers hear of it: Phoenix's live reload (inotifywait),
  // Tailwind's and esbuild's, a Node.js server's (Vite's).
  void exec.call('saved', [path]);
}

// Keys typed into shell `id`'s terminal, here or by a live session's guest.
export function keys(id: number, data: string): void {
  sessions.get(id)?.node.input(data);
}

// The size of shell `id`'s terminal, for the node's line editing.
export function resize(id: number, columns: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) return;
  session.process.resize(columns, rows);
  session.screen.resize(columns, rows);
}

// Stop whatever runs in the first shell, then run its saved startup
// commands from the same directory as a new shell.
export function restartServer(): void {
  const node = sessions.get(FIRST_SESSION)?.node;
  const commands = settings.startup;
  const rpc = exec;
  if (!node) return;
  node.terminate();
  setTimeout(() => {
    if (exec === rpc) node.input(`cd ${WORK}\n${commands.join('\n')}\n`);
  }, 300);
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
// Its relay is made through the exec frame's port, which is there before
// create() returns (the preview may ask first, after a reload).
const serveRelay = (requests: MessagePort) =>
  void exec?.call('relay', [requests], [requests]).catch(() => requests.close());
const preview: PreviewHost = {
  ready: (port) => previewRelay(previewKey, port, serveRelay),
  shows: (port) => void exec?.call('previewShows', [port]),
};

// A shell in a new terminal tab (the first runs `initial`).
export function openTerminal(initial: string[] = []): number {
  if (!sandbox) return 0;
  const screen = new Terminal({ cols: 80, rows: 24, convertEol: true, scrollback: 5000 });
  // None of the user's settings while a live session's guest may type, at
  // the host's choice.
  const env = useLive.getState().settingsOff && guestMayType() ? {} : settings.env;
  const process = sandbox.terminal({
    cols: screen.cols,
    rows: screen.rows,
    initial,
    cwd: WORK,
    env,
  });
  const id = process.id;
  const session: Session = {
    id,
    process,
    node: {
      input: (text) => process.write(text),
      terminate: () => process.stopForeground(),
      serving: new Set(),
    },
    backlog: '',
    listeners: new Set(),
    screen,
    decoder: new TextDecoder(),
  };
  // The screen answers the shell's line editor's questions (the cursor's
  // position); the frame passes them on as they are.
  screen.onData((data) => {
    if (REPORT.test(data)) session.node.input(data);
  });
  sessions.set(id, session);
  process.onStdout((bytes) => {
    if (sessions.get(id) === session)
      emit(session, session.decoder.decode(bytes, { stream: true }));
  });
  if (id === FIRST_SESSION) process.onStatus(firstStatus);
  useStore.getState().addTerminal(id);
  return id;
}

// The first shell's status: the project's.
function firstStatus(text: string): void {
  const store = useStore.getState();
  if (text === 'running') {
    store.setStatus(setup.running);
    store.setReady(true);
  } else if (text.startsWith('failed') && !store.ready) {
    store.failedToStart(text.replace(/^failed: /, ''));
  } else store.setStatus(text);
}

function emit(session: Session, text: string): void {
  session.backlog = (session.backlog + text).slice(-200_000);
  session.screen.write(text);
  for (const listener of session.listeners) listener(text);
}

export function closeTerminal(id: number): void {
  if (id === FIRST_SESSION) return;
  const session = sessions.get(id);
  session?.screen.dispose();
  sessions.delete(id);
  session?.process.kill('SIGKILL');
  useStore.getState().removeTerminal(id);
}

// What the frame tells beyond the sandbox's processes: the ports served
// (and by which shell), the files the nodes changed, NIF builds, and what
// a node could not reach without Tailscale. The sandbox makes the
// preview's relays.
function listen(rpc: Rpc): void {
  const on = <K extends keyof ExecEvents>(event: K, listener: (data: ExecEvents[K]) => void) =>
    rpc.on<ExecEvents[K]>(event, (data) => {
      if (exec === rpc) listener(data);
    });
  on('serving', ({ ports, port, byProcess, scripts }) => {
    scriptPorts = new Set(scripts);
    for (const [id, served] of Object.entries(byProcess)) {
      const session = sessions.get(Number(id));
      if (session) session.node.serving = new Set(served);
    }
    const store = useStore.getState();
    if (ports.join() !== store.serving.join()) store.setServing(ports);
    if (port !== store.previewPort) store.setPreviewPort(port);
  });
  on('changed', (paths) => void changed(paths));
  on('warning', (message) => useStore.getState().setStatus(message));
  on('nif', (build: NifBuild) => useStore.getState().setNifBuild(build));
  // Not for the relay's hosts: the project already chose how (RelayDialog).
  on('blocked', (what: string) => {
    const host = URL.canParse(what) ? new URL(what).hostname : '';
    if (!relayed(host, 443)) tailscaleBlocked(what);
  });
}

// Unsaved edits: the browser asks before the page goes.
const unsaved = (event: BeforeUnloadEvent) => event.preventDefault();
useStore.subscribe((state, before) => {
  if (state.tabs === before.tabs) return;
  const was = before.tabs.some((tab) => tab.draft !== tab.saved);
  const is = state.tabs.some((tab) => tab.draft !== tab.saved);
  if (is && !was) addEventListener('beforeunload', unsaved);
  else if (was && !is) removeEventListener('beforeunload', unsaved);
});

// A popped-out preview hears which port to show. Its closing brings the
// panel back.
useStore.subscribe((state, before) => {
  if (state.previewPort !== before.previewPort) send({ type: 'port', port: state.previewPort });
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
let startup: AbortController | null = null;
// Whether the page has started its project (it shows it again, running).
export const hasBegun = (): boolean => begun;
export function beginStart(): boolean {
  if (begun) return false;
  begun = true;
  return true;
}

// Whether /shared holds anything (a file, a folder, a link).
async function sharedHolds(): Promise<boolean> {
  try {
    const store = await openStore(SHARED_STORE);
    try {
      const counting = store.transaction('files').objectStore('files').count();
      return await new Promise<boolean>((resolve) => {
        counting.onsuccess = () => resolve(counting.result > 0);
        counting.onerror = () => resolve(false);
      });
    } finally {
      store.close();
    }
  } catch {
    return false;
  }
}

// The settings changed (the settings page, the project's): new shells
// start with them; startup lines also apply to the start/restart action.
// /shared and trust apply at the next project start.
export async function refreshSettings(): Promise<void> {
  const id = projectId;
  const rpc = exec;
  const project = id ? await getProject(id) : null;
  const next = applied(await loadSettings(), project);
  if (projectId !== id || exec !== rpc) return;
  settings = { ...settings, env: next.env, startup: next.startup };
}
new BroadcastChannel(SETTINGS_CHANNEL).onmessage = () => {
  if (exec) void refreshSettings();
};

// /shared hidden while a live session's guest who may type is in, at the
// host's choice (live/lib/store.ts settingsOff); back once none is.
let sharedHidden = false;
useLive.subscribe(() => {
  const hide = settings.shared && useLive.getState().settingsOff && guestMayType();
  if (hide === sharedHidden || !exec) return;
  sharedHidden = hide;
  void exec.call('hideShared', [hide]).catch(() => {});
});

// Broadcast saved /shared changes to other open projects and apply their
// updates locally. Subscribe before file initialization and queue incoming
// updates until initialization completes, so changes saved during startup
// are not missed. The originating project persists each change.
function shareWithPeers(rpc: Rpc): () => void {
  sharedPeers?.close();
  const peers = new BroadcastChannel('playground-shared');
  sharedPeers = peers;
  let early: KeptRecord[][] | null = [];
  const apply = (records: KeptRecord[]) => {
    if (exec === rpc) void rpc.call('applyKept', [records]).catch(() => {});
  };
  rpc.on<unknown>('kept', (records) => {
    if (sharedRecords(records)) peers.postMessage(records);
  });
  peers.onmessage = ({ data }: MessageEvent<KeptRecord[]>) => {
    if (!sharedRecords(data)) return;
    if (early) early.push(data);
    else apply(data);
  };
  return () => {
    for (const records of early ?? []) apply(records);
    early = null;
  };
}

// Keep what changed and stop every node: the project runs elsewhere now.
export async function shutdown(): Promise<void> {
  startup?.abort();
  startup = null;
  const stopping = sandbox;
  sandbox = null;
  exec = null;
  if (refreshing) clearTimeout(refreshing);
  refreshing = null;
  unwatchChanges();
  unwatchChanges = () => {};
  sharedHidden = false;
  sharedPeers?.close();
  sharedPeers = null;
  setTailnetProject(null);
  setRelayProject(null);
  for (const session of sessions.values()) session.screen.dispose();
  sessions.clear();
  scriptPorts = new Set();
  await stopping?.shutdown();
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
  // The editor's sessions of the tabs that closed (Tab.id names them).
  EditStateManager.clearAll();
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

// Start a project of `kind`: the sandbox that runs it, its files, and the
// first shell. `id`: the stored project's, whose changes are kept (none
// for a temporary IEx). False if startup was cancelled or failed.
export async function start(workspaceKind: WorkspaceKind, id: string | null): Promise<boolean> {
  startup = new AbortController();
  const { signal } = startup;
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
    return false;
  }
  const usercontent = usercontentDomain();
  if (!usercontent || !previewOrigins(previewKey)) {
    store.failedToStart(
      "This site names no usercontent domain (playground.json's usercontent; docs/frames.md).",
    );
    return false;
  }
  // The tailnet and the relay, for this project as the user lets it
  // (docs/tailscale.md, docs/relay.md).
  setTailnetProject(id ?? IEX);
  setRelayProject(id ?? IEX);
  connectTailscale();
  store.setStatus('Starting the files…');
  // The user's settings, as this project takes them (settings.ts): one
  // from a link or a fork asks first, once.
  const project = id ? await getProject(id) : null;
  if (signal.aborted) return false;
  const user = await loadSettings();
  if (signal.aborted) return false;
  // Only what there is to give: /shared if it holds anything.
  const shares = user.shared && (await sharedHolds());
  if (signal.aborted) return false;
  const any = Object.keys(user.env).length > 0 || shares || user.setup.trim() !== '';
  if (project?.origin && project.trust === undefined && any) {
    store.setStatus('Waiting for your answer…');
    project.trust = await askTrust(
      {
        name: project.name,
        env: Object.keys(user.env),
        shared: shares,
        setup: user.setup,
      },
      signal,
    );
    if (signal.aborted) return false;
    await updateProject(project.id, { trust: project.trust });
    if (signal.aborted) return false;
  }
  settings = applied(user, project);
  try {
    // The site's packages (the template among them, as for every project:
    // the layers' versions are what kept projects were made over), and the
    // plugins of the playground's own: Postgres, the tailnet.
    const { packages, boot } = await sitePackages();
    if (signal.aborted) return false;
    const template =
      kind === 'phoenix'
        ? packages.find(({ playground }) => playground.template?.kind === 'phoenix')
        : undefined;
    let sharedPort: MessagePort | null = null;
    let sharing = () => {};
    let share: ((rpc: Rpc) => () => void) | null = null;
    if (settings.shared) {
      const channel = new MessageChannel();
      serveStore(channel.port1, SHARED_STORE);
      sharedPort = channel.port2;
      share = shareWithPeers;
    }
    const started = await create({
      plugins: [packages, pglite(), tailscale],
      project: { id: previewKey, persist: id !== null, template: template ?? 'empty' },
      boot,
      // The tailnet and the relay as the user lets this project use them
      // (relay/client.ts, docs/relay.md).
      relay: relayWay,
      usercontent,
      kind,
      shared: sharedPort,
      signal,
      // Before the files start: this page hears what they tell from the
      // first, and /shared's peers' changes wait for them.
      connected: (rpc) => {
        exec = rpc;
        listen(rpc);
        if (share) sharing = share(rpc);
      },
    }).catch((error: unknown) => {
      if (signal.aborted) return null;
      throw error;
    });
    if (!started || signal.aborted) {
      void started?.shutdown();
      return false;
    }
    sandbox = started;
    const rpc = started.exec;
    const postgres = () => started.instances.get(PGLITE_PLUGIN) as PgliteInstance;
    sharing();
    // A repository from the start (docs/git.md): the files as they came
    // are its baseline. A template's are, before a link's changes go over
    // them; an imported folder's (a link's over the empty template) are,
    // once they are there.
    const repository = async () => {
      if (!id) return;
      await baseline(git, files.stat, (path) => files.list(path)).catch((error) =>
        console.warn('playground: no baseline commit', error),
      );
    };
    await repository();
    if (signal.aborted) return false;
    // A project from a link: its changes, before anything runs. One from a
    // repository: its clone, into the empty /work (kept for the next start
    // if it fails: the error shows, and the project stays empty).
    const seed = id ? await takeSeed(id) : null;
    if (signal.aborted) return false;
    if (seed?.shared && id) {
      store.setStatus('Adding the shared files…');
      await rpc.call('applyShared', [seed.shared]);
      if (signal.aborted) return false;
      await seedTaken(id);
      if (signal.aborted) return false;
      await repository();
      if (signal.aborted) return false;
    } else if (seed?.clone && id) {
      store.setStatus(`Cloning ${repositoryLabel(seed.clone)}…`);
      await clone(git, seed.clone);
      if (signal.aborted) return false;
      await seedTaken(id);
      if (signal.aborted) return false;
    }
    // The tree before start returns: a live session resumed next welcomes
    // its guests with it.
    await refreshTree();
    if (signal.aborted) return false;
    // The project's saved startup lines, after its one-time setup script.
    // A temporary IEx has no stored project settings.
    let first = kind === 'iex' ? ['iex'] : settings.startup;
    if (settings.setup !== null && id) {
      const script = settings.setup.endsWith('\n') ? settings.setup : `${settings.setup}\n`;
      await rpc.call('write', [SETUP_SCRIPT, script]);
      if (signal.aborted) return false;
      first = [`source ${SETUP_SCRIPT}`, ...first];
    }
    if (project?.setUp === false && id) {
      await updateProject(id, { setUp: true });
      if (signal.aborted) return false;
    }
    openTerminal(first);
    if (id) unwatchChanges = watchChanges(git, files.stat);
    // For tests and the curious.
    Object.assign(window, {
      playground: {
        database: () => postgres().database(),
        files,
        git,
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
        // Keys typed into a shell's terminal (its line discipline's).
        keys,
        shareable,
        previewSnapshot,
        // For a bug hunt: what is under way between the page and its nodes
        // (see runtime/trace.ts for tracing it as it happens).
        debug: async () => ({
          ...(await rpc.call<object>('debug')),
          postgres: postgres().debug(),
        }),
      },
    });
    return true;
  } catch (error) {
    if (!signal.aborted) store.failedToStart((error as Error).message);
    return false;
  }
}
