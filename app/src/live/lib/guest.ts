// A live session's guest: the IDE over a project that runs in the host's
// page (docs/collaboration.md). The workspace here asks the host for what
// the local one would do itself; what the host sends (signed) keeps the
// tree, terminals, open files and people up to date.
import * as Y from 'yjs';
import { built } from '@/project/lib/programs/tailwind';
import { previewKey } from '@/project/lib/previewChannel';
import { useStore } from '@/project/lib/store';
import { Bridge, type Connection } from '@/runtime/bridge';
import type { SearchResult } from '@/runtime/host/files';
import { disposeTerminal } from '@/project/lib/terminal-handle';
import { setWorkspace, type Workspace } from '@/project/lib/workspace';
import type { WorkspaceKind } from '@/shared/lib/projects';
import type { Shared } from '@/shared/lib/share';
import { linkKeys, type LinkSecrets } from './crypto';
import { PROTOCOL, Peer, type Message, type Received } from './peer';
import { follow, startFollowing } from './follow';
import { setActiveSender, setCursorSender } from './presence';
import {
  REMOTE,
  addSharedFile,
  dropAllSharedFiles,
  dropSharedFile,
  moveSharedFiles,
  removeSharedFiles,
  sharedFile,
} from './shared-files';
import { useLive, type Cursor, type Permissions, type Person } from './store';

export interface GuestProject {
  kind: WorkspaceKind;
  name: string;
}

interface Terminal {
  backlog: string;
  listeners: Set<(text: string) => void>;
}

const decoder = new TextDecoder();

let peer: Peer | null = null;
let name = '';
let nextReq = 1;
const requests = new Map<number, { resolve(r: Received): void; reject(e: Error): void }>();
const terminals = new Map<number, Terminal>();
let cwd: string[] = ['/work'];
let onProject: ((project: GuestProject) => void) | null = null;
let welcomed = false;
// The preview: the app's requests go to this page's bridge (as in a
// project's page), whose connections go through the relay to the host's
// node. Its cookies, and its LiveView, are this guest's own.
let bridge: Bridge | null = null;
const tunnels = new Map<number, Connection>();
let nextConn = 1;

function connect(port: number): Connection {
  const conn = nextConn++;
  const stats: TunnelStats = { opened: Date.now(), sent: 0, received: 0, state: 'open' };
  tunnelStats.set(conn, stats);
  // Kept for a minute after it ends, for debug().
  const ended = (state: string) => {
    stats.state = state;
    setTimeout(() => tunnelStats.delete(conn), 60_000);
  };
  const connection: Connection = {
    ondata: () => {},
    onend: () => {},
    onclose: () => {},
    write: (bytes) => {
      stats.sent += bytes.length;
      void send({ t: 'tcp-data', conn }, bytes);
    },
    close: () => {
      if (tunnels.delete(conn)) {
        ended('closed by the page');
        void send({ t: 'tcp-close', conn });
      }
    },
  };
  const ondata = (bytes: Uint8Array) => {
    stats.received += bytes.length;
    connection.ondata(bytes);
  };
  tunnelHooks.set(conn, { ondata, ended });
  tunnels.set(conn, connection);
  void send({ t: 'tcp-open', conn, port });
  return connection;
}

// For a bug hunt, in the console: playgroundLive.debug().
interface TunnelStats {
  opened: number;
  sent: number;
  received: number;
  state: string;
}
const tunnelStats = new Map<number, TunnelStats>();

const debug = {
  playgroundLive: {
    debug: () => ({
      role: 'guest',
      me: peer?.id,
      host: peer?.host,
      status: useLive.getState().status,
      relay: peer?.relay.debug(),
      bridge: bridge?.debug(),
      tunnels: [...tunnelStats].map(([conn, s]) => ({
        conn,
        age: `${((Date.now() - s.opened) / 1000).toFixed(1)} s`,
        sent: s.sent,
        received: s.received,
        state: s.state,
      })),
    }),
  },
};

const tunnelHooks = new Map<
  number,
  { ondata(bytes: Uint8Array): void; ended(state: string): void }
>();

function closeTunnels() {
  for (const [conn, connection] of tunnels) {
    tunnelHooks.get(conn)?.ended('closed: the host or the relay went away');
    connection.onclose('close');
  }
  tunnels.clear();
  tunnelHooks.clear();
}

// The host's preview port, unless this guest switched to another (its
// path bar, a link to another endpoint).
let hostPort: number | null = null;
let chosenPort: number | null = null;

async function preview(port: number | null) {
  hostPort = port;
  if (!bridge) {
    await Bridge.register('/sw.js', '/', previewKey);
    bridge ??= new Bridge({ connect });
    bridge.onport = (switched) => {
      chosenPort = switched;
      void preview(hostPort);
    };
  }
  const shown = port === null ? null : (chosenPort ?? port);
  if (shown !== null) bridge.port = shown;
  useStore.getState().setPreviewPort(shown);
}

// Joins session `session` as `as`; `project` is called with what the host
// runs once it lets this guest in (and again after the host's reload).
export async function joinSession(
  session: string,
  secrets: LinkSecrets,
  as: string,
  project: (project: GuestProject) => void,
): Promise<void> {
  name = as;
  onProject = project;
  Object.assign(globalThis, debug);
  setWorkspace(remote);
  const keys = await linkKeys(secrets);
  useLive.getState().set({ role: 'guest', status: 'connecting', reason: null });
  peer = new Peer(session, 'guest', {}, keys, {
    joined(joined) {
      // Joined again (a lost connection): the host forgot this guest's
      // connections with its old id.
      closeTunnels();
      useLive.getState().set({
        me: joined.id,
        status: joined.admitted ? 'connecting' : 'waiting',
      });
      if (!joined.host_present) useLive.getState().set({ status: 'reconnecting' });
      void hello();
    },
    refused(reason) {
      useLive.getState().set({
        status: 'refused',
        reason:
          reason === 'no_session'
            ? 'This live session has ended, or the link is wrong.'
            : reason === 'full'
              ? 'This live session is full.'
              : `The relay would not let you in (${reason}).`,
      });
    },
    news,
    receive: (received) => {
      try {
        receive(received);
      } catch (error) {
        console.warn('live session:', error);
      }
    },
  });
  setCursorSender((cursor) => void peer?.send({ t: 'cursor', cursor }));
  setActiveSender((path) => void send({ t: 'active', path }));
}

export function leaveSession(): void {
  closeTunnels();
  setActiveSender(null);
  peer?.close();
  peer = null;
  setCursorSender(null);
}

const hello = () => send({ t: 'hello', name, protocol: PROTOCOL });

function send(message: Message, bytes: Uint8Array | null = null) {
  if (!peer?.host) return Promise.resolve();
  // Cursors go to everyone; the rest is for the host.
  // Cursors and the active file go to everyone; the rest is for the host.
  const everyone = message.t === 'cursor' || message.t === 'active';
  return peer.send(message, bytes, everyone ? null : peer.host);
}

function request(message: Message, bytes: Uint8Array | null = null): Promise<Received> {
  const req = nextReq++;
  return new Promise((resolve, reject) => {
    requests.set(req, { resolve, reject });
    void send({ ...message, req }, bytes);
    setTimeout(() => {
      if (requests.delete(req)) reject(new Error('The host did not answer.'));
    }, 60_000);
  });
}

function news(event: string, payload: Record<string, unknown>) {
  const live = useLive.getState();
  if (event === 'admitted' && payload.id === live.me) live.set({ status: 'connecting' });
  else if (event === 'host') {
    live.set({ status: payload.present ? 'live' : 'reconnecting' });
    // The host's page went away: what it was answering will not come.
    if (!payload.present) closeTunnels();
  } else if (event === 'left') {
    live.setCursor(payload.id as string, null);
    live.setActive(payload.id as string, null);
    if (live.following === payload.id) live.set({ following: null });
  } else if (event === 'kicked') end('refused', 'The host removed you from the session.');
  else if (event === 'ended') end('ended', 'The host ended the session.');
}

function end(status: 'ended' | 'refused', reason: string) {
  // The first reason stands (a guest turned away hears why, then is kicked).
  if (['ended', 'refused'].includes(useLive.getState().status)) return;
  useLive.getState().set({ status, reason, mine: { edit: false, terminal: false, fork: false } });
  useStore.getState().setAccess({ edit: false, terminal: false });
  leaveSession();
}

function setPermissions(perms: Permissions) {
  useLive.getState().set({ mine: perms });
  useStore.getState().setAccess({ edit: perms.edit, terminal: perms.terminal });
}

function terminal(term: number): Terminal {
  let found = terminals.get(term);
  if (!found) {
    found = {
      backlog: '',
      listeners: new Set(),
    };
    terminals.set(term, found);
  }
  return found;
}

function setTerminals(list: number[]) {
  const store = useStore.getState();
  for (const term of list) if (!store.terminals.includes(term)) store.addTerminal(term);
  for (const term of store.terminals)
    if (!list.includes(term)) {
      store.removeTerminal(term);
      terminals.delete(term);
    }
}

// A file's document, from the host's answer to `open`.
function adopt(path: string, update: Uint8Array, saved: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update, REMOTE);
  const file = addSharedFile(path, doc, saved);
  doc.on('update', (change: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) void send({ t: 'update', path: file.path }, change);
  });
  return file;
}

function receive({ from, message, bytes, signed }: Received) {
  const { t } = message;
  // Others' cursors need no signature: they say only where someone is.
  if (t === 'cursor') {
    useLive.getState().setCursor(from, (message.cursor as Cursor | null) ?? null);
    return;
  }
  if (t === 'active') {
    useLive.getState().setActive(from, typeof message.path === 'string' ? message.path : null);
    return;
  }
  if (!signed || from !== peer?.host) return;
  const store = useStore.getState();
  switch (t) {
    case 'outdated':
      end('refused', 'This page is older or newer than the host’s: reload it and join again.');
      return;
    case 'who':
      void hello();
      return;
    case 'welcome': {
      // The host's page (again, after its reload): everything anew.
      dropAllSharedFiles();
      for (const term of store.terminals) {
        store.removeTerminal(term);
        disposeTerminal(term);
      }
      terminals.clear();
      for (const term of message.terminals as number[]) terminal(term);
      cwd = message.cwd as string[];
      closeTunnels();
      store.setRemote(true);
      store.setReady(true);
      store.setStatus('');
      store.setPaths(message.paths as string[]);
      void preview((message.previewPort as number | null) ?? null);
      setPermissions(message.perms as Permissions);
      useLive.getState().set({
        status: 'live',
        // The IDE mounts afresh.
        generation: useLive.getState().generation + 1,
        people: message.people as Person[],
        cursors: (message.cursors as Record<string, Cursor>) ?? {},
        active: (message.active as Record<string, string | null>) ?? {},
      });
      onProject?.(message.project as GuestProject);
      setTerminals(message.terminals as number[]);
      // Open tabs come back from the host.
      for (const tab of store.tabs) void reopen(tab.path);
      // A new guest follows the host; one welcomed again goes on as it was.
      startFollowing();
      if (!welcomed) follow(peer.host);
      welcomed = true;
      return;
    }
    case 'people':
      useLive.getState().set({ people: message.people as Person[] });
      return;
    case 'perms':
      setPermissions(message.perms as Permissions);
      return;
    case 'tree':
      store.setPaths(message.paths as string[]);
      return;
    case 'terminals':
      setTerminals(message.terminals as number[]);
      return;
    case 'output': {
      const entry = terminal(message.term as number);
      const text = bytes ? decoder.decode(bytes) : '';
      entry.backlog = (entry.backlog + text).slice(-200_000);
      for (const listener of entry.listeners) listener(text);
      return;
    }
    case 'preview':
      void preview((message.port as number | null) ?? null);
      return;
    case 'reload':
      store.reloadPreview();
      return;
    case 'css':
      for (const listener of built) listener('');
      return;
    case 'tcp-data': {
      const hooks = tunnelHooks.get(message.conn as number);
      if (hooks && bytes) hooks.ondata(bytes);
      return;
    }
    case 'tcp-end': {
      const conn = message.conn as number;
      if (tunnelStats.get(conn)) tunnelStats.get(conn)!.state = 'ended by the host';
      tunnels.get(conn)?.onend();
      return;
    }
    case 'tcp-close': {
      const conn = message.conn as number;
      const connection = tunnels.get(conn);
      tunnels.delete(conn);
      tunnelHooks
        .get(conn)
        ?.ended(message.why === 'refused' ? 'refused by the host' : 'closed by the host');
      tunnelHooks.delete(conn);
      connection?.onclose(message.why === 'refused' ? 'refused' : 'close');
      return;
    }
    case 'update': {
      const file = sharedFile(message.path as string);
      if (file && bytes) Y.applyUpdate(file.doc, bytes, REMOTE);
      return;
    }
    case 'saved': {
      const path = message.path as string;
      const file = sharedFile(path);
      if (file) file.saved = message.text as string;
      store.saved(path, message.text as string);
      return;
    }
    case 'reset': {
      // Edits the host refused: the host's text, afresh.
      const path = message.path as string;
      if (!bytes) return;
      dropSharedFile(path);
      const file = adopt(path, bytes, message.saved as string);
      store.replace(path, file.text.toString());
      store.saved(path, file.saved);
      return;
    }
    case 'moved':
      moveSharedFiles(message.from as string, message.to as string);
      store.moved(message.from as string, message.to as string);
      return;
    case 'removed':
      removeSharedFiles(message.path as string);
      store.removed(message.path as string);
      return;
    case 'reply': {
      const pending = requests.get(message.req as number);
      if (!pending) return;
      requests.delete(message.req as number);
      if (message.ok) pending.resolve({ from, message, bytes, signed });
      else pending.reject(new Error(String(message.error)));
      return;
    }
  }
}

async function open(path: string) {
  const answer = await request({ t: 'open', path });
  const value = answer.message.value as { saved: string };
  return sharedFile(path) ?? adopt(path, answer.bytes ?? new Uint8Array(), value.saved);
}

async function reopen(path: string) {
  try {
    const file = await open(path);
    useStore.getState().replace(path, file.text.toString());
    useStore.getState().saved(path, file.saved);
  } catch {
    useStore.getState().close(path);
  }
}

// A copy of the project as it is in the session, as a link would hold it.
export async function fork(): Promise<Shared> {
  const answer = await request({ t: 'fork' });
  return answer.message.value as Shared;
}

export const remote: Workspace = {
  read: (path) => request({ t: 'read', path }).then((r) => r.bytes ?? new Uint8Array()),
  stat: (path) =>
    request({ t: 'stat', path }).then((r) => r.message.value as 'file' | 'dir' | null),
  search: (query) => request({ t: 'search', query }).then((r) => r.message.value as SearchResult),
  createFile: async (path) => {
    await request({ t: 'create', path, dir: false });
    await remote.openFile(path);
  },
  createDirectory: (path) => request({ t: 'create', path, dir: true }).then(() => {}),
  movePath: (from, to) => request({ t: 'move', from, to }).then(() => {}),
  removePath: (path) => request({ t: 'remove', path }).then(() => {}),
  openFile: async (path, line = 1) => {
    const file = await open(path);
    const store = useStore.getState();
    store.open(path, file.text.toString(), line);
    store.saved(path, file.saved);
    store.setFilesShown(true);
  },
  save: (path) => request({ t: 'save', path }).then(() => {}),
  searchPath: () => cwd,
  onOutput(id, listener) {
    const entry = terminal(id);
    if (entry.backlog) listener(entry.backlog);
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  },
  // To the host's line discipline, which echoes them to everyone.
  keys: (id, data) => {
    if (useLive.getState().mine.terminal) void send({ t: 'keys', term: id, data });
  },
  // The host's terminals keep the host's size.
  resize: () => {},
  openTerminal: () => void send({ t: 'open-terminal' }),
  closeTerminal: (id) => void send({ t: 'close-terminal', term: id }),
  restartServer: () => void send({ t: 'restart' }),
};
